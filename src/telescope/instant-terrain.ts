import Flatbush from "flatbush";
import type {
  GLTerrainDeps,
  GLTerrainGeneration,
} from "./gl-terrain-tile-source";
import {
  createPlaneOwnership,
  WORLD_HEIGHT,
  WORLD_TOP,
  type TerrainOwnership,
  type VerticalPlane,
} from "./terrain-policy";
import type { StaticTerrainMask } from "./static-terrain-mask";
import { scheduleTerrainWork } from "./terrain-work-queue";
import { setTerrainPlane } from "./instant-terrain-plane";
import { prepareInstantTerrain } from "./instant-terrain-backend";
import { smoothInstantTile } from "../osd-pixel-rendering";
import { InstantTerrainCache, copyTerrainContext } from "./instant-terrain-cache";
import { createInstantCoverage, INSTANT_COVERAGE_EXTRA_LEVELS } from "./instant-terrain-coverage";
export { smoothInstantTile } from "../osd-pixel-rendering";

declare const OpenSeadragon: any;
export const INSTANT_TILE_SIZE = 256;
export const INSTANT_MAX_RENDER_SIZE = 512;
let nextId = 0;

export interface InstantRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pw: number;
}
export interface InstantTile {
  level: number;
  x: number;
  y: number;
}

/** A coarse tile is shaded at its own display resolution. It never requests
 * full-resolution descendants, which made the old overview cost billions of pixels. */
export function instantTileView(
  region: InstantRegion,
  tile: InstantTile,
  center: number,
  mapWidth: number,
) {
  const maxLevel = Math.ceil(Math.log2(Math.max(region.width, region.height)));
  if (
    ![tile.level, tile.x, tile.y].every(Number.isInteger) ||
    tile.level < 0 ||
    tile.level > maxLevel ||
    tile.x < 0 ||
    tile.y < 0
  )
    return null;
  const scale = 2 ** (maxLevel - tile.level);
  const width = Math.min(
    INSTANT_TILE_SIZE,
    Math.ceil(region.width / scale) - tile.x * INSTANT_TILE_SIZE,
  );
  const height = Math.min(
    INSTANT_TILE_SIZE,
    Math.ceil(region.height / scale) - tile.y * INSTANT_TILE_SIZE,
  );
  if (width <= 0 || height <= 0) return null;
  const x = region.x + tile.x * INSTANT_TILE_SIZE * scale;
  const y = region.y + tile.y * INSTANT_TILE_SIZE * scale;
  return {
    x,
    y,
    scale,
    width,
    height,
    camX: x + (width * scale) / 2 + center * 512 - region.pw * mapWidth * 512,
    camY: y + (height * scale) / 2 + 14 * 512,
    camZ: 1 / scale,
    pw: region.pw,
    pwVertical: 0,
    edgeNoise: true,
    materialTextures: true,
    engineTerrain: true,
  };
}

/** A reduced map pixel represents an area, not one arbitrary world pixel.
 * Bound sampling to one 512px draw; never recurse to native-resolution tiles. */
export function instantSampleView(view: NonNullable<ReturnType<typeof instantTileView>>) {
  const factor = Math.min(view.scale, 4,
    2 ** Math.floor(Math.log2(INSTANT_MAX_RENDER_SIZE / Math.max(view.width, view.height))));
  return { ...view, width: view.width * factor, height: view.height * factor,
    scale: view.scale / factor, camZ: view.camZ * factor, sampleFactor: factor };
}

/** Repeated exact 2:1 reductions integrate all samples instead of selecting
 * four texels from a larger reduction. Canvas performs the premultiplied-alpha
 * filtering, preserving thin terrain and partially covered cave boundaries. */
export function reduceInstantTile(image: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  let source = image;
  while (source.width > width || source.height > height) {
    const reduced = document.createElement('canvas');
    reduced.width = Math.max(width, source.width / 2);
    reduced.height = Math.max(height, source.height / 2);
    const context = reduced.getContext('2d')!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'low';
    context.drawImage(source, 0, 0, source.width, source.height, 0, 0, reduced.width, reduced.height);
    source.width = source.height = 0;
    source = reduced;
  }
  return source.getContext('2d')!;
}

/** Preserve the existing static-map ownership and the exact authored scene
 * material/force-air masks. Empty PNG pixels do not erase a rectangular room. */
