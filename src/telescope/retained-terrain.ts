import { OptionalCacheDatabase } from "./cache-storage";
import { TERRAIN_VERSION } from "./terrain-policy";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import type { StaticTerrainMask } from "./static-terrain-mask";
import {
  WorkerRetentionCodec,
  type EncodedTerrain,
  type RetentionCodec,
} from "./retained-terrain-codec";

const SIZE = 256;
const REVISION = `${TERRAIN_VERSION}/retained-hd-v1-fa9cd25`;
export interface RetainedTile {
  level: number;
  x: number;
  y: number;
}
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
  for (let i = 0; i < page.columns * page.rows; i++)
    if (!(page.coverage[i >> 3] & (1 << (i & 7)))) return false;
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

/** Include actual generated geometry and masks, not just a seed or a boolean
 * NG+ flag. Absolute region/plane coordinates are added by region(). */
export function retainedTerrainIdentity(
  gen: GLTerrainGeneration,
  masks: StaticTerrainMask[],
): string {
  let a = 2166136261,
    b = 5381;
  const bytes = (data: ArrayBufferView | undefined) => {
    if (!data) return;
    const values = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    for (const n of values) {
      a = Math.imul(a ^ n, 16777619);
      b = Math.imul(b, 33) ^ n;
    }
  };
  const metadata = (value: unknown) =>
    bytes(new TextEncoder().encode(JSON.stringify(value)));
  metadata([gen.seed, gen.ngPlus ?? 0, gen.isNGP, gen.gameMode ?? "normal"]);
  for (const layer of gen.tileLayers) {
    metadata([
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
    bytes(layer.buffer);
  }
  bytes(gen.biomeData.pixels);
  bytes(gen.biomeData.heavenPixels);
  bytes(gen.biomeData.hellPixels);
  for (const mask of masks) {
    metadata([mask.x, mask.y, mask.width, mask.height]);
    bytes(mask.bits);
    bytes(mask.airBits);
  }
  return `${REVISION}/${gen.seed}/${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

function canvas(width: number, height: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
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
    };
  }
  private touch(key: string, page: Page) {
    this.pages.delete(key);
    this.pages.set(key, page);
  }
  resident(key: string): Page | undefined {
    return this.pages.get(key);
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
  async contains(key: string): Promise<boolean> {
    const resident = this.pages.get(key);
    if (resident && completeCoverage(resident)) return true;
    const loading = this.loads.get(key);
    if (loading) {
      loading.waiters++;
      const page = await loading.promise;
      if (!page) return false;
      try {
        return completeCoverage(page);
      } finally {
        this.release(page);
      }
    }
    if (resident) return false;
    if (!this.readable || this.missing.has(key)) return false;
    const existing = this.coverageReads.get(key);
    if (existing) return existing;
    const read = (async () => {
      try {
        const value = this.store.readCoverage
          ? await this.store.readCoverage(key)
          : await this.store.read(key);
        const current = this.pages.get(key);
        if (current && completeCoverage(current)) return true;
        if (!value) {
          if (!current) this.rememberMissing(key);
          return false;
        }
        return completeCoverage(value);
      } catch {
        this.disableStorage();
        return false;
      }
    })().finally(() => this.coverageReads.delete(key));
    this.coverageReads.set(key, read);
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
          const context = canvas(value.width, value.height);
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
  contains(tile: RetainedTile): Promise<boolean> {
    if (tile.level < this.minLevel || tile.level > this.maxLevel)
      return Promise.resolve(false);
    return this.owner.contains(this.key(tile));
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
            canvas(shape.width, shape.height),
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
      for (let sy = 0; sy < source.canvas.height; sy += SIZE)
        for (let sx = 0; sx < source.canvas.width; sx += SIZE) {
          const leafX = (x + sx) / SIZE,
            leafY = (y + sy) / SIZE;
          let reduced = canvas(
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
              const next = canvas(
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
              reduced.canvas.width = 0;
              reduced = next;
            }
          }
          reduced.canvas.width = 0;
        }
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
