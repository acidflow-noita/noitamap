import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  IndexedTerrainRetentionStore,
  RetainedTerrain,
  retainedTerrainIdentity,
  type StoredTerrain,
} from "../src/telescope/retained-terrain";
import {
  applyRetainedTerrainEvent,
  createInstantTileSource,
  refreshRetainedTerrain,
} from "../src/telescope/instant-terrain";
import { InstantTerrainCache } from "../src/telescope/instant-terrain-cache";

vi.mock("../src/telescope/instant-terrain-backend", () => ({
  prepareInstantTerrain: vi.fn(),
}));
vi.mock("../src/telescope/instant-terrain-plane", () => ({
  setTerrainPlane: vi.fn(),
}));

function indexedDBFixture() {
  const records = new Map<string, StoredTerrain>();
  const reads: string[] = [];
  let hold = false,
    fail = false,
    transactions = 0;
  const deferred: (() => void)[] = [];
  let heldRead: (key: string) => boolean = () => false;
  let readFailed = false;
  const deferredReads: (() => void)[] = [];
  const db: any = {
    close: vi.fn(),
    createObjectStore: vi.fn(),
    transaction(_name: string, mode: string) {
      const writes: [string, StoredTerrain][] = [];
      let completed = false;
      const tx: any = {
        abort() {
          completed = true;
          tx.onabort?.();
        },
        objectStore() {
          return {
            get(key: string) {
              reads.push(key);
              const request: any = { transaction: tx };
              const value = structuredClone(records.get(key));
              queueMicrotask(() => {
                const finish = () => {
                  if (readFailed) {
                    request.error = new Error("Fixture read failure");
                    request.onerror?.();
                    return;
                  }
                  request.result = value;
                  request.onsuccess?.();
                };
                if (heldRead(key)) deferredReads.push(finish);
                else finish();
              });
              return request;
            },
            put(value: StoredTerrain, key: string) {
              writes.push([key, structuredClone(value)]);
            },
          };
        },
      };
      if (mode === "readwrite") {
        transactions++;
        const finish = () => {
          if (completed) return;
          completed = true;
          if (fail) {
            tx.onabort?.();
            return;
          }
          for (const [key, value] of writes) records.set(key, value);
          tx.oncomplete?.();
        };
        queueMicrotask(() => (hold ? deferred.push(finish) : finish()));
      }
      return tx;
    },
  };
  const open = vi.fn(() => {
    const request: any = { result: db };
    queueMicrotask(() => {
      request.onupgradeneeded?.({ oldVersion: 0 });
      request.onsuccess?.();
    });
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return {
    records,
    reads,
    holdReads(predicate: (key: string) => boolean) {
      heldRead = predicate;
    },
    failReads() {
      readFailed = true;
    },
    releaseReads() {
      heldRead = () => false;
      deferredReads.splice(0).forEach((finish) => finish());
    },
    get pendingReads() {
      return deferredReads.length;
    },
    open,
    get transactions() {
      return transactions;
    },
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      deferred.splice(0).forEach((fn) => fn());
    },
    fail() {
      fail = true;
    },
  };
}

function context(width = 256, height = 256, color = "#00ff00") {
  const c = createCanvas(width, height),
    ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return ctx as unknown as CanvasRenderingContext2D;
}
function rgba(
  ctx: CanvasRenderingContext2D,
  x = 0,
  y = 0,
  w = ctx.canvas.width,
  h = ctx.canvas.height,
) {
  return [...ctx.getImageData(x, y, w, h).data];
}
const owners: RetainedTerrain[] = [];
function retention(budget = 1024 * 1024) {
  const owner = new RetainedTerrain(
    new IndexedTerrainRetentionStore(100),
    budget,
  );
  owners.push(owner);
  return owner;
}
beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal("OpenSeadragon", {
    TileSource: class {
      constructor(opts: any) {
        Object.assign(this, opts);
      }
    },
  });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.flush();
    owner.dispose();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sourceFixture(
  owner: RetainedTerrain,
  identity = "same-source",
  cache = new InstantTerrainCache(0),
  render?: (view: any) => any,
) {
  const region = { x: 0, y: 0, width: 1024, height: 1024, pw: 0 };
  const retained = owner.region(identity, region.width, region.height);
  const shader = vi.fn(
    render ??
      ((view: any) => {
        const out = context(
          view.width,
          view.height,
          view.camZ === 1 ? "#ff0000" : "#0000ff",
        );
        if (view.camZ === 1) out.clearRect(64, 64, 64, 64);
        return out.canvas;
      }),
  );
  const fail = vi.fn();
  const source = createInstantTileSource({
    region,
    gen: {
      seed: 42,
      isNGP: false,
      tileLayers: [],
      biomeData: { pixels: new Uint32Array(1) },
    },
    deps: {
      getWorldSize: () => 2,
      getWorldCenter: () => 0,
      GENERATOR_CONFIG: {},
      GLTerrainRenderer: class {},
      initMaterialAtlas: async () => {},
    },
    clip: {
      draw: (ctx: any, image: any) => ctx.drawImage(image, 0, 0),
      dispose() {},
    },
    renderer: { render: shader, gl: { getError: () => 0 } },
    signal: new AbortController().signal,
    cache,
    retention: retained,
    onFailure: fail,
  });
  return { source, retained, shader, fail, cache };
}
function request(
  source: any,
  level: number,
  x = 0,
  y = 0,
): Promise<CanvasRenderingContext2D> {
  return new Promise((resolve, reject) =>
    source.downloadTileStart({
      tile: { level, x, y },
      finish: resolve,
      fail: reject,
    }),
  );
}

describe("retained final terrain (real production TileSource and native canvas)", () => {
  it("keeps transparent exact areas over a sampled overview, including old coarse cache hits", async () => {
    indexedDBFixture();
    const owner = retention(),
      f = sourceFixture(owner, "same-source", new InstantTerrainCache());
    const before = await request(f.source, 8);
    expect(rgba(before, 0, 0, 1, 1)).toEqual([0, 0, 255, 255]);
    const native = await request(f.source, 10);
    const expectedNative = rgba(native);
    native.canvas.width = 0; // OSD destroys its returned display copy.
    const after = await request(f.source, 8);
    expect(rgba(after, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(rgba(after, 16, 16, 16, 16)).toEqual(new Array(16 * 16 * 4).fill(0));
    expect(rgba(after, 64, 0, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(rgba(await request(f.source, 10))).toEqual(expectedNative);
    expect(f.shader).toHaveBeenCalledTimes(2);
    expect(f.fail).not.toHaveBeenCalled();
  });

  it("captures all four native leaves of a scale 2 request before its 512px canvas is destroyed", async () => {
    indexedDBFixture();
    const f = sourceFixture(retention());
    await request(f.source, 9);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const native = await request(f.source, 10, x, y);
        expect(native.canvas.width).toBe(256);
        expect(rgba(native, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
      }
    const reduced = await request(f.source, 9);
    expect(rgba(reduced, 32, 32, 32, 32)).toEqual(
      new Array(32 * 32 * 4).fill(0),
    );
    expect(f.shader).toHaveBeenCalledTimes(1);
  });

  it("area-reduces all native samples with premultiplied alpha, rather than selecting a point", async () => {
    indexedDBFixture();
    const region = retention().region("coverage-test", 1024, 1024);
    const ctx = context(),
      image = ctx.createImageData(256, 256);
    // Exactly one opaque red pixel per 2×2 block. Independent area expectation:
    // red remains 255, alpha averages to 64; transparent neighbours add no blue.
    for (let y = 0; y < 256; y += 2)
      for (let x = 0; x < 256; x += 2) {
        const i = (y * 256 + x) * 4;
        image.data[i] = 255;
        image.data[i + 3] = 255;
      }
    ctx.putImageData(image, 0, 0);
    await region.record(0, 0, ctx);
    for (const level of [9, 8, 2]) {
      const target = context(256, 256, "#0000ff");
      await region.apply({ level, x: 0, y: 0 }, target);
      expect(rgba(target, 0, 0, 1, 1)).toEqual([255, 0, 0, 64]);
      const edge = 256 / 2 ** (10 - level);
      expect(rgba(target, edge, 0, 1, 1)).toEqual([0, 0, 255, 255]);
    }
  });

  it("displays fresh native pixels and coarse deltas while ancestor disk reads are held, then merges old coverage behind them", async () => {
    const db = indexedDBFixture();
    const old = retention(8 * 1024 * 1024).region("delayed", 1024, 1024);
    await old.record(0, 0, context(256, 256, "#00ff00"));
    await old.record(256, 0, context(256, 256, "#ffff00"));
    await old.owner.flush();
    // Keep old ancestor pixels but force the native leaf through a new draw.
    db.records.delete("delayed/10/0/0");
    db.holdReads(
      (key) => key.startsWith("delayed/") && !key.startsWith("delayed/10/"),
    );
    const owner = retention(8 * 1024 * 1024),
      f = sourceFixture(owner, "delayed");
    try {
      const native = await request(f.source, 10);
      expect(rgba(native, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
      expect(f.retained.hasComplete({ level: 10, x: 0, y: 0 })).toBe(true);
      expect(db.pendingReads).toBe(8); // Every ancestor starts without a serial I/O chain.
      expect(owner.stats.captures).toBe(1);
      // The same region can deliver another native tile while the first
      // tile's ancestor reads remain blocked. This exercises actual TileSource
      // admission/finish code, not a synthetic call-count-only model.
      const other = await request(f.source, 10, 2);
      expect(rgba(other, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
      expect(f.shader).toHaveBeenCalledTimes(2);
      const immediate = context(256, 256, "#0000ff");
      await f.retained.apply({ level: 8, x: 0, y: 0 }, immediate);
      expect(rgba(immediate, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
      expect(rgba(immediate, 16, 16, 16, 16)).toEqual(
        new Array(16 * 16 * 4).fill(0),
      );
      expect(rgba(immediate, 64, 0, 1, 1)).toEqual([0, 0, 255, 255]);
      const writing = owner.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // A partial RAM delta must never overwrite disk-only sibling coverage.
      expect([
        ...db.records.get("delayed/8/0/0")!.pixels.subarray(0, 4),
      ]).toEqual([0, 255, 0, 255]);
      db.releaseReads();
      await writing;
      const merged = context(256, 256, "#0000ff");
      await f.retained.apply({ level: 8, x: 0, y: 0 }, merged);
      expect(rgba(merged, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
      expect(rgba(merged, 16, 16, 16, 16)).toEqual(
        new Array(16 * 16 * 4).fill(0),
      );
      expect(rgba(merged, 64, 0, 1, 1)).toEqual([255, 255, 0, 255]);
      expect(f.fail).not.toHaveBeenCalled();
    } finally {
      db.releaseReads();
    }
  });

  it("bounds pending capture pages while reads stall and never discards their completed native pixels", async () => {
    const db = indexedDBFixture();
    db.holdReads(() => true);
    const owner = retention(24 * 1024 * 1024),
      region = owner.region("bounded", 8192, 8192);
    const input = context();
    let completed = 0;
    const captures = Array.from({ length: 12 }, (_, i) =>
      region.capture(i * 256, 0, input).then(() => completed++),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(completed).toBeGreaterThan(0);
      expect(completed).toBeLessThan(12);
      expect(owner.stats.captureBytes).toBeLessThanOrEqual(
        owner.maxCaptureBytes,
      );
      expect(owner.stats.captures).toBeLessThanOrEqual(8);
      expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxCaptureBytes);
      db.releaseReads();
      await Promise.all(captures);
      await owner.flush();
      for (let x = 0; x < 12; x++) {
        const exact = await region.complete({
          level: region.maxLevel,
          x,
          y: 0,
        });
        expect(exact).toBeDefined();
        expect(rgba(exact!, 0, 0, 1, 1)).toEqual([0, 255, 0, 255]);
      }
    } finally {
      db.releaseReads();
    }
  });

  it("bounds remembered disk misses and avoids re-reading a missing page until pixels exist", async () => {
    const read = vi.fn(async () => undefined);
    const owner = new RetainedTerrain({ read, write: async () => {} });
    owners.push(owner);
    await owner.get("missing");
    await owner.get("missing");
    expect(read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2050; i++) await owner.get(`missing-${i}`);
    expect(owner.stats.missingPages).toBe(2048);
    const region = owner.region("known-later", 1024, 1024),
      tile = { level: 10, x: 0, y: 0 };
    expect(await region.complete(tile)).toBeUndefined();
    expect(region.hasComplete(tile)).toBe(false);
    await region.capture(0, 0, context());
    expect(region.hasComplete(tile)).toBe(true);
    expect(await region.complete(tile)).toBeDefined();
  });

  it("releases hydrated pages after persistence fails while their ancestor reads are pending", async () => {
    const db = indexedDBFixture();
    const original = retention(8 * 1024 * 1024).region(
      "failed-hydration",
      1024,
      1024,
    );
    await original.record(256, 0, context());
    await original.owner.flush();
    db.holdReads(() => true);
    const owner = retention(270_000),
      region = owner.region("failed-hydration", 1024, 1024);
    try {
      await region.capture(0, 0, context(256, 256, "#ff0000"));
      expect(owner.stats.captures).toBe(1);
      db.fail();
      await owner.flush();
      expect(owner.stats.persistent).toBe(false);
      db.releaseReads();
      await owner.capacity();
      expect(owner.stats.captures).toBe(0);
      expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxBytes);
    } finally {
      db.releaseReads();
    }
  });

  it("never overwrites persisted ancestor coverage when its read fails during a safe native write", async () => {
    const db = indexedDBFixture();
    const original = retention(8 * 1024 * 1024).region(
      "read-failed",
      1024,
      1024,
    );
    await original.record(256, 0, context(256, 256, "#ffff00"));
    await original.owner.flush();
    const before = structuredClone(db.records.get("read-failed/8/0/0"));
    db.holdReads(() => true);
    db.hold();
    const owner = retention(270_000),
      region = owner.region("read-failed", 1024, 1024);
    try {
      await region.capture(0, 0, context(256, 256, "#ff0000"));
      const writing = owner.flush(); // The fully-known native leaf is safe to write.
      await new Promise((resolve) => setTimeout(resolve, 0));
      db.failReads();
      db.releaseReads();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(owner.stats.persistent).toBe(false);
      db.release();
      await writing;
      await owner.capacity();
      expect(db.records.get("read-failed/8/0/0")).toEqual(before);
      expect(owner.stats.captures).toBe(0);
      expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxBytes);
    } finally {
      db.releaseReads();
      db.release();
    }
  });

  it("restores bytes after decoded-cache eviction and a new source instance, with zero native redraws", async () => {
    const db = indexedDBFixture();
    const first = sourceFixture(retention(300_000));
    const expected = rgba(await request(first.source, 10));
    for (let x = 1; x < 4; x++) await request(first.source, 10, x, 0);
    await first.retained.owner.flush();
    expect(first.retained.owner.stats.bytes).toBeLessThanOrEqual(300_000);
    const again = await request(first.source, 10);
    expect(rgba(again)).toEqual(expected);
    expect(first.shader).toHaveBeenCalledTimes(4);
    const fresh = sourceFixture(retention(300_000));
    expect(rgba(await request(fresh.source, 10))).toEqual(expected);
    expect(fresh.shader).not.toHaveBeenCalled();
    const before = db.reads.length;
    const overview = await request(fresh.source, 8);
    expect(db.reads.length - before).toBeLessThanOrEqual(2);
    expect(rgba(overview, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(rgba(overview, 16, 16, 16, 16)).toEqual(
      new Array(16 * 16 * 4).fill(0),
    );
  });

  it("merges simultaneous leaves without dropping sibling coverage and reuses a completed exact parent", async () => {
    indexedDBFixture();
    const f = sourceFixture(retention());
    await Promise.all([
      request(f.source, 10, 0, 0),
      request(f.source, 10, 1, 0),
      request(f.source, 10, 0, 1),
      request(f.source, 10, 1, 1),
    ]);
    const reduced = await request(f.source, 9);
    expect(rgba(reduced, 128, 128, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(rgba(reduced, 160, 160, 32, 32)).toEqual(
      new Array(32 * 32 * 4).fill(0),
    );
    expect(f.shader).toHaveBeenCalledTimes(4);
  });

  it("publishes pixels while a write is pending and applies bounded pressure before additional shader work", async () => {
    const db = indexedDBFixture();
    db.hold();
    const owner = retention(300_000),
      f = sourceFixture(owner);
    expect((await request(f.source, 10)).canvas.width).toBe(256);
    const writing = owner.flush();
    let completed = false;
    const next = request(f.source, 10, 1).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    expect(f.shader).toHaveBeenCalledTimes(1);
    expect(owner.stats.snapshotBytes).toBeLessThan(4.3 * 1024 * 1024);
    db.release();
    await writing;
    await next;
    expect(f.shader).toHaveBeenCalledTimes(2);
  });

  it("keeps disk-hit-only navigation within its decoded budget and preserves concurrent reader leases", async () => {
    indexedDBFixture();
    const initial = sourceFixture(retention());
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) await request(initial.source, 10, x, y);
    await initial.retained.owner.flush();
    const owner = retention(270_000),
      f = sourceFixture(owner);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) {
        const pair = await Promise.all([
          request(f.source, 10, x, y),
          request(f.source, 10, x, y),
        ]);
        expect(pair[0].canvas.width).toBe(256);
        expect(rgba(pair[1], 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
        expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxBytes);
      }
    expect(f.shader).not.toHaveBeenCalled();
  });

  it("updates already-loaded overview pixels through the awaited OSD event without shader work", async () => {
    indexedDBFixture();
    const f = sourceFixture(retention());
    const ctx = await request(f.source, 8);
    const item = { source: f.source },
      tile = { level: 8, x: 0, y: 0, loaded: true, tiledImage: item };
    await request(f.source, 10);
    const getData = vi.fn(async () => ctx);
    await applyRetainedTerrainEvent({
      tiledImage: item,
      tile,
      getData,
      outdated: () => false,
    });
    expect(rgba(ctx, 16, 16, 16, 16)).toEqual(new Array(16 * 16 * 4).fill(0));
    expect(rgba(ctx, 0, 0, 1, 1)).toEqual([255, 0, 0, 255]);
    const invalidate = vi.fn(
      async (_tiles: any[], _stamp: number, _restore: boolean) => {},
    );
    const viewer = {
      tileCache: { getLoadedTilesFor: () => [tile] },
      world: { requestTileInvalidateEvent: invalidate },
      forceRedraw: vi.fn(),
    };
    vi.spyOn(Date, "now").mockReturnValue(10);
    refreshRetainedTerrain(viewer, item, [tile]);
    refreshRetainedTerrain(viewer, item, [tile]);
    expect(invalidate.mock.calls[1][1]).toBeGreaterThan(
      invalidate.mock.calls[0][1],
    );
    expect(f.shader).toHaveBeenCalledTimes(2);
  });

  it("treats storage stalls/aborts as optional and releases dirty pages after failure", async () => {
    const db = indexedDBFixture();
    db.fail();
    const owner = retention(270_000),
      f = sourceFixture(owner);
    await request(f.source, 10);
    await owner.flush();
    expect(owner.stats.persistent).toBe(false);
    expect(owner.stats.bytes).toBeLessThanOrEqual(owner.maxBytes);
    await request(f.source, 10, 1);
    expect(f.fail).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const stalled = new IndexedTerrainRetentionStore(10);
    await expect(stalled.read("never")).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("separates NG+ counts, structural geometry and force-air masks in stable identity", () => {
    const gen: any = {
      seed: 42,
      ngPlus: 1,
      isNGP: true,
      gameMode: "normal",
      tileLayers: [
        {
          buffer: new Uint8Array([1, 2]),
          width: 2,
          validChunks: new Set(["1,0", "0,0"]),
        },
      ],
      biomeData: { pixels: new Uint32Array([2]) },
    };
    const a = retainedTerrainIdentity(gen, []);
    expect(retainedTerrainIdentity({ ...gen, ngPlus: 2 }, [])).not.toBe(a);
    gen.tileLayers[0].validChunks = new Set(["0,0", "1,0"]);
    expect(retainedTerrainIdentity(gen, [])).toBe(a);
    gen.tileLayers[0].width = 3;
    expect(retainedTerrainIdentity(gen, [])).not.toBe(a);
    const mask = { x: 0, y: 0, width: 1, height: 1, bits: new Uint8Array([0]) };
    const before = retainedTerrainIdentity(gen, [mask]);
    mask.bits[0] = 1;
    expect(retainedTerrainIdentity(gen, [mask])).not.toBe(before);
  });
});