export function createInstantClip(
  owners: TerrainOwnership[],
  masks: StaticTerrainMask[],
) {
  const index = masks.length ? new Flatbush(masks.length) : null;
  for (const mask of masks)
    index!.add(mask.x, mask.y, mask.x + mask.width, mask.y + mask.height);
  index?.finish();
  const bitmaps = new Map<Uint8Array, HTMLCanvasElement>();
  let bytes = 0;
  const bitmap = (mask: StaticTerrainMask) => {
    let canvas = bitmaps.get(mask.bits);
    if (canvas) {
      bitmaps.delete(mask.bits);
      bitmaps.set(mask.bits, canvas);
      return canvas;
    }
    canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(mask.width, mask.height);
    for (let p = 0; p < mask.width * mask.height; p++)
      if (
        ((mask.bits[p >> 3] ?? 0) | (mask.airBits?.[p >> 3] ?? 0)) &
        (1 << (p & 7))
      )
        image.data[p * 4 + 3] = 255;
    ctx.putImageData(image, 0, 0);
    bitmaps.set(mask.bits, canvas);
    bytes += mask.width * mask.height * 4;
    while (bytes > 32 * 1024 * 1024 && bitmaps.size > 1) {
      const [key, old] = bitmaps.entries().next().value!;
      bytes -= old.width * old.height * 4;
      bitmaps.delete(key);
      old.width = old.height = 0;
    }
    return canvas;
  };
  return {
    draw(
      ctx: CanvasRenderingContext2D,
      image: CanvasImageSource,
      view: NonNullable<ReturnType<typeof instantTileView>>,
    ) {
      const { x, y, scale, width, height } = view;
      ctx.save();
      ctx.beginPath();
      for (let p = 0; p < owners.length; p++) {
        const owner = owners[p],
          planeY = WORLD_TOP + (p - 1) * WORLD_HEIGHT;
        const cy0 = Math.max(0, Math.floor((y - planeY) / 512));
        const cy1 = Math.min(
          47,
          Math.floor((y + height * scale - 1 - planeY) / 512),
        );
        const cx0 = Math.floor((x + owner.width * 256) / 512);
        const cx1 = Math.floor(
          (x + width * scale - 1 + owner.width * 256) / 512,
        );
        for (let cy = cy0; cy <= cy1; cy++) {
          let start = -Infinity;
          for (let cx = cx0; cx <= cx1 + 1; cx++) {
            const localX = ((cx % owner.width) + owner.width) % owner.width;
            const owns =
              cx <= cx1 && owner.owners[cy * owner.width + localX] >= 0;
            if (owns && start === -Infinity) start = cx;
            if (!owns && start !== -Infinity) {
              ctx.rect(
                (start * 512 - owner.width * 256 - x) / scale,
                (planeY + cy * 512 - y) / scale,
                ((cx - start) * 512) / scale,
                512 / scale,
              );
              start = -Infinity;
            }
          }
        }
      }
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.imageSmoothingEnabled = false;
      for (const id of index?.search(
        x,
        y,
        x + width * scale,
        y + height * scale,
      ) ?? []) {
        const mask = masks[id];
        ctx.drawImage(
          bitmap(mask),
          (mask.x - x) / scale,
          (mask.y - y) / scale,
          mask.width / scale,
          mask.height / scale,
        );
      }
      ctx.restore();
    },
    dispose() {
      for (const canvas of bitmaps.values()) canvas.width = canvas.height = 0;
      bitmaps.clear();
      bytes = 0;
    },
  };
}

