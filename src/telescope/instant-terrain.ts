import { createInstantClip } from "./instant-terrain-clip";
import { createInstantTerrainViewport } from "./instant-terrain-viewport";
import { afterMapHandoff } from './map-handoff';
import { createRetainedViewportRenderer } from "./retained-viewport-renderer";
import { getMapMemoryBudget } from '../map-memory-budget';
export { createInstantClip } from "./instant-terrain-clip";
import type {
  GLTerrainDeps,
  GLTerrainGeneration,
} from "./gl-terrain-tile-source";
import {
  createPlaneOwnership,
  WORLD_HEIGHT,
  WORLD_TOP,
  type VerticalPlane,
} from "./terrain-policy";
import type { StaticTerrainMask } from "./static-terrain-mask";
import { scheduleTerrainWork, wakeTerrainWorkQueue } from "./terrain-work-queue";
import { setTerrainPlane } from "./instant-terrain-plane";
import { prepareInstantTerrain } from "./instant-terrain-backend";
import { smoothInstantTile } from "../osd-pixel-rendering";
import { InstantTerrainCache, copyTerrainContext } from "./instant-terrain-cache";
import { createInstantCoverage, INSTANT_COVERAGE_EXTRA_LEVELS } from "./instant-terrain-coverage";
import { RetainedTerrain, retainedTerrainIdentity, type RetainedTerrainRegion, type RetainedTile } from './retained-terrain';
import { createInstantTerrainCooker } from './instant-terrain-cooker';
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

