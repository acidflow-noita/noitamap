import type { NativeSceneSource } from '../../composition/prepare-scenes';
import type { StaticMask } from '../../composition/types';

export interface StaticMaskBits {
  readonly width: number;
  readonly height: number;
  /** Original authored ownership, LSB first. Treat both arrays as immutable. */
  readonly bits: Uint8Array;
  readonly airBits: Uint8Array;
}

function dimensions(width: number, height: number): number {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || !Number.isSafeInteger(pixels * 4))
    throw new RangeError('Invalid static-mask dimensions');
  return pixels;
}

/** Bounded, reusable ORIGINAL asset bits, never seed-specific masks or pages.
 * Include the immutable asset revision in sourceKey. Dimensions are also part
 * of the key and are checked against the loaded original source. In-flight
 * callers share one load; oversized entries are returned without retention. */
export function createStaticMaskSourceCache({ maxBytes = 16 * 1024 * 1024 }: { maxBytes?: number } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('Invalid static-mask cache budget');
  const cache = new Map<string, StaticMaskBits>();
  const pending = new Map<string, Promise<StaticMaskBits>>();
  let residentBytes = 0, epoch = 0;
  const stats = { hits: 0, misses: 0, sharedLoads: 0, loads: 0, evictions: 0, peakBytes: 0, loadMs: 0, buildMs: 0 };
  const size = (entry: StaticMaskBits) => entry.bits.byteLength + entry.airBits.byteLength;
  return {
    maxBytes, stats,
    get residentBytes() { return residentBytes; },
    get entries() { return cache.size; },
    get pending() { return pending.size; },
    get(sourceKey: string, width: number, height: number, load: () => Promise<NativeSceneSource>): Promise<StaticMaskBits> {
      const pixels = dimensions(width, height);
      if (typeof sourceKey !== 'string' || !sourceKey || typeof load !== 'function')
        throw new TypeError('An immutable static-mask source key and loader are required');
      const key = JSON.stringify([sourceKey, width, height]);
      const ready = cache.get(key);
      if (ready) {
        cache.delete(key); cache.set(key, ready); stats.hits++;
        return Promise.resolve(ready);
      }
      const active = pending.get(key);
      if (active) { stats.sharedLoads++; return active; }
      stats.misses++;
      const generation = epoch;
      const work = Promise.resolve().then(async () => {
        let start = performance.now();
        const source = await load();
        stats.loadMs += performance.now() - start; stats.loads++;
        if (source.width !== width || source.height !== height ||
            !(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) ||
            source.data.length !== pixels * 4)
          throw new Error(`Static-mask source dimensions/data changed: ${sourceKey}`);
        start = performance.now();
        const bits = new Uint8Array(Math.ceil(pixels / 8)), airBits = new Uint8Array(bits.length);
        const data = source.data;
        // Same predicate as staticSceneBits, with ordinary/force-air extracted
        // in one pass through the original authored instructions.
        for (let p = 0, i = 0; p < pixels; p++, i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (!data[i + 3] || !(r || g || b)) continue;
          const target = r === 0 && g === 0 && b === 66 ? airBits : bits;
          target[Math.floor(p / 8)] |= 1 << (p & 7);
        }
        stats.buildMs += performance.now() - start;
        const entry: StaticMaskBits = { width, height, bits, airBits }, length = size(entry);
        if (generation === epoch && length <= maxBytes) {
          while (residentBytes + length > maxBytes && cache.size) {
            const oldest = cache.keys().next().value!;
            residentBytes -= size(cache.get(oldest)!); cache.delete(oldest); stats.evictions++;
          }
          cache.set(key, entry); residentBytes += length;
          stats.peakBytes = Math.max(stats.peakBytes, residentBytes);
        }
        return entry;
      }).finally(() => { if (pending.get(key) === work) pending.delete(key); });
      pending.set(key, work);
      return work;
    },
    /** Existing callers still receive their result, but old pending loads
     * cannot repopulate the cache after a clear/revision transition. */
    clear() { epoch++; cache.clear(); pending.clear(); residentBytes = 0; },
  };
}

export interface StaticMaskTarget {
  x: number;
  y: number;
  width: number;
  height: number;
  ordinaryMask: Uint8Array;
  airMask: Uint8Array;
}

