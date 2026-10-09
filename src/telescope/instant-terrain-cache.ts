import { retainTerrainFrame, releaseTerrainImage } from "./terrain-frame";

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

/** OSD owns and may resize every context it receives. Never share its canvas
 * with another tile, an in-flight result, or the completed-tile cache. */
export function copyTerrainContext(
  source: CanvasRenderingContext2D,
): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = source.canvas.width;
  canvas.height = source.canvas.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot copy completed terrain tile");
  context.imageSmoothingEnabled = false;
  context.drawImage(source.canvas, 0, 0);
  return context;
}

interface CachedTerrain {
  context: CanvasRenderingContext2D;
  bytes: number;
  pinned: boolean;
  shared?: boolean;
}

/** Active-map cache shared by all terrain regions. Keys must include the
 * source identity, level and tile coordinates. The byte limit counts decoded
 * RGBA pixels; canvas/driver bookkeeping is additional platform overhead.
 * Coarse pinned tiles outlive ordinary LRU tiles, but never exceed the budget.
 */
export class InstantTerrainCache {
  private entries = new Map<string, CachedTerrain>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(readonly maxBytes = DEFAULT_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError(
        "Terrain cache byte limit must be a nonnegative integer",
      );
  }

  /** Admission can distinguish a ready copy from GPU work without allocating
   * pixels, changing LRU order or starting an image-loader timeout. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Returns an independent canvas that the caller/OSD can mutate or destroy. */
  get(key: string): CanvasRenderingContext2D | undefined { return this.read(key, false); }

  /** Read-only viewport reuse. Tile callers continue to receive independent copies. */
  getFrame(key: string): CanvasRenderingContext2D | undefined { return this.read(key, true); }

  private read(key: string, borrow: boolean): CanvasRenderingContext2D | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    const result = borrow && entry.shared
      ? (retainTerrainFrame(entry.context.canvas), entry.context) : copyTerrainContext(entry.context);
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return result;
  }

  /** Reproject cached pixels without allocating a returned copy or exposing
   * cache-owned canvases. Clearing the footprint preserves authoritative air.
   * The caller supplies its world-to-output transform and sampling settings. */
  paint(key: string, target: CanvasRenderingContext2D,
    x: number, y: number, width: number, height: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    target.clearRect(x, y, width, height);
    target.drawImage(entry.context.canvas, x, y, width, height);
    this.entries.delete(key);
    this.entries.set(key, entry);
    return true;
  }

  /** Copies the input, leaving its ownership with the caller. Returns false
   * when a tile cannot fit, including when pinned tiles consume the budget. */
  set(key: string, source: CanvasRenderingContext2D, pinned = false): boolean {
    const bytes = source.canvas.width * source.canvas.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBytes)
      return false;
    const context = copyTerrainContext(source);
    return this.store(key, context, bytes, pinned);
  }

  /** A published immutable frame needs a reference, not another RGBA canvas. */
  setFrame(key: string, context: CanvasRenderingContext2D): boolean {
    const bytes = context.canvas.width * context.canvas.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBytes) return false;
    retainTerrainFrame(context.canvas);
    return this.store(key, context, bytes, false, true);
  }

  private store(key: string, context: CanvasRenderingContext2D, bytes: number, pinned: boolean, shared = false): boolean {
    this.remove(key);
    this.entries.set(key, { context, bytes, pinned, shared });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      let oldest: string | undefined;
      for (const [candidate, entry] of this.entries) {
        oldest ??= candidate;
        if (!entry.pinned) {
          oldest = candidate;
          break;
        }
      }
      this.remove(oldest!);
      this.evictions++;
    }
    return this.entries.has(key);
  }

  /** Releases cache-owned pixel buffers. Previously returned copies survive.
   * Diagnostic counters remain cumulative for the lifetime of this cache. */
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }

  get stats() {
    let pinned = 0;
    for (const entry of this.entries.values()) if (entry.pinned) pinned++;
    return {
      maxBytes: this.maxBytes,
      bytes: this.bytes,
      entries: this.entries.size,
      pinned,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    if (entry.shared) releaseTerrainImage(entry.context.canvas);
    else entry.context.canvas.width = entry.context.canvas.height = 0;
  }
}