export function createInstantTileSource(options: {
  region: InstantRegion;
  deps: GLTerrainDeps;
  gen: GLTerrainGeneration;
  renderer?: any;
  getRenderer?: () => Promise<any>;
  /** The direct viewport has already installed ownership/scene masks in the worker. */
  workerClipping?: boolean;
  plane?: VerticalPlane;
  clip: Omit<ReturnType<typeof createInstantClip>, 'hasTerrain'> & Partial<Pick<ReturnType<typeof createInstantClip>, 'hasTerrain'>>;
  signal: AbortSignal;
  onFailure: (error: unknown) => void;
  focus?: () => { x: number; y: number };
  priority?: (view: NonNullable<ReturnType<typeof instantTileView>>) => number;
  cache?: InstantTerrainCache;
  retention?: RetainedTerrainRegion;
  onRetainedTiles?: (tiles: RetainedTile[]) => void;
  onTile?: (pixels: number, milliseconds: number) => void;
}) {
  const { region, signal } = options;
  const memory = getMapMemoryBudget();
  const id = ++nextId;
  // Standalone callers have no scene-mask identity. Keep their retention local
  // rather than persisting a session counter that collides after a page reload.
  const ownedRetention = options.retention ? undefined : new RetainedTerrain({
    read: async () => undefined,
    write: async () => { throw new Error('Session-only terrain retention'); },
  }, memory.retainedTerrainBytes);
  const retention = options.retention ?? ownedRetention!.region(`session-${id}`, region.width, region.height);
  const source = new OpenSeadragon.TileSource({
    width: region.width,
    height: region.height,
    tileSize: INSTANT_TILE_SIZE,
    minLevel: retention.minLevel,
    maxLevel: Math.ceil(Math.log2(Math.max(region.width, region.height))),
  });
  const cache = options.cache ?? new InstantTerrainCache(memory.terrainCacheBytes);
  const overviewLevel = typeof source.getClosestLevel === 'function'
    ? source.getClosestLevel() : Math.min(source.maxLevel, Math.log2(INSTANT_TILE_SIZE));
  const coverageMaxLevel = Math.min(source.maxLevel, overviewLevel + INSTANT_COVERAGE_EXTRA_LEVELS);
  type TileWork = {
    controller: AbortController;
    subscribers: number;
    foregroundSubscribers: number;
    completed: boolean;
    background: boolean;
    context?: CanvasRenderingContext2D;
    promise: Promise<CanvasRenderingContext2D>;
  };
  const pending = new Map<string, TileWork>();
  const preparedNativeTiles = new Set<string>();
  const unsubscribe = retention.subscribe(tiles => options.onRetainedTiles?.(tiles));
  signal.addEventListener('abort', () => {
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
    preparedNativeTiles.clear();
    if (!options.cache) cache.clear();
    unsubscribe();
    ownedRetention?.dispose();
  }, { once: true });
  source.__instantTerrain = true;
  Object.defineProperty(source, 'isDisposed', { get: () => signal.aborted });
  source.instantRegion = region;
  source.applyRetainedTerrain = (tile: InstantTile, context: CanvasRenderingContext2D) => retention.apply(tile, context);
  Object.defineProperty(source, 'retainedRevision', { get: () => retention.revision });
  Object.defineProperty(source, 'retainedTerrainStats', { get: () => retention.owner.stats });
  Object.defineProperty(source, 'instantCacheStats', { get: () => cache.stats });
  source.getTileUrl = (level: number, x: number, y: number) =>
    `instant-terrain://${id}/${level}/${x}/${y}`;
  source.hasCachedTile = (tile: InstantTile) =>
    cache.has(source.getTileUrl(tile.level, tile.x, tile.y)) || retention.hasComplete(tile);
  source.hasTransparency = () => true;
  const subscribeWork = (work: TileWork, foreground = false) => {
    work.subscribers++;
    if (foreground) work.foregroundSubscribers++;
    wakeTerrainWorkQueue();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (foreground) work.foregroundSubscribers--;
      wakeTerrainWorkQueue();
      if (--work.subscribers !== 0) return;
      if (!work.completed) work.controller.abort();
      else if (work.context) work.context.canvas.width = work.context.canvas.height = 0;
    };
  };
  const render = (tile: InstantTile, view: NonNullable<ReturnType<typeof instantTileView>>, key: string, background = false) => {
    const controller = new AbortController();
    const work: TileWork = { controller, subscribers: 0, foregroundSubscribers: 0, completed: false, background, promise: null! };
    const isBackground = () => work.foregroundSubscribers === 0;
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
      .then(async () => {
        controller.signal.throwIfAborted();
        // Disk batches can be interrupted between a native leaf and its
        // ancestors. Replay saved native pixels to repair the whole pyramid;
        // a saved parent alone is not proof its native children survived.
        // A cold miss needs no temporary 512px canvas or PNG decode.
        const hasNative = background && await retention.contains({ level: source.maxLevel,
          x: (sampled.x - region.x) / INSTANT_TILE_SIZE,
          y: (sampled.y - region.y) / INSTANT_TILE_SIZE });
        const native = hasNative
          ? await retention.native(sampled.x - region.x, sampled.y - region.y, sampled.width, sampled.height)
          : undefined;
        const retained = !background ? await retention.complete(tile) : undefined;
        controller.signal.throwIfAborted();
        if (native) return { native };
        if (retained) return { retained };
        // Static-map ownership is an exact empty terrain result. A background
        // sweep need not shade pixels that clipping would remove completely.
        if (work.background && options.clip.hasTerrain?.(sampled) === false) return { empty: true };
        return { renderer: await (options.getRenderer?.() ?? options.renderer) };
      })
      .then(async ({ renderer, retained, native, empty }) => {
        if (retained) {
          if (!isBackground())
            cache.set(key, retained, tile.level >= overviewLevel && tile.level <= coverageMaxLevel);
          return retained;
        }
        // Persistence pressure applies only to new native samples. An overview
        // needs no retained allocation and must remain drawable while those
        // samples are being saved. Storage waits never occupy a GPU queue slot.
        if (sampled.scale === 1) await retention.owner.capacity();
        controller.signal.throwIfAborted();
        const started = performance.now();
        const captured = native ?? await scheduleTerrainWork(() => {
          if (empty) {
            const canvas = document.createElement('canvas');
            canvas.width = sampled.width; canvas.height = sampled.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Terrain tile canvas unavailable');
            return context;
          }
          if (options.plane !== undefined) setTerrainPlane(renderer, options.plane);
          const workerClipping = options.workerClipping && renderer.backend === 'worker'
            && typeof renderer.renderViewport === 'function';
          const capture = (rendered: any) => {
            try {
              controller.signal.throwIfAborted();
              if (!rendered) throw new Error(renderer.failed || "GPU terrain context lost");
              const error = renderer.gl?.getError?.();
              if (error) throw new Error(`GPU terrain draw failed: 0x${error.toString(16)}`);
              const canvas = document.createElement("canvas");
              canvas.width = sampled.width; canvas.height = sampled.height;
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Terrain tile canvas unavailable");
              // Copy the main-context canvas before another draw can resize it.
              // Worker bitmaps can be released as soon as this copy is owned.
              if (workerClipping) ctx.drawImage(rendered, 0, 0);
              else options.clip.draw(ctx, rendered, sampled);
              return ctx;
            } finally { rendered?.close?.(); }
          };
          // Native cooking uses the same worker-owned masks as the foreground.
          // Expanding an entire scene mask again on the UI thread can turn a
          // small background tile into a long, blocking CPU task.
          const rendered = workerClipping
            ? renderer.renderViewport({ x: sampled.x, y: sampled.y,
                width: sampled.width * sampled.scale, height: sampled.height * sampled.scale,
                scale: sampled.scale, pixelWidth: sampled.width, pixelHeight: sampled.height }, controller.signal)
            : renderer.render(sampled, controller.signal);
          return typeof rendered?.then === 'function' ? rendered.then(capture) : capture(rendered);
        }, controller.signal, priority, { background: isBackground });
        try {
          if (sampled.scale === 1)
            await retention.capture(sampled.x - region.x, sampled.y - region.y, captured);
          controller.signal.throwIfAborted();
          if (!empty && !native) options.onTile?.(sampled.width * sampled.height, performance.now() - started);
          const result = reduceInstantTile(captured.canvas, view.width, view.height);
          // The cache owns a separate copy: OSD destroys its canvas on eviction.
          // Background work publishes through retention, preserving the active
          // display cache. Its result still has the ordinary tile dimensions
          // in case a foreground subscriber joins during completion.
          if (!isBackground())
            cache.set(key, result, tile.level >= overviewLevel && tile.level <= coverageMaxLevel);
          return result;
        } catch (error) {
          captured.canvas.width = captured.canvas.height = 0;
          throw error;
        }
      })
      .then(context => {
        work.context = context;
        return context;
      }).finally(() => {
        work.completed = true;
        if (pending.get(key) === work) pending.delete(key);
        if (!work.subscribers && work.context)
          work.context.canvas.width = work.context.canvas.height = 0;
      });
    pending.set(key, work);
    return work;
  };
  source.prepareNativeTile = async (x: number, y: number): Promise<void> => {
    signal.throwIfAborted();
    // One 512px native draw also supplies its exact 256px parent, which can
    // share pending work with an ordinary OSD request at the same level.
    const tile = { level: Math.max(0, source.maxLevel - 1), x, y };
    const view = instantTileView(region, tile,
      options.deps.getWorldCenter(options.gen.isNGP, options.gen.gameMode),
      options.deps.getWorldSize(options.gen.isNGP, options.gen.gameMode));
    if (!view) throw new Error('Invalid background terrain tile');
    const resident = () => {
      if (!retention.hasComplete(tile)) return false;
      const sampled = instantSampleView(view);
      for (let dy = 0; dy < sampled.height; dy += INSTANT_TILE_SIZE)
        for (let dx = 0; dx < sampled.width; dx += INSTANT_TILE_SIZE)
          if (!retention.hasComplete({ level: source.maxLevel,
            x: (sampled.x - region.x + dx) / INSTANT_TILE_SIZE,
            y: (sampled.y - region.y + dy) / INSTANT_TILE_SIZE })) return false;
      return true;
    };
    // Resident captures have already published all ancestor reductions. Disk
    // replay below also repairs missing ancestors after an interrupted write.
    const key = source.getTileUrl(tile.level, x, y);
    if (preparedNativeTiles.has(key) && resident()) return;
    let existing = pending.get(key);
    while (existing && !existing.background && !existing.controller.signal.aborted) {
      const release = subscribeWork(existing);
      try { await existing.promise; }
      finally { release(); }
      signal.throwIfAborted();
      if (preparedNativeTiles.has(key) && resident()) return;
      existing = pending.get(key);
    }
    const work = existing && !existing.controller.signal.aborted
      ? existing : render(tile, view, key, true);
    const release = subscribeWork(work);
    try {
      await work.promise;
      signal.throwIfAborted();
      preparedNativeTiles.add(key);
    }
    finally { release(); }
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
      const existing = pending.get(key);
      const work = existing && !existing.controller.signal.aborted
        ? existing : render(context.tile, view, key);
      release = subscribeWork(work, true);
      // Every consumer gets independently owned pixels, including simultaneous
      // overview/detail requests. Cancelling one does not cancel the others.
      result = work.promise.then(ctx => settled ? ctx : copyTerrainContext(ctx));
    }
    void result
      .then(async (ctx) => {
        if (settled) return;
        const revision = await retention.apply(context.tile, ctx);
        if (settled) return;
        context.tile.__retainedInitialRevision = revision;
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

/** OSD copies and atomically swaps the working cache for this awaited event.
 * Never mutate a drawer-owned context or make a pixel-generation request here. */
export async function applyRetainedTerrainEvent(event: any): Promise<void> {
  const source = event.tiledImage?.source;
  if (!source?.__instantTerrain || !source.applyRetainedTerrain || event.outdated?.()) return;
  const initial = event.tile.__retainedInitialRevision;
  delete event.tile.__retainedInitialRevision;
  if (initial !== undefined && initial === source.retainedRevision) return;
  const context = await event.getData('context2d');
  if (event.outdated?.()) return;
  await source.applyRetainedTerrain(event.tile, context);
}

let retainedInvalidationStamp = 0;
const retainedRefreshes = new WeakMap<object, {
  keys: Set<string>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
}>();
export function refreshRetainedTerrain(viewer: any, item: any, changed: RetainedTile[]) {
  if (item.source?.isDisposed) return;
  let state = retainedRefreshes.get(item);
  if (!state) {
    state = { keys: new Set(), running: false };
    retainedRefreshes.set(item, state);
  }
  for (const tile of changed) state.keys.add(`${tile.level}/${tile.x}/${tile.y}`);
  if (!state.keys.size || state.running || state.timer !== undefined) return;
  const pending = state;
  pending.timer = setTimeout(async () => {
    pending.timer = undefined;
    const keys = new Set(pending.keys);
    pending.keys.clear();
    if (item.source?.isDisposed) return;
    pending.running = true;
    try {
      // Wake admission at rest as well: a sibling capture or disk merge can
      // turn a queued cold request into a retained RAM hit.
      viewer.raiseEvent?.('terrain-cache-ready');
      const tiles = (viewer.tileCache?.getLoadedTilesFor(item) ?? []).filter((t: any) =>
        t.loaded && keys.has(`${t.level}/${t.x}/${t.y}`));
      if (tiles.length) {
        retainedInvalidationStamp = Math.max(Date.now(), retainedInvalidationStamp + 1);
        await viewer.world.requestTileInvalidateEvent(tiles, retainedInvalidationStamp, false);
        if (!item.source?.isDisposed) viewer.forceRedraw?.();
      }
    } catch (error) {
      if (!item.source?.isDisposed) console.warn('[Terrain] Retained tile refresh failed', error);
    } finally {
      pending.running = false;
      // Keep notifications that arrived while OSD copied/swapped the previous
      // cache. In particular, another update of the same tile must run again.
      refreshRetainedTerrain(viewer, item, []);
    }
  }, 16);
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
 * Once visible, all regions continue cooking native pixels independently of zoom. */
export async function addInstantTerrain(
  viewer: any,
  gen: GLTerrainGeneration & { parallelWorlds?: number[] },
  deps: GLTerrainDeps,
  masks: StaticTerrainMask[],
  isCurrent: () => boolean,
  onItem: (item: any) => void,
  firstPaint: () => void,
  fallback: (error: unknown) => void,
  generationStartedAt = performance.now(),
  presentationReady: Promise<void> = Promise.resolve(),
): Promise<boolean> {
  clearInstantTerrain();
  const lifetime = new AbortController();
  const memory = getMapMemoryBudget();
  const cache = new InstantTerrainCache(memory.terrainCacheBytes);
  const retained = new RetainedTerrain(undefined, memory.retainedTerrainBytes);
  const retentionIdentity = retainedTerrainIdentity(gen, masks);
  const items: any[] = [];
  const sources = new Set<any>();
  const retainedRegions: { region: InstantRegion; retention: RetainedTerrainRegion }[] = [];
  let viewport: ReturnType<typeof createInstantTerrainViewport> | undefined;
  let viewportRevision = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshViewport = () => {
    if (!viewport || lifetime.signal.aborted || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!lifetime.signal.aborted) { viewportRevision++; viewport?.refresh(); }
    }, 100);
  };
  let clip: ReturnType<typeof createInstantClip> | null = null;
  let failed = false,
    painted = false;
  const stats = {
    backend: "pending",
    memoryProfile: memory.profile,
    viewportPixelLimit: memory.viewportMaxPixels,
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
  const cooker = createInstantTerrainCooker({
    startedAt: generationStartedAt,
    seed: gen.seed,
    signal: lifetime.signal,
    persistent: () => retained.stats.persistent,
    flush: () => retained.flush(),
    foregroundBusy: () => !!viewport && (viewport.isBusy() || !!osd.isAnimating?.()),
    viewKey: () => {
      const b = osd.viewport.getBounds?.(false);
      const c = osd.viewport.getCenter(false);
      // Avoid sorting the entire remaining map for sub-chunk camera changes.
      return [c.x, c.y, b?.width ?? 0, b?.height ?? 0].map(n => Math.floor(n / 512)).join('/');
    },
    priority: (source: any, x, y) => {
      const view = instantTileView(source.instantRegion,
        { level: Math.max(0, source.maxLevel - 1), x, y }, 0, width);
      return view ? instantTilePriority(view, source.instantRegion, osd.viewport) : Infinity;
    },
    // A background failure must not remove already usable terrain layers.
    onFailure: error => console.warn('[Instant terrain] Background detail unavailable:', error),
  });
  Object.defineProperty(stats, 'cache', { enumerable: true, get: () => cache.stats });
  Object.assign(stats, { coverage: coverage.stats, cooking: cooker.stats });
  const width = deps.getWorldSize(gen.isNGP, gen.gameMode);
  const onDraw = (event: any) => {
    if (painted || !sources.has(event.tiledImage?.source) || !isCurrent())
      return;
    painted = true;
    stats.firstDrawMs = performance.now() - start;
    osd.removeHandler("tile-drawn", onDraw);
    firstPaint();
    afterMapHandoff(osd, lifetime.signal, () => { coverage.start(); cooker.start(); });
    console.info("[Instant terrain] First tile drawn", stats);
  };
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    clearTimeout(refreshTimer);
    cache.clear();
    retained.dispose();
    clip?.dispose();
    osd.removeHandler("tile-drawn", onDraw);
    osd.removeHandler("tile-drawing", smoothInstantTile);
    osd.removeHandler('tile-invalidated', applyRetainedTerrainEvent);
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
    const mainRenderer = await getRenderer(0);
    if (!isCurrent() || lifetime.signal.aborted)
      throw new DOMException("Obsolete terrain generation", "AbortError");
    const { includeElevatorOwnership, prepareElevatorShafts } = await import('./terrain-elevator');
    const elevatorShafts = await prepareElevatorShafts(gen);
    if (!isCurrent() || lifetime.signal.aborted)
      throw new DOMException('Obsolete terrain generation', 'AbortError');
    const owners = [-1, 0, 1].map((plane) =>
      includeElevatorOwnership(createPlaneOwnership(
        gen.tileLayers,
        gen.biomeData.pixels,
        (plane < 0
          ? gen.biomeData.heavenPixels
          : plane > 0
            ? gen.biomeData.hellPixels
            : gen.biomeData.pixels) ?? gen.biomeData.pixels,
        deps.GENERATOR_CONFIG,
        width,
      ), elevatorShafts, plane as VerticalPlane),
    );
    clip = createInstantClip(owners, masks);
    const direct = osd.drawer?.getType?.() === 'canvas'
      && typeof osd.drawer._drawTiles === 'function' && typeof mainRenderer.configureViewport === 'function';
    if (direct) await mainRenderer.configureViewport({ owners, masks, maskCacheBytes: memory.maskCacheBytes,
      center: deps.getWorldCenter(gen.isNGP, gen.gameMode) });
    if (!isCurrent() || lifetime.signal.aborted)
      throw new DOMException('Obsolete terrain generation', 'AbortError');
    osd.addHandler("tile-drawn", onDraw);
    osd.addHandler("tile-drawing", smoothInstantTile);
    osd.addHandler('tile-invalidated', applyRetainedTerrainEvent);
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
        let regionItem: any;
        const retention = retained.region(`${retentionIdentity}/${plane}/${pw}/${region.x},${region.y},${region.width},${region.height}`,
          region.width, region.height);
        retainedRegions.push({ region, retention });
        const source = createInstantTileSource({
          region,
          deps,
          gen,
          getRenderer: () => getRenderer(plane),
          workerClipping: direct,
          plane,
          clip,
          cache,
          retention,
          onRetainedTiles: tiles => {
            if (regionItem && !lifetime.signal.aborted) refreshRetainedTerrain(osd, regionItem, tiles);
            if (viewport && !lifetime.signal.aborted) {
              const bounds = osd.viewport.getBounds(true).getBoundingBox();
              if (tiles.some(tile => tile.level === retention.maxLevel
                && region.x + tile.x * 256 < bounds.x + bounds.width
                && region.x + (tile.x + 1) * 256 > bounds.x
                && region.y + tile.y * 256 < bounds.y + bounds.height
                && region.y + (tile.y + 1) * 256 > bounds.y)) refreshViewport();
            }
          },
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
        cooker.add(source);
        if (direct) continue; // Native cooking stays independent of foreground presentation.
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
            regionItem = item;
            items.push(item);
            coverage.add(item);
            onItem(item);
          },
          error: fail,
        });
      }
    if (direct) {
      const minX = Math.min(...retainedRegions.map(({ region }) => region.x));
      const maxX = Math.max(...retainedRegions.map(({ region }) => region.x + region.width));
      const bounds = { x: minX, y: WORLD_TOP - WORLD_HEIGHT, width: maxX - minX, height: 3 * WORLD_HEIGHT };
      const display = createRetainedViewportRenderer({
        cache,
        regions: retainedRegions, renderer: mainRenderer, signal: lifetime.signal,
        complete: () => cooker.stats.state === 'complete', refresh: refreshViewport,
      });
      viewport = createInstantTerrainViewport({
        viewer: osd, bounds, signal: lifetime.signal, revision: () => viewportRevision,
        maxRetainedPixels: memory.retainedFramePixels,
        async renderFrame(plan, signal) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) { abort(); return; }
            signal.addEventListener('abort', abort, { once: true });
            presentationReady.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
          });
          signal.throwIfAborted();
          return display.render(plan, signal);
        },
        firstPaint() {
          if (painted || !isCurrent() || lifetime.signal.aborted) return;
          painted = true;
          stats.firstDrawMs = performance.now() - start;
          firstPaint();
          afterMapHandoff(osd, lifetime.signal, () => cooker.start());
          console.info('[Instant terrain] First complete viewport drawn', stats);
        },
        onFailure: fail,
      });
      Object.assign(stats, { presentation: 'viewport', viewport: viewport.stats, display: display.stats });
      viewport.source.instantStats = stats;
      const source = viewport.source;
      viewer.addTiledImage({
        tileSource: source, x: bounds.x, y: bounds.y, width: bounds.width, blendTime: 0,
        success({ item }: any) {
          if (!isCurrent() || lifetime.signal.aborted) { osd.world.removeItem(item); return; }
          items.push(item); onItem(item); viewport?.refresh();
        },
        error(error: unknown) { source.destroy(); fail(error); },
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