function validRect(rect: { x: number; y: number; width: number; height: number }): number {
  const pixels = dimensions(rect.width, rect.height);
  if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) ||
      !Number.isSafeInteger(rect.x + rect.width) || !Number.isSafeInteger(rect.y + rect.height))
    throw new RangeError('Invalid static-mask coordinates');
  return Math.ceil(pixels / 8);
}
function validBits(bits: Uint8Array, bytes: number) {
  if (!(bits instanceof Uint8Array) || bits.length !== bytes)
    throw new RangeError('Static-mask bit length does not match dimensions');
}
function overlaps(a: Uint8Array, b: Uint8Array) {
  return a.buffer === b.buffer && a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength;
}
function smallBits(source: Uint8Array, position: number, count: number): number {
  const byte = Math.floor(position / 8), shift = position & 7;
  const value = (source[byte] >>> shift) |
    (shift + count > 8 ? source[byte + 1] << (8 - shift) : 0);
  return value & ((1 << count) - 1);
}

/** Clipped OR of two LSB-first streams. Handles arbitrary source/destination
 * row widths and byte offsets. Prefix/suffix writes retain surrounding bits;
 * the interior uses 32-bit spans, not a loop per pixel. Returns clipped pixels.
 * Source arrays must remain immutable and must not overlap either target. */
export function blitStaticMaskOr(target: StaticMaskTarget, mask: StaticMask): number {
  const targetBytes = validRect(target), sourceBytes = validRect(mask);
  validBits(target.ordinaryMask, targetBytes); validBits(target.airMask, targetBytes);
  validBits(mask.bits, sourceBytes); if (mask.airBits) validBits(mask.airBits, sourceBytes);
  const ordinary = target.ordinaryMask, air = target.airMask, source = mask.bits, sourceAir = mask.airBits;
  if (overlaps(ordinary, air) || overlaps(ordinary, source) || overlaps(air, source) ||
      (sourceAir && (overlaps(ordinary, sourceAir) || overlaps(air, sourceAir))))
    throw new Error('Static-mask source and destination bit arrays must not overlap');
  const left = Math.max(target.x, mask.x), top = Math.max(target.y, mask.y);
  const right = Math.min(target.x + target.width, mask.x + mask.width);
  const bottom = Math.min(target.y + target.height, mask.y + mask.height);
  if (left >= right || top >= bottom) return 0;
  const width = right - left, rows = bottom - top;
  const outView = new DataView(ordinary.buffer, ordinary.byteOffset, ordinary.byteLength);
  const airView = new DataView(air.buffer, air.byteOffset, air.byteLength);
  const inView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const inAirView = sourceAir ? new DataView(sourceAir.buffer, sourceAir.byteOffset, sourceAir.byteLength) : null;
  let sourceRow = (top - mask.y) * mask.width + (left - mask.x);
  let targetRow = (top - target.y) * target.width + (left - target.x);
  for (let row = 0; row < rows; row++, sourceRow += mask.width, targetRow += target.width) {
    let s = sourceRow, d = targetRow, remaining = width;
    // Align the destination to a BYTE; DataView handles arbitrary alignment
    // of its following 32-bit stores, including sliced Uint8Array buffers.
    if (d & 7) {
      const count = Math.min(8 - (d & 7), remaining), byte = Math.floor(d / 8), shift = d & 7;
      ordinary[byte] |= smallBits(source, s, count) << shift;
      if (sourceAir) air[byte] |= smallBits(sourceAir, s, count) << shift;
      s += count; d += count; remaining -= count;
    }
    let si = Math.floor(s / 8), di = Math.floor(d / 8);
    const shift = s & 7;
    if (shift === 0) {
      for (; remaining >= 32; remaining -= 32, si += 4, di += 4) {
        outView.setUint32(di, outView.getUint32(di, true) | inView.getUint32(si, true), true);
        if (inAirView) airView.setUint32(di, airView.getUint32(di, true) | inAirView.getUint32(si, true), true);
      }
    } else {
      for (; remaining >= 32; remaining -= 32, si += 4, di += 4) {
        const value = (inView.getUint32(si, true) >>> shift) | (source[si + 4] << (32 - shift));
        outView.setUint32(di, outView.getUint32(di, true) | value, true);
        if (inAirView && sourceAir) {
          const airValue = (inAirView.getUint32(si, true) >>> shift) | (sourceAir[si + 4] << (32 - shift));
          airView.setUint32(di, airView.getUint32(di, true) | airValue, true);
        }
      }
    }
    for (; remaining >= 8; remaining -= 8, si++, di++) {
      ordinary[di] |= shift ? (source[si] >>> shift) | (source[si + 1] << (8 - shift)) : source[si];
      if (sourceAir) air[di] |= shift ? (sourceAir[si] >>> shift) | (sourceAir[si + 1] << (8 - shift)) : sourceAir[si];
    }
    if (remaining) {
      ordinary[di] |= smallBits(source, si * 8 + shift, remaining);
      if (sourceAir) air[di] |= smallBits(sourceAir, si * 8 + shift, remaining);
    }
  }
  return width * rows;
}
