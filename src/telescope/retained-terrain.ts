import { OptionalCacheDatabase } from "./cache-storage";
import { TERRAIN_VERSION } from "./terrain-policy";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import type { StaticTerrainMask } from "./static-terrain-mask";
import { createGenerationCheckpoint } from "./generation-task";
import {
  WorkerRetentionCodec,
  type EncodedTerrain,
  type RetentionCodec,
} from "./retained-terrain-codec";

const SIZE = 256;
const REVISION = `${TERRAIN_VERSION}/retained-hd-v1-9c58775`;
export interface RetainedTile {
  level: number;
  x: number;
  y: number;
}
type CoverageCells = { x: number; y: number; width: number; height: number };
/** Region-local world bounds; scale is world pixels per physical display pixel. */
export interface RetainedView {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export type RetainedViewCoverage = Omit<RetainedView, 'scale'>;
export interface StoredTerrain {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  columns: number;
  rows: number;
}
export interface TerrainRetentionStore {
  read(key: string): Promise<StoredTerrain | undefined>;
  write(entries: { key: string; value: StoredTerrain }[]): Promise<void>;
  readCoverage?(
    key: string,
  ): Promise<Pick<StoredTerrain, "columns" | "rows" | "coverage"> | undefined>;
  dispose?(): void;
}

function completeCoverage(
  page: Pick<StoredTerrain, "columns" | "rows" | "coverage">,
  cells?: CoverageCells,
): boolean {
  if (
    !Number.isInteger(page.columns) ||
    page.columns < 1 ||
    page.columns > SIZE ||
    !Number.isInteger(page.rows) ||
    page.rows < 1 ||
    page.rows > SIZE ||
    page.coverage?.length !== Math.ceil((page.columns * page.rows) / 8)
  )
    return false;
  if (!cells) {
    for (let i = 0; i < page.columns * page.rows; i++)
      if (!(page.coverage[i >> 3] & (1 << (i & 7)))) return false;
    return true;
  }
  const left = cells.x, top = cells.y;
  const right = left + cells.width, bottom = top + cells.height;
  if (![left, top, right, bottom].every(Number.isInteger) || left < 0 || top < 0
    || right <= left || bottom <= top || right > page.columns || bottom > page.rows) return false;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = y * page.columns + x;
    if (!(page.coverage[i >> 3] & (1 << (i & 7)))) return false;
  }
  return true;
}

/** Lossless encoding belongs to optional persistence, never tile delivery.
 * Coverage metadata can be inspected without decoding/copying RGBA canvases.
 * Existing raw v1 records remain readable under the same database schema. */
export class IndexedTerrainRetentionStore implements TerrainRetentionStore {
  private db: OptionalCacheDatabase;
  constructor(
    waitMs = 1500,
    private readonly codec: RetentionCodec = new WorkerRetentionCodec(),
  ) {
    this.db = new OptionalCacheDatabase(
      "noitamap-retained-hd",
      1,
      (db) => db.createObjectStore("tiles"),
      waitMs,
    );
  }
  private async stored(
    key: string,
  ): Promise<StoredTerrain | EncodedTerrain | undefined> {
    if (typeof indexedDB === "undefined") return undefined;
    const db = await this.db.open();
    return this.db.read<StoredTerrain | EncodedTerrain | undefined>(
      db.transaction("tiles").objectStore("tiles").get(key),
    );
  }
  async read(key: string) {
    const value = await this.stored(key);
    return value && ("encoding" in value ? this.codec.decode(value) : value);
  }
  async readCoverage(key: string) {
    const value = await this.stored(key);
    return (
      value && {
        columns: value.columns,
        rows: value.rows,
        coverage: value.coverage,
      }
    );
  }
  async write(entries: { key: string; value: StoredTerrain }[]) {
    if (typeof indexedDB === "undefined")
      throw new Error("Persistent terrain storage unavailable");
    const db = await this.db.open();
    const encoded = await this.codec.encode(
      entries.map((entry) => entry.value),
    );
    const tx = db.transaction("tiles", "readwrite");
    const done = this.db.complete(tx);
    try {
      for (let i = 0; i < entries.length; i++)
        tx.objectStore("tiles").put(encoded[i], entries[i].key);
      await done;
    } catch (error) {
      // A synchronous put() failure must also consume the transaction promise.
      void done.catch(() => {});
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      throw error;
    }
  }
  dispose() {
    this.codec.dispose?.();
    this.db.close();
  }
}

function createTerrainIdentityHash() {
  let a = 2166136261,
    b = 5381;
  const bytes = (data: ArrayBufferView | undefined) => {
    if (!data) return;
    const values = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    // DataView also handles unaligned subviews without copying their bytes.
    const words = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let fnv = a, djb = b, i = 0;
    for (; i + 4 <= values.length; i += 4) {
      const word = words.getUint32(i, true);
      // Most mask blocks are zero. Four zero bytes are exactly four
      // multiplications, so combine them without changing either hash.
      if (word === 0) {
        fnv = Math.imul(fnv, 1345077009); // 16777619^4 modulo 2^32
        djb = Math.imul(djb, 1185921); // 33^4
        continue;
      }
      let n = word & 255;
      fnv = Math.imul(fnv ^ n, 16777619); djb = Math.imul(djb, 33) ^ n;
      n = (word >>> 8) & 255;
      fnv = Math.imul(fnv ^ n, 16777619); djb = Math.imul(djb, 33) ^ n;
      n = (word >>> 16) & 255;
      fnv = Math.imul(fnv ^ n, 16777619); djb = Math.imul(djb, 33) ^ n;
      n = word >>> 24;
      fnv = Math.imul(fnv ^ n, 16777619); djb = Math.imul(djb, 33) ^ n;
    }
    for (; i < values.length; i++) {
      const n = values[i];
      fnv = Math.imul(fnv ^ n, 16777619); djb = Math.imul(djb, 33) ^ n;
    }
    a = fnv; b = djb;
  };
  return {
    bytes,
    finish: (seed: number) => `${REVISION}/${seed}/${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`,
  };
}

