import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  addInstantTerrain,
  clearInstantTerrain,
  createInstantClip,
  createInstantTileSource,
  instantTileView,
  instantSampleView,
  instantTilePriority,
  reduceInstantTile,
  smoothInstantTile,
  INSTANT_TILE_SIZE,
} from "../src/telescope/instant-terrain";
import { InstantTerrainCache } from '../src/telescope/instant-terrain-cache';
import {
  WORLD_TOP,
  WORLD_HEIGHT,
  type TerrainOwnership,
} from "../src/telescope/terrain-policy";
import { prepareInstantTerrain, releaseInstantTerrainBackend } from "../src/telescope/instant-terrain-backend";
vi.mock("../src/telescope/instant-terrain-plane", () => ({
  setTerrainPlane: vi.fn(),
}));
vi.mock("../src/telescope/terrain-shader-prewarm", () => ({
  prewarmTerrainShader: async () => {},
}));

const region = {
  x: -17920,
  y: WORLD_TOP - WORLD_HEIGHT,
  width: 35840,
  height: WORLD_HEIGHT * 3,
  pw: 0,
};
const gen = {
  seed: 42,
  isNGP: false,
  tileLayers: [],
  biomeData: { pixels: new Uint32Array(70 * 48) },
};
const draw = vi.fn((view: any) => {
  const canvas = createCanvas(view.width, view.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fc8000";
  ctx.fillRect(0, 0, view.width, view.height);
  return canvas;
});
const build = vi.fn(() => true);
class Renderer {
  engineReady = true;
  gl = { getError: () => 0 };
  ensureResources = build;
  render = draw;
  invalidate() {}
}
const deps = {
  GLTerrainRenderer: Renderer,
  initMaterialAtlas: async () => {},
  getWorldSize: () => 70,
  getWorldCenter: () => 35,
  GENERATOR_CONFIG: {},
};
const owner = (enabled: boolean): TerrainOwnership => ({
  width: 70,
  owners: new Int16Array(70 * 48).fill(enabled ? 0 : -1),
  names: ["test"],
  at: () => (enabled ? 0 : -1),
});
beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("OpenSeadragon", {
    TileSource: class {
      constructor(o: any) {
        Object.assign(this, o);
      }
    },
  });
  vi.clearAllMocks();
});
afterEach(() => {
  clearInstantTerrain();
  releaseInstantTerrainBackend();
  vi.unstubAllGlobals();
});

function request(source: any, level = source.maxLevel, x = 0, y = 0) {
  let resolve!: (result: any) => void;
  const result = new Promise<any>((r) => (resolve = r));
  const context: any = {
    tile: { level, x, y },
    jobId: 1,
    finish: vi.fn((value: any, _request: any, type: string) =>
      resolve({ value, type }),
    ),
    fail: vi.fn((error: any) => resolve({ error })),
  };
  source.downloadTileStart(context);
  context.abort = () => {
    source.downloadTileAbort(context);
    context.fail('Terrain request cancelled by loader');
  };
  return { context, result };
}
function source(controller = new AbortController(), onFailure = vi.fn(), cache?: InstantTerrainCache) {
  const clip = createInstantClip([owner(true), owner(true), owner(true)], []);
  return createInstantTileSource({
    region,
    gen,
    deps,
    renderer: new Renderer(),
    clip,
    signal: controller.signal,
    onFailure,
    cache,
  });
}
function viewer() {
  const handlers = new Map<string, Set<(e: any) => void>>();
  const items: any[] = [];
  const instance: any = {
    world: {
      removeItem: vi.fn((item) => {
        const i = items.indexOf(item);
        if (i >= 0) items.splice(i, 1);
      }),
    },
    viewport: { getCenter: () => ({ x: 0, y: 0 }) },
    addHandler(name: string, fn: any) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    },
    removeHandler(name: string, fn: any) {
      handlers.get(name)?.delete(fn);
    },
    emit(name: string, e: any) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(e);
    },
    addTiledImage(o: any) {
      const item = { source: o.tileSource };
      items.push(item);
      o.success({ item });
    },
    items,
    handlers,
  };
  return instance;
}