export function createInstantTileSource(options: {
  region: InstantRegion;
  deps: GLTerrainDeps;
  gen: GLTerrainGeneration;
  renderer?: any;
  getRenderer?: () => Promise<any>;
  plane?: VerticalPlane;
  clip: ReturnType<typeof createInstantClip>;
  signal: AbortSignal;
  onFailure: (error: unknown) => void;
  focus?: () => { x: number; y: number };
  priority?: (view: NonNullable<ReturnType<typeof instantTileView>>) => number;
  cache?: InstantTerrainCache;
  onTile?: (pixels: number, milliseconds: number) => void;
}) {
  const { region, signal } = options;
  const source = new OpenSeadragon.TileSource({
    width: region.width,
    height: region.height,
    tileSize: INSTANT_TILE_SIZE,
    minLevel: 0,
    maxLevel: Math.ceil(Math.log2(Math.max(region.width, region.height))),
  });
  const id = ++nextId;
  const cache = options.cache ?? new InstantTerrainCache();
  const overviewLevel = typeof source.getClosestLevel === 'function'
    ? source.getClosestLevel() : Math.min(source.maxLevel, Math.log2(INSTANT_TILE_SIZE));
  const coverageMaxLevel = Math.min(source.maxLevel, overviewLevel + INSTANT_COVERAGE_EXTRA_LEVELS);
  type TileWork = {
    controller: AbortController;
    subscribers: number;
    completed: boolean;
    promise: Promise<CanvasRenderingContext2D>;
  };
  const pending = new Map<string, TileWork>();
  signal.addEventListener('abort', () => {
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
    if (!options.cache) cache.clear();
  }, { once: true });
  source.__instantTerrain = true;
  source.instantRegion = region;
  Object.defineProperty(source, 'instantCacheStats', { get: () => cache.stats });
  source.getTileUrl = (level: number, x: number, y: number) =>
    `instant-terrain://${id}/${level}/${x}/${y}`;
  source.hasCachedTile = (tile: InstantTile) =>
    cache.has(source.getTileUrl(tile.level, tile.x, tile.y));
  source.hasTransparency = () => true;
  const render = (tile: InstantTile, view: NonNullable<ReturnType<typeof instantTileView>>, key: string) => {
    const controller = new AbortController();
    const work: TileWork = { controller, subscribers: 0, completed: false, promise: null! };
    const sampled = instantSampleView(view);
    const priority = () => {
      if (options.priority) return options.priority(view);
      const focus = options.focus?.();
      return focus ? Math.hypot(
        view.x + (view.width * view.scale) / 2 - focus.x,
        view.y + (view.height * view.scale) / 2 - focus.y,
      ) : 0;
    };
    work.promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return options.getRenderer?.() ?? options.renderer;
      })
      .then((renderer) => scheduleTerrainWork(() => {
        const started = performance.now();
        if (options.plane !== undefined) setTerrainPlane(renderer, options.plane);
        const finish = (rendered: any) => {
          try {
            controller.signal.throwIfAborted();
            if (!rendered) throw new Error(renderer.failed || "GPU terrain context lost");
            const error = renderer.gl?.getError?.();
            if (error) throw new Error(`GPU terrain draw failed: 0x${error.toString(16)}`);
            const canvas = document.createElement("canvas");
            canvas.width = sampled.width; canvas.height = sampled.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Terrain tile canvas unavailable");
            options.clip.draw(ctx, rendered, sampled);
            const result = reduceInstantTile(canvas, view.width, view.height);
            // The cache owns a separate copy: OSD destroys its canvas on eviction.
            cache.set(key, result, tile.level >= overviewLevel && tile.level <= coverageMaxLevel);
            options.onTile?.(sampled.width * sampled.height, performance.now() - started);
            return result;
          } finally { rendered?.close?.(); }
        };
        const rendered = renderer.render(sampled, controller.signal);
        return typeof rendered?.then === 'function' ? rendered.then(finish) : finish(rendered);
      }, controller.signal, priority))
      .finally(() => {
        work.completed = true;
        if (pending.get(key) === work) pending.delete(key);
      });
    pending.set(key, work);
    return work;
  };
  source.downloadTileStart = (context: any) => {
    // OSD may retry the same ImageJob after a timeout. Retire its earlier
    // subscriber and retain the original loader callback, not an older wrapper.
    const previous = context.userData;
    previous?.abort?.();
    const loaderCallback = previous?.loaderCallback ?? context.callback;
    let settled = false;
    let release = () => {};
    const cleanupAbort = () => {
      settled = true;
      release();
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (settled) return;
      cleanupAbort();
      context.fail("Terrain request cancelled");
    };
    // ImageJob.abort() invokes downloadTileAbort and then fails its own job.
    // Only seed-lifetime cancellation must settle the loader here.
    context.userData = { abort: cleanupAbort, loaderCallback };
    if (typeof loaderCallback === 'function') {
      let delivered = false;
      context.callback = (...args: any[]) => {
        if (delivered) return;
        delivered = true;
        // Timeouts originate inside ImageJob, bypassing downloadTileAbort.
        // Release their work immediately and ignore late render completion.
        cleanupAbort();
        loaderCallback.apply(context, args);
      };
    }
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    const view = instantTileView(
      region,
      context.tile,
      options.deps.getWorldCenter(options.gen.isNGP, options.gen.gameMode),
      options.deps.getWorldSize(options.gen.isNGP, options.gen.gameMode),
    );
    if (!view) {
      cancel();
      return;
    }
    const key = source.getTileUrl(context.tile.level, context.tile.x, context.tile.y);
    let hit: CanvasRenderingContext2D | undefined;
    try { hit = cache.get(key); }
    catch (error) {
      settled = true;
      signal.removeEventListener('abort', cancel);
      context.fail(String(error));
      options.onFailure(error);
      return;
    }
    let result: Promise<CanvasRenderingContext2D>;
    if (hit) result = Promise.resolve(hit);
    else {
      const work = pending.get(key) ?? render(context.tile, view, key);
      work.subscribers++;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        if (--work.subscribers === 0 && !work.completed) {
          work.controller.abort();
          if (pending.get(key) === work) pending.delete(key);
        }
      };
      // Every consumer gets independently owned pixels, including simultaneous
      // overview/detail requests. Cancelling one does not cancel the others.
      result = work.promise.then(ctx => settled ? ctx : copyTerrainContext(ctx));
    }
    void result
      .then((ctx) => {
        if (settled) return;
        settled = true;
        context.finish(ctx, null, "context2d");
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        context.fail(String(error));
        // Early preparation can replace the GPU resources while the previous
        // seed's cached tiles are still visible. Supersession is cancellation,
        // not a GPU failure that should rebuild the old seed approximately.
        if (!signal.aborted && error?.name !== 'AbortError')
          options.onFailure(error);
      })
      .finally(() => {
        release();
        signal.removeEventListener("abort", cancel);
      });
  };
  source.downloadTileAbort = (context: any) => context.userData?.abort();
  return source;
}