/** Preserve the existing byte order, including every repeated mask placement.
 * Views are borrowed from the completed generation; no pixel buffers are copied. */
function* terrainIdentityInputs(gen: GLTerrainGeneration, masks: StaticTerrainMask[]) {
  const encoder = new TextEncoder();
  const metadata = (value: unknown) => encoder.encode(JSON.stringify(value));
  yield metadata([gen.seed, gen.ngPlus ?? 0, gen.isNGP, gen.gameMode ?? "normal"]);
  for (const layer of gen.tileLayers) {
    yield metadata([
      layer.biomeName,
      layer.correctedX,
      layer.correctedY,
      layer.w,
      layer.h,
      layer.isFill,
      layer.minX,
      layer.minY,
      layer.chunkBasePos,
      layer.width,
      layer.height,
      layer.mapH,
      layer.validChunks ? [...layer.validChunks].sort() : null,
    ]);
    if (layer.buffer) yield layer.buffer;
  }
  yield gen.biomeData.pixels;
  if (gen.biomeData.heavenPixels) yield gen.biomeData.heavenPixels;
  if (gen.biomeData.hellPixels) yield gen.biomeData.hellPixels;
  for (const mask of masks) {
    yield metadata([mask.x, mask.y, mask.width, mask.height]);
    yield mask.bits;
    if (mask.airBits) yield mask.airBits;
  }
}

/** Include actual generated geometry and masks, not just a seed or a boolean
 * NG+ flag. Absolute region/plane coordinates are added by region(). */
export function retainedTerrainIdentity(gen: GLTerrainGeneration, masks: StaticTerrainMask[]): string {
  const hash = createTerrainIdentityHash();
  for (const data of terrainIdentityInputs(gen, masks)) hash.bytes(data);
  return hash.finish(gen.seed);
}

/** Live presentation needs the same persistent key without one uninterrupted
 * whole-world hash task. The caller owns immutable inputs until completion or
 * cancellation; the existing task budget yields only when work consumes it. */
export async function retainedTerrainIdentityAsync(
  gen: GLTerrainGeneration, masks: StaticTerrainMask[], signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const hash = createTerrainIdentityHash(), checkpoint = createGenerationCheckpoint(signal);
  for (const data of terrainIdentityInputs(gen, masks)) {
    if (!data) continue;
    // Keep even a single large layer interruptible. Splits are word-aligned,
    // retaining the original four-zero-byte shortcut and trailing-byte order.
    const length = data.byteLength;
    let offset = 0;
    do {
      const size = Math.min(65536, length - offset);
      hash.bytes(size === length ? data : new Uint8Array(data.buffer, data.byteOffset + offset, size));
      offset += size;
      const pause = checkpoint();
      if (pause) await pause;
    } while (offset < length);
  }
  signal.throwIfAborted();
  return hash.finish(gen.seed);
}