describe("display-resolution GPU terrain (native canvas, no browser)", () => {
  it.each([-1, 0, 1])(
    "uses absolute game coordinates in world %i at every LOD",
    (pw) => {
      const r = { ...region, x: region.x + pw * region.width, pw };
      for (const level of [0, 8, 12, 17]) {
        const v = instantTileView(r, { level, x: 0, y: 0 }, 35, 70)!;
        expect(v.camX - v.width / (2 * v.camZ) - 35 * 512 + pw * 70 * 512).toBe(
          r.x,
        );
        expect(v.camY - v.height / (2 * v.camZ) - 14 * 512).toBe(r.y);
        expect(v.width).toBeLessThanOrEqual(INSTANT_TILE_SIZE);
        expect(v.height).toBeLessThanOrEqual(INSTANT_TILE_SIZE);
        expect(v.width * v.scale).toBeGreaterThanOrEqual(
          Math.min(r.width, INSTANT_TILE_SIZE * v.scale),
        );
      }
    },
  );
  it("covers adjacent LOD tiles without gaps and clips the last partial tile", () => {
    const a = instantTileView(region, { level: 12, x: 0, y: 0 }, 35, 70)!;
    const b = instantTileView(region, { level: 12, x: 1, y: 0 }, 35, 70)!;
    const last = instantTileView(region, { level: 12, x: 4, y: 0 }, 35, 70)!;
    expect(a.x + a.width * a.scale).toBe(b.x);
    expect(last.width).toBe(96);
    expect(last.x + last.width * last.scale).toBe(region.x + region.width);
    expect(
      instantTileView(region, { level: 12, x: 5, y: 0 }, 35, 70),
    ).toBeNull();
    expect(
      instantTileView(region, { level: 18, x: 0, y: 0 }, 35, 70),
    ).toBeNull();
  });
  it("renders a whole-world overview with one bounded draw, without native-resolution descendants", async () => {
    const src = source();
    const { result } = request(src, 8);
    const { value, type } = await result;
    expect(type).toBe("context2d");
    expect(value.canvas.width).toBe(70);
    expect(value.canvas.height).toBe(144);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(
      expect.objectContaining({ camZ: 1 / 256, width: 140, height: 288 }),
      expect.any(AbortSignal),
    );
  });
  it('keeps sampled world footprints fixed with a bounded shader image', () => {
    for (const level of [0, 8, 12, 16, 17]) {
      const logical = instantTileView(region, { level, x: 0, y: 0 }, 35, 70)!;
      const sample = instantSampleView(logical);
      expect(sample.width).toBeLessThanOrEqual(512);
      expect(sample.height).toBeLessThanOrEqual(512);
      expect(sample.width * sample.scale).toBe(logical.width * logical.scale);
      expect(sample.height * sample.scale).toBe(logical.height * logical.scale);
      expect(sample.camX).toBe(logical.camX);
      expect(sample.camY).toBe(logical.camY);
      expect(sample.engineTerrain).toBe(true);
      if (level === 17) expect(sample.sampleFactor).toBe(1);
      else expect(sample.sampleFactor).toBeGreaterThan(1);
    }
  });
  it('retains thin terrain coverage when reducing sampled pixels', () => {
    const canvas = createCanvas(4, 4), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 4);
    const reduced = reduceInstantTile(canvas as any, 1, 1).getImageData(0, 0, 1, 1).data;
    expect(reduced[0]).toBe(255);
    expect(reduced[3]).toBeGreaterThanOrEqual(63);
    expect(reduced[3]).toBeLessThanOrEqual(65);
  });
  it('filters terrain reductions and keeps enlarged pixels and other layers crisp', () => {
    const ctx = createCanvas(2, 2).getContext('2d');
    ctx.imageSmoothingEnabled = false;
    smoothInstantTile({ context: ctx, tile: { level: 4 }, tiledImage: { source: {} } });
    expect(ctx.imageSmoothingEnabled).toBe(false);
    ctx.save();
    smoothInstantTile({ context: ctx, tile: { level: 4, size: { x: 128 }, sourceBounds: { width: 256 } }, tiledImage: { source: { __instantTerrain: true, maxLevel: 8 } } });
    expect(ctx.imageSmoothingEnabled).toBe(true);
    ctx.restore();
    expect(ctx.imageSmoothingEnabled).toBe(false);
    smoothInstantTile({ context: ctx, tile: { level: 4, size: { x: 512 }, sourceBounds: { width: 256 } }, tiledImage: { source: { __instantTerrain: true, maxLevel: 8 } } });
    expect(ctx.imageSmoothingEnabled).toBe(false);
    smoothInstantTile({ context: ctx, tile: { level: 8 }, tiledImage: { source: { __instantTerrain: true, maxLevel: 8 } } });
    expect(ctx.imageSmoothingEnabled).toBe(false);
    smoothInstantTile({ context: ctx, tile: { level: 8, size: { x: 128 }, sourceBounds: { width: 256 } },
      tiledImage: { source: { __instantTerrain: true, maxLevel: 8 } } });
    expect(ctx.imageSmoothingEnabled).toBe(true);
  });
  it('closes worker bitmaps after copying them into a retained tile', async () => {
    const image = createCanvas(256, 256) as any;
    image.getContext('2d').fillRect(0, 0, 256, 256);
    image.close = vi.fn();
    draw.mockImplementationOnce(() => Promise.resolve(image) as any);
    const { value, type } = await request(source()).result;
    expect(type).toBe('context2d');
    expect(value.canvas.width).toBe(256);
    expect(image.close).toHaveBeenCalledOnce();
  });
  it('closes a late worker bitmap after cancellation without publishing a tile', async () => {
    const image = createCanvas(256, 256) as any;
    image.close = vi.fn();
    let release!: (value: any) => void;
    draw.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as any);
    const lifetime = new AbortController(), failed = vi.fn(), job = request(source(lifetime, failed));
    await vi.waitFor(() => expect(draw).toHaveBeenCalledOnce());
    lifetime.abort();
    expect((await job.result).error).toContain('cancelled');
    release(image);
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
    expect(job.context.finish).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
  it("does not render cancelled requests or leave their loader jobs pending", async () => {
    const lifetime = new AbortController(),
      src = source(lifetime);
    const job = request(src);
    lifetime.abort();
    expect((await job.result).error).toContain("cancelled");
    await new Promise((r) => setTimeout(r, 10));
    expect(draw).not.toHaveBeenCalled();
    expect(job.context.fail).toHaveBeenCalledOnce();
    expect(job.context.finish).not.toHaveBeenCalled();
  });
  it("settles camera-aborted requests independently of the seed lifetime", async () => {
    const src = source();
    const a = request(src),
      b = request(src);
    a.context.abort();
    expect((await a.result).error).toContain("cancelled");
    expect((await b.result).type).toBe("context2d");
    expect(draw).toHaveBeenCalledOnce();
  });
  it('reuses completed pixels after OSD destroys its returned canvas', async () => {
    const src = source();
    const first = (await request(src).result).value;
    const expected = first.getImageData(0, 0, 1, 1).data;
    first.canvas.width = first.canvas.height = 0;
    const second = (await request(src).result).value;
    expect(second.canvas.width).toBe(256);
    expect(second.getImageData(0, 0, 1, 1).data).toEqual(expected);
    expect(draw).toHaveBeenCalledOnce();
    expect(src.instantCacheStats.hits).toBe(1);
  });
  it('revisits zoom levels and offscreen tile coordinates without another shader draw', async () => {
    const src = source();
    const tiles = [[src.maxLevel, 0, 0], [8, 0, 0], [12, 1, 1], [src.maxLevel, 2, 2]];
    for (const [level, x, y] of [...tiles, ...[...tiles].reverse(), ...tiles]) {
      const { value } = await request(src, level, x, y).result;
      expect(value).toBeTruthy();
      value.canvas.width = value.canvas.height = 0;
    }
    expect(draw).toHaveBeenCalledTimes(4);
    expect(src.instantCacheStats).toMatchObject({ hits: 8, entries: 4, pinned: 1 });
  });
  it('coalesces active tile requests while allowing one consumer to cancel', async () => {
    const src = source(), image = createCanvas(256, 256) as any;
    image.close = vi.fn();
    let finish!: (value: any) => void;
    draw.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as any);
    const first = request(src), second = request(src);
    await vi.waitFor(() => expect(draw).toHaveBeenCalledOnce());
    first.context.abort();
    finish(image);
    expect((await first.result).error).toContain('cancelled');
    expect((await second.result).value.canvas.width).toBe(256);
    expect(image.close).toHaveBeenCalledOnce();
    await request(src).result;
    expect(draw).toHaveBeenCalledOnce();
  });
  it('shares one hard byte budget while isolating pixels belonging to distinct sources', async () => {
    const cache = new InstantTerrainCache(256 * 256 * 4);
    const first = source(new AbortController(), vi.fn(), cache);
    const second = source(new AbortController(), vi.fn(), cache);
    await request(first).result;
    await request(second).result;
    expect(draw).toHaveBeenCalledTimes(2);
    expect(cache.stats).toMatchObject({ bytes: 256 * 256 * 4, entries: 1, evictions: 1 });
    await request(second).result;
    expect(draw).toHaveBeenCalledTimes(2);
    await request(first).result;
    expect(draw).toHaveBeenCalledTimes(3);
    expect(cache.stats.bytes).toBeLessThanOrEqual(cache.maxBytes);
    cache.clear();
  });
  it('keeps completed overviews when detail exceeds the cache budget', async () => {
    const cache = new InstantTerrainCache(256 * 256 * 4);
    const src = source(new AbortController(), vi.fn(), cache);
    await request(src, 8).result;
    for (const x of [0, 1, 2]) await request(src, src.maxLevel, x).result;
    const before = draw.mock.calls.length;
    await request(src, 8).result;
    expect(draw).toHaveBeenCalledTimes(before);
    expect(cache.stats.pinned).toBe(1);
    expect(cache.stats.bytes).toBeLessThanOrEqual(cache.maxBytes);
    cache.clear();
  });
  it('releases completed terrain on reseed without destroying tiles OSD still owns', async () => {
    const v = viewer();
    await addInstantTerrain(v, gen, deps, [], () => true, vi.fn(), vi.fn(), vi.fn());
    const old = v.items[0].source;
    const prior = (await request(old).result).value;
    expect(old.instantCacheStats.entries).toBe(1);
    await addInstantTerrain(v, { ...gen, seed: 43, tileLayers: [] }, deps, [], () => true, vi.fn(), vi.fn(), vi.fn());
    expect(old.instantCacheStats.bytes).toBe(0);
    expect(prior.canvas.width).toBe(256);
    const latest = v.items[9].source;
    await request(latest).result;
    expect(draw).toHaveBeenCalledTimes(2);
    clearInstantTerrain();
    expect(latest.instantCacheStats.bytes).toBe(0);
  });
  it('reprioritizes coverage, current resolution and visible tiles as the destination zoom changes', () => {
    let bounds = { x: region.x, y: region.y, width: 512, height: 512 };
    const viewport = { getBounds: () => bounds, getCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
      getContainerSize: () => ({ x: 512, y: 512 }) };
    const detail = instantTileView(region, { level: 17, x: 0, y: 0 }, 35, 70)!;
    const coarse = instantTileView(region, { level: 14, x: 0, y: 0 }, 35, 70)!;
    const overview = instantTileView(region, { level: 8, x: 0, y: 0 }, 35, 70)!;
    const offscreen = instantTileView(region, { level: 17, x: 20, y: 0 }, 35, 70)!;
    const rank = (view: any) => instantTilePriority(view, region, viewport);
    expect(rank(overview)).toBeLessThan(rank(detail));
    expect(rank(detail)).toBeLessThan(rank(coarse));
    expect(rank(coarse)).toBeLessThan(rank(offscreen));
    bounds = { ...bounds, width: 4096, height: 4096 };
    expect(rank(coarse)).toBeLessThan(rank(detail));
  });
  it('matches OSD pixel density when choosing which queued resolution to draw first', () => {
    const bounds = { x: region.x, y: region.y, width: 1024, height: 1024 };
    const viewport = { getBounds: () => bounds, getCenter: () => ({ x: bounds.x + 512, y: bounds.y + 512 }),
      getContainerSize: () => ({ x: 512, y: 512 }) };
    const fine = instantTileView(region, { level: 17, x: 0, y: 0 }, 35, 70)!;
    const lower = instantTileView(region, { level: 16, x: 0, y: 0 }, 35, 70)!;
    const osd = (globalThis as any).OpenSeadragon;
    const rank = (view: any) => instantTilePriority(view, region, viewport);
    osd.pixelDensityRatio = 1;
    expect(rank(lower)).toBeLessThan(rank(fine));
    osd.pixelDensityRatio = 2;
    expect(rank(fine)).toBeLessThan(rank(lower));
  });
  it("reports GPU failure and never caches a blank tile as a successful result", async () => {
    const failed = vi.fn(),
      src = source(new AbortController(), failed);
    draw.mockImplementationOnce(() => null as any);
    expect((await request(src).result).error).toContain("context lost");
    expect(failed).toHaveBeenCalledOnce();
  });
  it('does not rebuild the visible old seed when early preparation replaces its resources', async () => {
    const v = viewer(), fallback = vi.fn();
    await addInstantTerrain(v, gen, deps, [], () => true, vi.fn(), vi.fn(), fallback);
    const oldSource = v.items[0].source;
    await prepareInstantTerrain({ ...gen, seed: 43, tileLayers: [] }, deps);
    const job = request(oldSource);
    expect((await job.result).error).toContain('Obsolete');
    expect(job.context.finish).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(v.items).toHaveLength(9);
  });
  it("preserves static chunks and exact scene mask holes at detail resolution", () => {
    const clip = createInstantClip(
      [owner(false), owner(true), owner(false)],
      [
        {
          x: -17920,
          y: WORLD_TOP,
          width: 4,
          height: 1,
          bits: new Uint8Array([1]),
          airBits: new Uint8Array([4]),
        },
      ],
    );
    const canvas = createCanvas(4, 2),
      ctx = canvas.getContext("2d");
    const view = instantTileView(
      { x: -17920, y: WORLD_TOP - 1, width: 4, height: 2, pw: 0 },
      { level: 2, x: 0, y: 0 },
      35,
      70,
    )!;
    clip.draw(ctx as any, draw(view) as any, view);
    const rgba = ctx.getImageData(0, 0, 4, 2).data;
    expect(Array.from(rgba).filter((_, i) => i % 4 === 3)).toEqual([
      0, 0, 0, 0, 0, 255, 0, 255,
    ]);
    clip.dispose();
  });
  it("shares one resource upload across three worlds, and reports paint only after a terrain tile is drawn", async () => {
    const v = viewer(),
      painted = vi.fn();
    expect(
      await addInstantTerrain(
        v,
        gen,
        deps,
        [],
        () => true,
        vi.fn(),
        painted,
        vi.fn(),
      ),
    ).toBe(true);
    expect(build).toHaveBeenCalledOnce();
    expect(v.items).toHaveLength(9);
    expect(painted).not.toHaveBeenCalled();
    v.emit("tile-drawn", { tiledImage: { source: {} } });
    expect(painted).not.toHaveBeenCalled();
    v.emit("tile-drawn", { tiledImage: v.items[0] });
    v.emit("tile-drawn", { tiledImage: v.items[1] });
    expect(painted).toHaveBeenCalledOnce();
    clearInstantTerrain();
    expect(v.handlers.get("tile-drawn").size).toBe(0);
  });
  it("builds heaven resources only when its terrain is requested and shares that build across horizontal worlds", async () => {
    const v = viewer();
    await addInstantTerrain(
      v,
      gen,
      deps,
      [],
      () => true,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(build).toHaveBeenCalledOnce();
    const sources = v.items.filter(
      (item: any) => item.source.instantRegion.y === WORLD_TOP - WORLD_HEIGHT,
    );
    await Promise.all(
      sources.map((item: any) => request(item.source, 8).result),
    );
    expect(build).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenCalledTimes(3);
  });
  it("handles lazy plane initialization failure even after every dependent tile was cancelled", async () => {
    const v = viewer(), fallback = vi.fn();
    let rejectAtlas!: (error: Error) => void;
    const initMaterialAtlas = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectAtlas = reject; }));
    await addInstantTerrain(v, gen, { ...deps, initMaterialAtlas }, [],
      () => true, vi.fn(), vi.fn(), fallback);
    const jobs = v.items.filter((item: any) => item.source.instantRegion.y === WORLD_TOP - WORLD_HEIGHT)
      .map((item: any) => request(item.source, 8));
    await vi.waitFor(() => expect(rejectAtlas).toBeTypeOf("function"));
    expect(initMaterialAtlas).toHaveBeenCalledTimes(2);
    // The OSD timeout wrapper takes the same cleanup path. All three tile
    // subscribers are settled before their shared initialization fails.
    for (const job of jobs) job.context.abort();
    await Promise.all(jobs.map((job: any) => job.result));
    expect(fallback).not.toHaveBeenCalled();
    rejectAtlas(new Error("Heaven resource initialization failed"));
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledOnce());
    expect(String(fallback.mock.calls[0][0])).toContain("Heaven resource initialization failed");
    expect(v.items).toHaveLength(0);
    for (const job of jobs) {
      expect(job.context.fail).toHaveBeenCalledOnce();
      expect(job.context.finish).not.toHaveBeenCalled();
    }
  });
  it("cannot upload or attach an obsolete seed after awaiting the atlas", async () => {
    const v = viewer();
    let release!: () => void;
    const pending = addInstantTerrain(
      v,
      gen,
      {
        ...deps,
        initMaterialAtlas: () => new Promise<void>((r) => (release = r)),
      },
      [],
      () => true,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    clearInstantTerrain();
    release();
    await cancelled;
    expect(build).not.toHaveBeenCalled();
    expect(v.items).toHaveLength(0);
  });
  it('rejects superseded initial preparation instead of selecting approximate fallback', async () => {
    const v = viewer(), fallback = vi.fn();
    let release!: () => void;
    const initial = addInstantTerrain(v, gen, {
      ...deps, initMaterialAtlas: () => new Promise<void>(resolve => { release = resolve; }),
    }, [], () => true, vi.fn(), vi.fn(), fallback);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancelled = expect(initial).rejects.toMatchObject({ name: 'AbortError' });
    const replacement = prepareInstantTerrain({ ...gen, seed: 43, tileLayers: [] }, deps);
    release();
    await cancelled;
    await replacement;
    expect(build).toHaveBeenCalledOnce();
    expect(v.items).toHaveLength(0);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("falls back once and removes failed GPU layers after context loss", async () => {
    const v = viewer(),
      fallback = vi.fn();
    await addInstantTerrain(
      v,
      gen,
      deps,
      [],
      () => true,
      vi.fn(),
      vi.fn(),
      fallback,
    );
    const src = v.items[0].source;
    draw.mockImplementationOnce(() => null as any);
    expect((await request(src).result).error).toContain("context lost");
    expect(fallback).toHaveBeenCalledOnce();
    expect(v.items).toHaveLength(0);
    expect((await request(src).result).error).toContain("cancelled");
    expect(fallback).toHaveBeenCalledOnce();
  });
});