let active: (() => void) | null = null;
export function clearInstantTerrain() {
  active?.();
  active = null;
}

/** Rank work against the latest camera destination each time a queue slot
 * opens. Old detail requests remain cheap queued metadata, not worker backlog. */
export function instantTilePriority(
  view: NonNullable<ReturnType<typeof instantTileView>>,
  region: InstantRegion,
  viewport: any,
): number {
  const bounds = viewport.getBounds?.(false);
  const center = viewport.getCenter(false);
  const width = view.width * view.scale, height = view.height * view.scale;
  const distance = Math.hypot(view.x + width / 2 - center.x, view.y + height / 2 - center.y);
  if (!bounds || !Number.isFinite(bounds.width) || bounds.width <= 0) return distance;
  const visible = view.x < bounds.x + bounds.width && view.x + width > bounds.x
    && view.y < bounds.y + bounds.height && view.y + height > bounds.y;
  const overview = width >= region.width && height >= region.height;
  if (overview) return (visible ? -1e9 : 1e9) + distance;
  const screenWidth = viewport.getContainerSize?.().x ?? 1024;
  const density = (typeof OpenSeadragon !== 'undefined' && OpenSeadragon.pixelDensityRatio)
    || globalThis.devicePixelRatio || 1;
  const ratio = view.scale * screenWidth * density / bounds.width;
  const levelDistance = Number.isFinite(ratio) && ratio > 0 ? Math.abs(Math.log2(ratio)) : 0;
  return (visible ? 0 : 2e9) + levelDistance * 1e6 + distance;
}

/** OSD retains camera transforms, layer ordering, tile caching and screenshots.
 * Detail is requested on demand; small retained overviews cover every region. */