function canvas(
  width: number,
  height: number,
  readback = false,
): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  // Retained pages are repeatedly read for persistence as native cells arrive.
  // This hint must be present on the first context request; reduction and
  // display canvases remain draw-oriented.
  const ctx = readback
    ? c.getContext("2d", { willReadFrequently: true })
    : c.getContext("2d");
  if (!ctx) throw new Error("Retained terrain canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
interface Page {
  context: CanvasRenderingContext2D;
  coverage: Uint8Array;
  columns: number;
  rows: number;
  bytes: number;
  version: number;
  saved: number;
  pins: number;
  hydrating: boolean;
}

/** Shared by all nine regions. Dirty pages remain owned until their write
 * settles; new shader work yields under pressure instead of dropping pixels.
 * At most one <=4 MiB snapshot batch is in flight. No completed display waits
 * for a write. Storage failure falls back to the bounded in-memory working set. */
export class RetainedTerrain {
  private pages = new Map<string, Page>();
  private loads = new Map<
    string,
    { promise: Promise<Page | undefined>; waiters: number }
  >();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private writable = true;
  private readable = true;
  private disposed = false;
  private snapshotBytes = 0;
  private missing = new Set<string>();
  private coverageReads = new Map<string, Promise<boolean>>();
  private captureBytes = 0;
  private captures = 0;
  private captureWaiters = new Set<() => void>();
  private reductionCanvases: CanvasRenderingContext2D[] = [];
  readonly maxCaptureBytes = 4 * 1024 * 1024;
  constructor(
    readonly store: TerrainRetentionStore = new IndexedTerrainRetentionStore(),
    readonly maxBytes = 24 * 1024 * 1024,
  ) {}

  region(identity: string, width: number, height: number) {
    return new RetainedTerrainRegion(this, identity, width, height);
  }
  get stats() {
    return {
      bytes: this.bytes,
      snapshotBytes: this.snapshotBytes,
      pages: this.pages.size,
      maxBytes: this.maxBytes,
      persistent: this.writable,
      captureBytes: this.captureBytes,
      captures: this.captures,
      maxCaptureBytes: this.maxCaptureBytes,
      missingPages: this.missing.size,
      reductionBytes: this.reductionCanvases.reduce((bytes, context) =>
        bytes + context.canvas.width * context.canvas.height * 4, 0),
    };
  }
  /** Captures only use these canvases inside their synchronous reduction pass.
   * Sharing across nine regions avoids 36 canvas allocations per 512px sample;
   * nine levels occupy at most 349,524 bytes, independent of map extent. */
  reduceNative(work: (scratch: (depth: number, width: number, height: number) => CanvasRenderingContext2D) => void) {
    try {
      work((depth, width, height) => {
        let context = this.reductionCanvases[depth];
        if (!context) context = this.reductionCanvases[depth] = canvas(width, height);
        else {
          // Preserve actual image edges during the 2:1 filter. A fixed-size
          // backing canvas could blend its padding into an odd-sized edge.
          if (context.canvas.width !== width) context.canvas.width = width;
          if (context.canvas.height !== height) context.canvas.height = height;
          context.clearRect(0, 0, width, height);
          context.imageSmoothingEnabled = false;
        }
        return context;
      });
    } finally {
      // Admission can finish after disposal. Such a late capture must not
      // recreate a scratch pool that the earlier dispose() cannot release.
      if (this.disposed) this.clearReductionCanvases();
    }
  }
  private clearReductionCanvases() {
    for (const context of this.reductionCanvases)
      context.canvas.width = context.canvas.height = 0;
    this.reductionCanvases = [];
  }
  private touch(key: string, page: Page) {
    this.pages.delete(key);
    this.pages.set(key, page);
  }
  resident(key: string): Page | undefined {
    return this.pages.get(key);
  }
  /** Enumerate the bounded decoded working set, never theoretical map tiles. */
  *residentEntries(prefix: string): IterableIterator<[string, Page]> {
    for (const entry of this.pages) if (entry[0].startsWith(prefix)) yield entry;
  }
  loading(key: string): boolean {
    return this.loads.has(key);
  }
  hydration(key: string): Promise<unknown> | undefined {
    return this.loads.get(key)?.promise;
  }
  private wakeCaptures() {
    const waiters = [...this.captureWaiters];
    this.captureWaiters.clear();
    for (const wake of waiters) wake();
  }
  private rememberMissing(key: string) {
    this.missing.delete(key);
    this.missing.add(key);
    if (this.missing.size > 2048)
      this.missing.delete(this.missing.values().next().value!);
  }
  private disableStorage() {
    this.readable = false;
    this.writable = false;
    for (const page of this.pages.values()) page.saved = page.version;
  }
  /** Background skip checks inspect coverage only. A cold compressed record
   * stays compressed, and no display canvas is created or added to the LRU. */
  async contains(key: string, cells?: CoverageCells): Promise<boolean> {
    const resident = this.pages.get(key);
    if (resident && completeCoverage(resident, cells)) return true;
    const loading = this.loads.get(key);
    if (loading) {
      loading.waiters++;
      const page = await loading.promise;
      if (!page) return false;
      try {
        return completeCoverage(page, cells);
      } finally {
        this.release(page);
      }
    }
    if (resident) return false;
    if (!this.readable || this.missing.has(key)) return false;
    const readKey = JSON.stringify([key, cells?.x, cells?.y, cells?.width, cells?.height]);
    const existing = this.coverageReads.get(readKey);
    if (existing) return existing;
    const read = (async () => {
      try {
        const value = this.store.readCoverage
          ? await this.store.readCoverage(key)
          : await this.store.read(key);
        const current = this.pages.get(key);
        if (current && completeCoverage(current, cells)) return true;
        if (!value) {
          if (!current) this.rememberMissing(key);
          return false;
        }
        return completeCoverage(value, cells);
      } catch {
        this.disableStorage();
        return false;
      }
    })().finally(() => this.coverageReads.delete(readKey));
    this.coverageReads.set(readKey, read);
    return read;
  }
  /** Import disk-only cells behind freshly captured exact pixels. Coverage is
   * authoritative even when the newer pixel is transparent. */
  private mergeStored(page: Page, value: StoredTerrain) {
    if (
      page.columns !== value.columns ||
      page.rows !== value.rows ||
      page.context.canvas.width !== value.width ||
      page.context.canvas.height !== value.height
    )
      return;
    const source = canvas(value.width, value.height);
    const image = source.createImageData(value.width, value.height);
    image.data.set(value.pixels);
    source.putImageData(image, 0, 0);
    const cell = Math.max(
      value.width / value.columns,
      value.height / value.rows,
    );
    // Edge pages need the ordinary power-of-two cell size, not width / columns.
    const size = 2 ** Math.ceil(Math.log2(cell));
    let changed = false;
    for (let y = 0; y < page.rows; y++)
      for (let x = 0; x < page.columns; x++) {
        const bit = y * page.columns + x,
          mask = 1 << (bit & 7);
        if (
          !(value.coverage[bit >> 3] & mask) ||
          page.coverage[bit >> 3] & mask
        )
          continue;
        page.context.clearRect(x * size, y * size, size, size);
        page.context.drawImage(
          source.canvas,
          x * size,
          y * size,
          size,
          size,
          x * size,
          y * size,
          size,
          size,
        );
        page.coverage[bit >> 3] |= mask;
        changed = true;
      }
    source.canvas.width = 0;
    if (changed) {
      page.version++;
      if (!this.writable) page.saved = page.version;
    }
  }
  private trim() {
    for (const [key, page] of this.pages) {
      if (this.bytes <= this.maxBytes && !this.disposed) break;
      if (page.version !== page.saved || page.pins || page.hydrating) continue;
      this.pages.delete(key);
      this.bytes -= page.bytes;
      page.context.canvas.width = page.context.canvas.height = 0;
    }
  }
  async get(key: string): Promise<Page | undefined> {
    const cached = this.pages.get(key);
    if (cached) {
      this.touch(key, cached);
      cached.pins++;
      return cached;
    }
    if (!this.readable || this.missing.has(key)) return undefined;
    let load = this.loads.get(key);
    if (!load) {
      load = { promise: null!, waiters: 0 };
      const shared = load;
      this.loads.set(key, shared);
      shared.promise = (async () => {
        try {
          const value = await this.store.read(key);
          const current = this.pages.get(key);
          const valid =
            value &&
            !(
              value.width < 1 ||
              value.width > SIZE ||
              value.height < 1 ||
              value.height > SIZE ||
              value.pixels.length !== value.width * value.height * 4 ||
              value.columns < 1 ||
              value.columns > SIZE ||
              value.rows < 1 ||
              value.rows > SIZE ||
              value.coverage.length !==
                Math.ceil((value.columns * value.rows) / 8)
            );
          if (current) {
            if (valid) this.mergeStored(current, value);
            current.pins += shared.waiters;
            return current;
          }
          if (!valid || this.disposed) {
            if (!value) this.rememberMissing(key);
            return undefined;
          }
          const context = canvas(value.width, value.height, true);
          const image = context.createImageData(value.width, value.height);
          image.data.set(value.pixels);
          context.putImageData(image, 0, 0);
          const page = this.install(
            key,
            context,
            value.coverage,
            value.columns,
            value.rows,
            false,
          );
          // Reserve every waiting caller's lease before publishing the page.
          page.pins += shared.waiters;
          return page;
        } catch {
          // Without the old coverage we cannot safely replace an ancestor on
          // disk. Keep prior persisted pixels intact and use the bounded RAM
          // fallback until this owner is replaced.
          this.disableStorage();
          const current = this.pages.get(key);
          if (current) current.pins += shared.waiters;
          return current;
        }
      })().finally(() => {
        const current = this.pages.get(key);
        if (current) current.hydrating = false;
        this.loads.delete(key);
      });
    }
    load.waiters++;
    return load.promise;
  }
  release(page: Page) {
    if (page.pins) page.pins--;
    this.trim();
  }
  install(
    key: string,
    context: CanvasRenderingContext2D,
    coverage: Uint8Array,
    columns: number,
    rows: number,
    dirty: boolean,
  ): Page {
    const old = this.pages.get(key);
    if (old) this.bytes -= old.bytes;
    const page: Page = {
      context,
      coverage,
      columns,
      rows,
      bytes:
        context.canvas.width * context.canvas.height * 4 + coverage.byteLength,
      version: dirty ? 1 : 0,
      saved: 0,
      pins: 0,
      hydrating: false,
    };
    this.missing.delete(key);
    this.bytes += page.bytes;
    this.touch(key, page);
    this.wakeCaptures();
    if (dirty) this.changed(key, page);
    return page;
  }
  changed(key: string, page: Page) {
    page.version++;
    if (!this.writable) page.saved = page.version;
    this.touch(key, page);
    if (this.writable && !this.timer && !this.writing)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 40);
  }
  /** Called before starting more native sampling, not before displaying it. */
  async capacity() {
    this.trim();
    if (this.bytes > this.maxBytes && this.writable) await this.flush();
    while (
      (this.bytes > this.maxBytes ||
        this.captureBytes >= this.maxCaptureBytes) &&
      this.captures
    ) {
      await new Promise<void>((resolve) => this.captureWaiters.add(resolve));
      if (this.bytes > this.maxBytes && this.writable) await this.flush();
      this.trim();
    }
    this.trim();
  }
  /** Reserve before copying pixels. Concurrent callers cannot create an
   * unbounded queue of captured canvases while disk reads are stalled. */
  async reserveCapture(estimate: () => number): Promise<() => void> {
    await this.capacity();
    let bytes = estimate();
    if (bytes > this.maxCaptureBytes)
      throw new Error("Terrain capture exceeds bounded working set");
    while (
      this.captureBytes + bytes > this.maxCaptureBytes ||
      this.captures >= 8
    ) {
      await new Promise<void>((resolve) => this.captureWaiters.add(resolve));
      bytes = estimate();
    }
    this.captureBytes += bytes;
    this.captures++;
    return () => {
      this.captureBytes -= bytes;
      this.captures--;
      this.wakeCaptures();
    };
  }
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.writing) return this.writing.then(() => this.flush());
    if (!this.writable) {
      this.trim();
      return Promise.resolve();
    }
    const records: {
      key: string;
      value: StoredTerrain;
      page: Page;
      version: number;
    }[] = [];
    for (const [key, page] of this.pages) {
      if (page.saved === page.version || page.hydrating) continue;
      if (records.length && this.snapshotBytes + page.bytes > 4 * 1024 * 1024)
        break;
      const c = page.context.canvas;
      records.push({
        key,
        page,
        version: page.version,
        value: {
          width: c.width,
          height: c.height,
          pixels: page.context.getImageData(0, 0, c.width, c.height).data,
          coverage: page.coverage.slice(),
          columns: page.columns,
          rows: page.rows,
        },
      });
      this.snapshotBytes += page.bytes;
      if (this.snapshotBytes >= 4 * 1024 * 1024) break;
    }
    if (!records.length) {
      this.trim();
      if (this.captures)
        return new Promise<void>((resolve) =>
          this.captureWaiters.add(resolve),
        ).then(() => this.flush());
      return Promise.resolve();
    }
    this.writing = this.store
      .write(records)
      .then(() => {
        for (const { page, version } of records)
          page.saved = this.writable ? version : page.version;
      })
      .catch(() => {
        this.writable = false;
        // Disk failure is optional. The current working set still serves pixels.
        for (const page of this.pages.values()) page.saved = page.version;
      })
      .finally(() => {
        this.snapshotBytes = 0;
        this.writing = undefined;
        this.trim();
      });
    return this.writing.then(() => this.flush());
  }
  dispose() {
    this.disposed = true;
    this.clearReductionCanvases();
    void this.flush().finally(() => this.store.dispose?.());
  }
}

export class RetainedTerrainRegion {
  readonly maxLevel: number;
  readonly minLevel: number;
  revision = 0;
  private listeners = new Set<(tiles: RetainedTile[]) => void>();
  constructor(
    readonly owner: RetainedTerrain,
    readonly identity: string,
    readonly width: number,
    readonly height: number,
  ) {
    this.maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
    // At lower levels a leaf occupies a fractional pixel. OSD can reduce this
    // tiny base image itself; retain integer rectangles throughout our pyramid.
    this.minLevel = Math.max(0, this.maxLevel - 8);
  }
  subscribe(listener: (tiles: RetainedTile[]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private key(tile: RetainedTile) {
    return `${this.identity}/${tile.level}/${tile.x}/${tile.y}`;
  }
  private shape(tile: RetainedTile) {
    const scale = 2 ** (this.maxLevel - tile.level);
    return {
      scale,
      width: Math.min(SIZE, Math.ceil(this.width / scale) - tile.x * SIZE),
      height: Math.min(SIZE, Math.ceil(this.height / scale) - tile.y * SIZE),
    };
  }
  /** Resident exact coverage can bypass cold tile admission without a disk
   * lookup, allocation, or a wait for unrelated ancestor hydration. */
  hasComplete(tile: RetainedTile): boolean {
    const page = this.owner.resident(this.key(tile));
    return !!page && completeCoverage(page);
  }
  private viewBounds(view: RetainedView) {
    if (![view.x, view.y, view.width, view.height, view.scale].every(Number.isFinite) ||
        view.width < 0 || view.height < 0 || view.scale <= 0) return undefined;
    const level = Math.max(this.minLevel, Math.min(this.maxLevel,
      this.maxLevel - Math.floor(Math.log2(Math.max(1, view.scale)))));
    const scale = 2 ** (this.maxLevel - level), span = SIZE * scale;
    const left = Math.max(0, view.x), top = Math.max(0, view.y);
    const right = Math.min(this.width, view.x + view.width);
    const bottom = Math.min(this.height, view.y + view.height);
    return { level, scale, span, left, top, right, bottom, displayScale: view.scale };
  }
  private *viewTiles(view: NonNullable<ReturnType<RetainedTerrainRegion['viewBounds']>>) {
    if (view.right <= view.left || view.bottom <= view.top) return;
    for (let y = Math.floor(view.top / view.span); y < Math.ceil(view.bottom / view.span); y++)
      for (let x = Math.floor(view.left / view.span); x < Math.ceil(view.right / view.span); x++)
        yield { level: view.level, x, y };
  }
  private viewCells(bounds: NonNullable<ReturnType<RetainedTerrainRegion['viewBounds']>>, tile: RetainedTile): CoverageCells {
    const px = tile.x * bounds.span, py = tile.y * bounds.span, count = bounds.span / SIZE;
    const x = Math.max(0, Math.floor((bounds.left - px) / SIZE));
    const y = Math.max(0, Math.floor((bounds.top - py) / SIZE));
    return { x, y,
      width: Math.min(count, Math.ceil((bounds.right - px) / SIZE)) - x,
      height: Math.min(count, Math.ceil((bounds.bottom - py) / SIZE)) - y,
    };
  }
  /** A cached-generation hint is not proof that this camera was saved. Check
   * its requested cells without decoding pixels; stop at the first missing page. */
  async containsView(view: RetainedView, signal?: AbortSignal): Promise<boolean> {
    const bounds = this.viewBounds(view);
    if (!bounds) return false;
    for (const tile of this.viewTiles(bounds)) {
      signal?.throwIfAborted();
      const ready = await this.contains(tile, this.viewCells(bounds, tile));
      signal?.throwIfAborted();
      if (!ready) return false;
    }
    return true;
  }
  private residentViewPages(bounds: NonNullable<ReturnType<RetainedTerrainRegion['viewBounds']>>) {
    const prefix = this.identity + '/';
    const entries = [];
    for (const [key, page] of this.owner.residentEntries(prefix)) {
      const [level, x, y] = key.slice(prefix.length).split('/').map(Number);
      if (level < bounds.level || level > this.maxLevel) continue;
      const scale = 2 ** (this.maxLevel - level), span = SIZE * scale;
      if (x * span >= bounds.right || (x + 1) * span <= bounds.left
        || y * span >= bounds.bottom || (y + 1) * span <= bounds.top) continue;
      entries.push({ tile: { level, x, y }, page, bounds: { ...bounds, level, scale, span } });
    }
    // Prefer the already-reduced exact mip. Finer resident pages fill cells
    // missing at that level immediately, without waiting for disk hydration.
    return entries.sort((a, b) => a.tile.level - b.tile.level);
  }
  private *knownViewCells(
    bounds: NonNullable<ReturnType<RetainedTerrainRegion['viewBounds']>>,
    tile: RetainedTile, page: Page, seen?: Set<number>,
  ): IterableIterator<RetainedViewCoverage> {
    const px = tile.x * bounds.span, py = tile.y * bounds.span;
    const columns = Math.ceil(this.width / SIZE);
    const left = Math.max(0, Math.floor((bounds.left - px) / SIZE));
    const right = Math.min(page.columns, Math.ceil((bounds.right - px) / SIZE));
    const top = Math.max(0, Math.floor((bounds.top - py) / SIZE));
    const bottom = Math.min(page.rows, Math.ceil((bounds.bottom - py) / SIZE));
    for (let y = top; y < bottom; y++) {
      let start = -1;
      for (let x = left; x <= right; x++) {
        const bit = y * page.columns + x;
        const cell = (py / SIZE + y) * columns + px / SIZE + x;
        const known = x < right && !!(page.coverage[bit >> 3] & (1 << (bit & 7))) && !seen?.has(cell);
        if (known) { seen?.add(cell); if (start < 0) start = x; }
        if (!known && start >= 0) {
          const rx = Math.max(bounds.left, px + start * SIZE), ry = Math.max(bounds.top, py + y * SIZE);
          yield { x: rx, y: ry, width: Math.min(bounds.right, px + x * SIZE) - rx,
            height: Math.min(bounds.bottom, py + (y + 1) * SIZE) - ry };
          start = -1;
        }
      }
    }
  }
  /** Every visible native cell is known at the selected or a finer RAM mip. */
  hasCompleteView(view: RetainedView): boolean {
    const bounds = this.viewBounds(view);
    if (!bounds) return false;
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return true;
    const needed = (Math.ceil(bounds.right / SIZE) - Math.floor(bounds.left / SIZE))
      * (Math.ceil(bounds.bottom / SIZE) - Math.floor(bounds.top / SIZE));
    const seen = new Set<number>();
    for (const entry of this.residentViewPages(bounds)) {
      for (const _ of this.knownViewCells(entry.bounds, entry.tile, entry.page, seen)) { /* collect cell coverage */ }
      if (seen.size === needed) return true;
    }
    return false;
  }
  private paintViewPage(
    target: CanvasRenderingContext2D,
    bounds: NonNullable<ReturnType<RetainedTerrainRegion['viewBounds']>>,
    tile: RetainedTile,
    page: Page,
    seen?: Set<number>,
  ) {
    const px = tile.x * bounds.span, py = tile.y * bounds.span;
    const coverage = [...this.knownViewCells(bounds, tile, page, seen)];
    if (!coverage.length) return coverage;
    target.save();
    target.beginPath();
    target.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
    target.clip();
    // Coverage cells always represent a native 256x256 world block, even
    // in a reduced page. Clip both erasure and painting to known cells: a
    // final transparent pixel must replace the provisional GPU pixel too.
    target.beginPath();
    for (const rect of coverage) target.rect(rect.x, rect.y, rect.width, rect.height);
    target.clip();
    const width = page.context.canvas.width * bounds.scale;
    const height = page.context.canvas.height * bounds.scale;
    target.clearRect(px, py, width, height);
    target.imageSmoothingEnabled = bounds.scale < bounds.displayScale;
    target.imageSmoothingQuality = 'low';
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
    target.drawImage(page.context.canvas, px, py, width, height);
    target.restore();
    return coverage;
  }
  /** Synchronous display path: no storage access or pixel readbacks. */
  paintResidentView(target: CanvasRenderingContext2D, view: RetainedView): RetainedViewCoverage[] {
    const bounds = this.viewBounds(view);
    if (!bounds) return [];
    const seen = new Set<number>(), coverage: RetainedViewCoverage[] = [];
    for (const entry of this.residentViewPages(bounds)) {
      coverage.push(...this.paintViewPage(target, entry.bounds, entry.tile, entry.page, seen));
    }
    return coverage;
  }
  /** Optional background hydration. Sequential leases bound decoded RAM and
   * leave display free to use resident deltas while disk is slow or denied. */
  async hydrateView(view: RetainedView, signal?: AbortSignal): Promise<void> {
    const bounds = this.viewBounds(view);
    if (!bounds) return;
    for (const tile of this.viewTiles(bounds)) {
      signal?.throwIfAborted();
      const page = await this.owner.get(this.key(tile));
      if (page) this.owner.release(page);
      signal?.throwIfAborted();
    }
  }
  /** Stream a fully cooked viewport from optional storage without holding all
   * pages at once. A missing/incomplete page asks the caller for its GPU base. */
  async paintStoredView(target: CanvasRenderingContext2D, view: RetainedView, signal?: AbortSignal,
    onCoverage?: (rectangle: RetainedViewCoverage) => void): Promise<boolean> {
    const bounds = this.viewBounds(view);
    if (!bounds) return false;
    let complete = true;
    for (const tile of this.viewTiles(bounds)) {
      signal?.throwIfAborted();
      const page = await this.owner.get(this.key(tile));
      if (!page) { signal?.throwIfAborted(); complete = false; continue; }
      try {
        signal?.throwIfAborted();
        if (!completeCoverage(page, this.viewCells(bounds, tile))) complete = false;
        for (const rectangle of this.paintViewPage(target, bounds, tile, page)) onCoverage?.(rectangle);
      } finally { this.owner.release(page); }
    }
    return complete;
  }
  contains(tile: RetainedTile, cells?: CoverageCells): Promise<boolean> {
    if (tile.level < this.minLevel || tile.level > this.maxLevel)
      return Promise.resolve(false);
    return this.owner.contains(this.key(tile), cells);
  }
  /** Verify a saved native block and all its reductions using coverage only.
   * Only that block's cells must be present in each ancestor. Native leaves
   * must also exist: a complete parent can survive an interrupted save. */
  async containsPyramid(x: number, y: number, width: number, height: number, signal?: AbortSignal): Promise<boolean> {
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || x % SIZE || y % SIZE
      || width < 1 || height < 1 || width > 512 || height > 512) return false;
    const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
    if (right <= x || bottom <= y) return false;
    for (let level = this.maxLevel; level >= this.minLevel; level--) {
      const scale = 2 ** (this.maxLevel - level), span = SIZE * scale;
      for (let ty = Math.floor(y / span); ty < Math.ceil(bottom / span); ty++)
        for (let tx = Math.floor(x / span); tx < Math.ceil(right / span); tx++) {
          signal?.throwIfAborted();
          const left = Math.max(0, x / SIZE - tx * scale), top = Math.max(0, y / SIZE - ty * scale);
          const complete = await this.contains({ level, x: tx, y: ty }, {
            x: left, y: top,
            width: Math.min(scale, Math.ceil(right / SIZE) - tx * scale) - left,
            height: Math.min(scale, Math.ceil(bottom / SIZE) - ty * scale) - top,
          });
          signal?.throwIfAborted();
          if (!complete) return false;
        }
    }
    return true;
  }
  async complete(tile: RetainedTile) {
    if (tile.level < this.minLevel) return undefined;
    const page = await this.owner.get(this.key(tile));
    if (!page) return undefined;
    try {
      if (!completeCoverage(page)) return undefined;
      const out = canvas(page.context.canvas.width, page.context.canvas.height);
      out.drawImage(page.context.canvas, 0, 0);
      return out;
    } finally {
      this.owner.release(page);
    }
  }
  async native(x: number, y: number, width: number, height: number) {
    const output = canvas(width, height);
    for (let dy = 0; dy < height; dy += SIZE)
      for (let dx = 0; dx < width; dx += SIZE) {
        const page = await this.owner.get(
          this.key({
            level: this.maxLevel,
            x: (x + dx) / SIZE,
            y: (y + dy) / SIZE,
          }),
        );
        if (!page) {
          output.canvas.width = 0;
          return undefined;
        }
        try {
          if (!(page.coverage[0] & 1)) {
            output.canvas.width = 0;
            return undefined;
          }
          output.drawImage(page.context.canvas, dx, dy);
        } finally {
          this.owner.release(page);
        }
      }
    return output;
  }
  async apply(tile: RetainedTile, target: CanvasRenderingContext2D) {
    const revision = this.revision;
    if (tile.level < this.minLevel || tile.level > this.maxLevel)
      return revision;
    const page = await this.owner.get(this.key(tile));
    if (!page) return revision;
    try {
      const cell = SIZE / this.shape(tile).scale;
      // Coverage describes known pixels even when their terrain alpha is zero.
      for (let y = 0; y < page.rows; y++) {
        let start = -1;
        for (let x = 0; x <= page.columns; x++) {
          const bit = y * page.columns + x;
          const known =
            x < page.columns && !!(page.coverage[bit >> 3] & (1 << (bit & 7)));
          if (known && start < 0) start = x;
          if (!known && start >= 0) {
            target.clearRect(start * cell, y * cell, (x - start) * cell, cell);
            start = -1;
          }
        }
      }
      target.save();
      target.imageSmoothingEnabled = false;
      target.drawImage(page.context.canvas, 0, 0);
      target.restore();
    } finally {
      this.owner.release(page);
    }
    return revision;
  }
  /** Publish exact native pixels and their ancestor deltas before display.
   * Optional disk-only coverage merges behind them in parallel. The caller
   * owns source until this resolves; admission bounds waiting source canvases. */
  async capture(
    x: number,
    y: number,
    source: CanvasRenderingContext2D,
  ): Promise<void> {
    await this.captureWork(x, y, source);
  }
  /** Compatibility operation for callers requiring all disk merges settled. */
  async record(
    x: number,
    y: number,
    source: CanvasRenderingContext2D,
  ): Promise<void> {
    const { merged } = await this.captureWork(x, y, source);
    await merged;
  }
  private async captureWork(
    x: number,
    y: number,
    source: CanvasRenderingContext2D,
  ): Promise<{ merged: Promise<void> }> {
    if (
      x % SIZE ||
      y % SIZE ||
      source.canvas.width > 512 ||
      source.canvas.height > 512
    )
      throw new Error(
        "Native retention requires aligned samples of at most 512 pixels",
      );
    const touched = new Map<
      string,
      { tile: RetainedTile; shape: ReturnType<RetainedTerrainRegion["shape"]> }
    >();
    for (let sy = 0; sy < source.canvas.height; sy += SIZE)
      for (let sx = 0; sx < source.canvas.width; sx += SIZE)
        for (let level = this.maxLevel; level >= this.minLevel; level--) {
          const scale = 2 ** (this.maxLevel - level);
          const tile = {
            level,
            x: Math.floor((x + sx) / SIZE / scale),
            y: Math.floor((y + sy) / SIZE / scale),
          };
          touched.set(this.key(tile), { tile, shape: this.shape(tile) });
        }
    const releaseCapture = await this.owner.reserveCapture(() => {
      let bytes = 0;
      for (const [key, { shape }] of touched)
        if (!this.owner.resident(key))
          bytes +=
            shape.width * shape.height * 4 +
            Math.ceil(
              (Math.ceil((shape.width * shape.scale) / SIZE) *
                Math.ceil((shape.height * shape.scale) / SIZE)) /
                8,
            );
      return bytes;
    });
    const pinned = new Set<Page>();
    const hydrating: Promise<unknown>[] = [];
    let merged: Promise<void>;
    let failed = false,
      failure: unknown;
    try {
      // All missing ancestor lookups start together. Install writable RAM
      // deltas immediately; get() merges an eventual disk result behind them.
      for (const [key, { tile, shape }] of touched) {
        let page = this.owner.resident(key);
        if (!page) {
          if (tile.level !== this.maxLevel) {
            const loading = this.owner.get(key);
            hydrating.push(
              loading.then((value) => {
                if (value) this.owner.release(value);
              }),
            );
          }
          const columns = Math.ceil((shape.width * shape.scale) / SIZE),
            rows = Math.ceil((shape.height * shape.scale) / SIZE);
          page = this.owner.install(
            key,
            canvas(shape.width, shape.height, true),
            new Uint8Array(Math.ceil((columns * rows) / 8)),
            columns,
            rows,
            false,
          );
          page.hydrating =
            tile.level !== this.maxLevel && this.owner.loading(key);
        } else if (page.hydrating) {
          const loading = this.owner.hydration(key);
          if (loading) hydrating.push(loading);
        }
        page.pins++;
        pinned.add(page);
      }
      this.owner.reduceNative((scratch) => {
        for (let sy = 0; sy < source.canvas.height; sy += SIZE)
          for (let sx = 0; sx < source.canvas.width; sx += SIZE) {
            const leafX = (x + sx) / SIZE,
              leafY = (y + sy) / SIZE;
            let reduced = scratch(
              0,
              Math.min(SIZE, source.canvas.width - sx),
              Math.min(SIZE, source.canvas.height - sy),
            );
            reduced.drawImage(
              source.canvas,
              sx,
              sy,
              reduced.canvas.width,
              reduced.canvas.height,
              0,
              0,
              reduced.canvas.width,
              reduced.canvas.height,
            );
            for (let level = this.maxLevel; level >= this.minLevel; level--) {
              const scale = 2 ** (this.maxLevel - level);
              const tile = {
                level,
                x: Math.floor(leafX / scale),
                y: Math.floor(leafY / scale),
              };
              const key = this.key(tile),
                page = this.owner.resident(key)!;
              const cx = leafX % scale,
                cy = leafY % scale,
                cell = SIZE / scale;
              page.context.clearRect(cx * cell, cy * cell, cell, cell);
              page.context.drawImage(reduced.canvas, cx * cell, cy * cell);
              const bit = cy * page.columns + cx;
              page.coverage[bit >> 3] |= 1 << (bit & 7);
              this.owner.changed(key, page);
              if (level > this.minLevel) {
                const next = scratch(
                  this.maxLevel - level + 1,
                  Math.ceil(reduced.canvas.width / 2),
                  Math.ceil(reduced.canvas.height / 2),
                );
                next.imageSmoothingEnabled = true;
                next.imageSmoothingQuality = "low";
                next.drawImage(
                  reduced.canvas,
                  0,
                  0,
                  reduced.canvas.width / 2,
                  reduced.canvas.height / 2,
                );
                reduced = next;
              }
            }
          }
      });
      this.revision++;
      const changed = [...touched.values()].map((entry) => entry.tile);
      for (const listener of this.listeners) listener(changed);
      merged = Promise.all(hydrating).then(() => {
        if (hydrating.length) {
          this.revision++;
          for (const listener of this.listeners) listener(changed);
        }
      });
    } catch (error) {
      failed = true;
      failure = error;
      merged = Promise.allSettled(hydrating).then(() => {
        throw error;
      });
    }
    merged = merged.finally(() => {
      for (const page of pinned) this.owner.release(page);
      releaseCapture();
    });
    // capture() intentionally returns before optional ancestor reads complete.
    // Consume errors here while record() still receives their original result.
    void merged.catch(() => {});
    if (failed) throw failure;
    return { merged };
  }
}