export async function addInstantTerrain(
  viewer: any,
  gen: GLTerrainGeneration & { parallelWorlds?: number[] },
  deps: GLTerrainDeps,
  masks: StaticTerrainMask[],
  isCurrent: () => boolean,
  onItem: (item: any) => void,
  firstPaint: () => void,
  fallback: (error: unknown) => void,
): Promise<boolean> {
  clearInstantTerrain();
  const lifetime = new AbortController();
  const cache = new InstantTerrainCache();
  const items: any[] = [];
  const sources = new Set<any>();
  let clip: ReturnType<typeof createInstantClip> | null = null;
  let failed = false,
    painted = false;
  const stats = {
    backend: "pending",
    shaderWarmupMs: 0,
    resourceMs: 0,
    planes: 0,
    tiles: 0,
    shadedPixels: 0,
    tileMs: 0,
    firstDrawMs: 0,
  };
  const planeResources = new Map<VerticalPlane, Promise<any>>();
  const ownedRenderers = new Set<any>();
  const start = performance.now();
  const osd = viewer.viewer || viewer;
  const coverage = createInstantCoverage(osd, lifetime.signal);
  Object.defineProperty(stats, 'cache', { enumerable: true, get: () => cache.stats });
  Object.assign(stats, { coverage: coverage.stats });
  const onDraw = (event: any) => {
    if (painted || !sources.has(event.tiledImage?.source) || !isCurrent())
      return;
    painted = true;
    stats.firstDrawMs = performance.now() - start;
    osd.removeHandler("tile-drawn", onDraw);
    firstPaint();
    coverage.start();
    console.info("[Instant terrain] First tile drawn", stats);
  };
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    cache.clear();
    clip?.dispose();
    osd.removeHandler("tile-drawn", onDraw);
    osd.removeHandler("tile-drawing", smoothInstantTile);
    for (const renderer of ownedRenderers) renderer.invalidate();
  };
  active = dispose;
  const fail = (error: unknown) => {
    if (failed || lifetime.signal.aborted || !isCurrent()) return;
    failed = true;
    dispose();
    for (const item of items) osd.world.removeItem(item);
    fallback(error);
  };
  const getRenderer = (plane: VerticalPlane): Promise<any> => {
    const existing = planeResources.get(plane);
    if (existing) return existing;
    const pending = (async () => {
      const renderer = await prepareInstantTerrain(gen, deps, plane, lifetime.signal);
      if (lifetime.signal.aborted || !isCurrent()) {
        renderer.invalidate();
        throw new DOMException("Obsolete terrain generation", "AbortError");
      }
      ownedRenderers.add(renderer);
      lifetime.signal.throwIfAborted();
      stats.resourceMs += renderer.resourceMs ?? 0;
      stats.backend = renderer.backend ?? "main";
      stats.shaderWarmupMs = Math.max(stats.shaderWarmupMs, renderer.shaderWarmupMs ?? 0);
      stats.planes++;
      return renderer;
    })().catch(error => {
      // Lazy plane preparation belongs to the generation, not an individual
      // ImageJob: every waiting tile may already have timed out or cancelled.
      // Main-plane failure still uses the initial false-return fallback below.
      if (plane !== 0 && error?.name !== 'AbortError') fail(error);
      throw error;
    });
    planeResources.set(plane, pending);
    return pending;
  };
  try {
    await getRenderer(0);
    if (!isCurrent() || lifetime.signal.aborted)
      throw new DOMException("Obsolete terrain generation", "AbortError");
    const width = deps.getWorldSize(gen.isNGP, gen.gameMode);
    const owners = [-1, 0, 1].map((plane) =>
      createPlaneOwnership(
        gen.tileLayers,
        gen.biomeData.pixels,
        (plane < 0
          ? gen.biomeData.heavenPixels
          : plane > 0
            ? gen.biomeData.hellPixels
            : gen.biomeData.pixels) ?? gen.biomeData.pixels,
        deps.GENERATOR_CONFIG,
        width,
      ),
    );
    clip = createInstantClip(owners, masks);
    osd.addHandler("tile-drawn", onDraw);
    osd.addHandler("tile-drawing", smoothInstantTile);
    for (const plane of [0, -1, 1] as VerticalPlane[])
      for (const pw of [...(gen.parallelWorlds ?? [0, -1, 1])].sort(
        (a, b) => Math.abs(a) - Math.abs(b),
      )) {
        const region = {
          x: -width * 256 + pw * width * 512,
          y: WORLD_TOP + plane * WORLD_HEIGHT,
          width: width * 512,
          height: WORLD_HEIGHT,
          pw,
        };
        const source = createInstantTileSource({
          region,
          deps,
          gen,
          getRenderer: () => getRenderer(plane),
          plane,
          clip,
          cache,
          signal: lifetime.signal,
          onFailure: fail,
          focus: () => osd.viewport.getCenter(true),
          priority: view => instantTilePriority(view, region, osd.viewport),
          onTile(pixels, ms) {
            stats.tiles++;
            stats.shadedPixels += pixels;
            stats.tileMs += ms;
          },
        });
        source.instantStats = stats;
        sources.add(source);
        viewer.addTiledImage({
          tileSource: source,
          x: region.x,
          y: region.y,
          width: region.width,
          blendTime: 0,
          success({ item }: any) {
            if (!isCurrent() || lifetime.signal.aborted) {
              osd.world.removeItem(item);
              return;
            }
            items.push(item);
            coverage.add(item);
            onItem(item);
          },
          error: fail,
        });
      }
    window.dispatchEvent(
      new CustomEvent("biomeGenerationProgress", {
        detail: { percentage: 100 },
      }),
    );
    return true;
  } catch (error) {
    dispose();
    // False means unsupported GPU and asks the bridge to build approximate
    // terrain. A superseded seed must instead leave the presentation pipeline.
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") throw error;
    if (isCurrent())
      console.warn("[Instant terrain] Using approximate terrain:", error);
    return false;
  }
}
