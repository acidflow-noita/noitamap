import Flatbush from "flatbush";
import { copyTerrainContext, InstantTerrainCache } from "./instant-terrain-cache";
import { getMapMemoryBudget } from '../map-memory-budget';
import { drawViewportArt } from './viewport-art';
import { createSceneBitmapProvider, type CompressedSceneBitmap, type SceneBitmapLoader } from './scene-bitmap-provider';
import { createSceneViewportPages } from './scene-viewport-pages';
import { installViewportLayerDrawing } from './instant-terrain-viewport';

declare const OpenSeadragon: any;

export interface SceneTileItem {
  osdX: number;
  osdY: number;
  w: number;
  h: number;
  sceneKey: string;
}

/** Scene PNG caching avoids decoding artwork again. This separate, bounded
 * cache avoids compositing every room again when OSD revisits a zoom level.
 * OSD receives its own canvas, since its eviction destroys that canvas. */
export function createPixelSceneTileSource(options: {
  items: SceneTileItem[];
  bitmapByKey: Map<string, ImageBitmap>;
  blobByKey?: Map<string, CompressedSceneBitmap>;
  /** Produce exact artwork lazily, under the provider's bounded work queue. */
  loadBitmap?: SceneBitmapLoader;
  /** Retire the loader/worker before releasing this layer's bitmap ownership. */
  disposeBitmaps?: () => void;
  redraw?: () => void;
  /** Non-canvas drawers retain the ordinary asynchronous OSD tile path. */
  directViewport?: boolean;
  /** Own the drawing hook even when live GPU terrain is unavailable. */
  viewer?: any;
  maxBitmapBytes?: number;
  generationId: number;
  maxCacheBytes?: number;
}) {
  const { items, bitmapByKey, generationId } = options;
  const blobByKey = options.blobByKey ?? new Map<string, CompressedSceneBitmap>();
  const bitmaps = blobByKey.size || options.loadBitmap ? createSceneBitmapProvider(blobByKey,
    options.maxBitmapBytes ?? getMapMemoryBudget().sceneCacheBytes, options.loadBitmap) : undefined;
  if (!items.length) throw new Error("Cannot tile an empty scene layer");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.osdX);
    minY = Math.min(minY, item.osdY);
    maxX = Math.max(maxX, item.osdX + item.w);
    maxY = Math.max(maxY, item.osdY + item.h);
  }
  const originX = minX - 50, originY = minY - 50;
  const width = maxX - minX + 100, height = maxY - minY + 100;
  const index = new Flatbush(items.length);
  for (const item of items)
    index.add(item.osdX - originX, item.osdY - originY,
      item.osdX + item.w - originX, item.osdY + item.h - originY);
  index.finish();

  const tileSize = 512;
  const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(width, height))));
  const source = new OpenSeadragon.TileSource({ width, height, tileSize, minLevel: 0, maxLevel });
  const cache = new InstantTerrainCache(options.maxCacheBytes ?? getMapMemoryBudget().sceneCacheBytes);
  const cutoff = source.getClosestLevel();
  const baseEnd = Math.min(maxLevel, cutoff + 1);
  let destroyed = false, rendered = 0, renderMs = 0, chunks = 0, maxChunkMs = 0;
  type Work = { aborted: boolean; subscribers: number; promise: Promise<CanvasRenderingContext2D>; context?: CanvasRenderingContext2D };
  const inflight = new Map<string, Work>();
  const pending = new Set<(fail?: boolean) => void>();
  let paintedCamera: string | undefined, currentCamera: (() => string) | undefined;
  const directViewport = options.directViewport !== false
    && (!options.viewer || installViewportLayerDrawing(options.viewer));
  const pages = bitmaps && directViewport ? createSceneViewportPages({
    maxBytes: options.maxCacheBytes ?? getMapMemoryBudget().sceneCacheBytes,
    contains: rect => index.search(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height).length > 0,
    changed: () => options.redraw?.(),
    failure: error => source.raiseEvent('scene-viewport-error', { error }),
    ready: ready => {
      if (source.sceneViewportReady === ready) return;
      source.sceneViewportReady = ready;
      if (ready) source.raiseEvent('scene-viewport-ready', {});
    },
    render: async (page, cancelled) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = page.size + 2 * page.gutter;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = page.scale > 1;
      context.imageSmoothingQuality = 'high';
      const left = page.x - page.gutter * page.scale, top = page.y - page.gutter * page.scale;
      const extent = canvas.width * page.scale;
      const hits = index.search(left, top, left + extent, top + extent).sort((a, b) => a - b);
      try {
        for (const id of hits) {
          if (cancelled()) throw new DOMException('Scene viewport retired', 'AbortError');
          const scene = items[id], bitmap = bitmapByKey.get(scene.sceneKey);
          const x = (scene.osdX - originX - left) / page.scale;
          const y = (scene.osdY - originY - top) / page.scale;
          if (bitmap) context.drawImage(bitmap, x, y, scene.w / page.scale, scene.h / page.scale);
          else await bitmaps!.draw(scene.sceneKey, context, x, y, scene.w / page.scale, scene.h / page.scale, cancelled);
        }
        return context;
      } catch (error) { canvas.width = canvas.height = 0; throw error; }
    },
  }) : undefined;
  if (pages) {
    source.sceneViewportReady = false;
    source.__viewportReady = () => source.sceneViewportReady && currentCamera?.() === paintedCamera;
  }
  // Explicit opt-in to the existing HD coverage scheduler, without pretending
  // this transparent artwork layer is GPU terrain (or applying its smoothing).
  source.__instantCoverage = !pages;
  source.instantCoverageExtraLevels = 1;
  source.instantCoverageTileBytes = () => tileSize * tileSize * 4;
  source.__pixelScenes = true;
  Object.defineProperty(source, "sceneTileStats", { get: () => ({ ...cache.stats, rendered, renderMs, chunks, maxChunkMs, bitmapCache: bitmaps?.stats, viewport: pages?.stats }) });
  source.getTileUrl = (level: number, x: number, y: number) =>
    `pixel-scene-tile://${generationId}/${level}/${x}/${y}`;
  source.hasCachedTile = (tile: { level: number; x: number; y: number }) =>
    cache.has(source.getTileUrl(tile.level, tile.x, tile.y));
  source.hasTransparency = () => true;
  if (directViewport && (!bitmaps || pages)) source.__drawViewport = (context: CanvasRenderingContext2D, item: any, viewport: any) => {
    if (destroyed) return true;
    if (pages && item.imageToViewportCoordinates && viewport.pixelFromPoint) currentCamera = () => JSON.stringify([
      ...[[0, 0], [1, 0], [0, 1]].flatMap(([x, y]) => {
        const point = viewport.pixelFromPoint(item.imageToViewportCoordinates(x, y, true), true);
        return [point.x, point.y];
      }), item.getFlip?.(), viewport.getFlip?.(), item.opacity, context.canvas.width, context.canvas.height,
    ]);
    const painted = drawViewportArt(context, item, viewport, width, height, bounds => {
      if (pages) { pages.draw(context, bounds); return; }
      // Query full scene rectangles; no padding or coarse tile rounding is
      // needed when original artwork is drawn at its exact world placement.
      const hits = index.search(bounds.left, bounds.top, bounds.right, bounds.bottom).sort((a, b) => a - b);
      for (const id of hits) {
        const scene = items[id], bitmap = bitmapByKey.get(scene.sceneKey);
        if (bitmap) context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height,
          scene.osdX - originX, scene.osdY - originY, scene.w, scene.h);
      }
    });
    if (painted) paintedCamera = currentCamera?.();
    return painted;
  };

  function query(level: number, x: number, y: number) {
    const span = tileSize * 2 ** (maxLevel - level);
    const bx = x * span, by = y * span;
    // The index contains complete scene rectangles, so intersecting the tile
    // already finds scenes crossing its boundary. Preserve authored paint
    // order; Flatbush's spatial query order changes with the requested area.
    return { bx, by, span,
      hits: index.search(bx, by, bx + span, by + span).sort((a, b) => a - b) };
  }
  const validTile = source.tileExists.bind(source);
  source.tileExists = (level: number, x: number, y: number) =>
    !destroyed && validTile(level, x, y) && query(level, x, y).hits.length > 0;

  function render(key: string, level: number, x: number, y: number): Work {
    const work: Work = { aborted: false, subscribers: 0, promise: null! };
    const cancelled = () => {
      if (work.aborted || destroyed) throw new DOMException("Scene tile cancelled", "AbortError");
    };
    work.promise = Promise.resolve().then(async () => {
      cancelled();
      const { bx, by, span, hits } = query(level, x, y);
      // Several coarse OSD jobs may begin in one frame. Start their long draws
      // in separate tasks too, avoiding a burst of many 4ms microtask batches.
      if (hits.length > 128) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        cancelled();
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = tileSize;
      const context = canvas.getContext("2d")!;
      if (!context) throw new Error("Cannot composite scene tile");
      context.imageSmoothingEnabled = false;
      const scale = tileSize / span;
      let start = performance.now(), count = 0;
      const finishChunk = () => {
        const elapsed = performance.now() - start;
        renderMs += elapsed;
        maxChunkMs = Math.max(maxChunkMs, elapsed);
        chunks++;
      };
      try {
        for (let n = 0; n < hits.length; n++) {
          const item = items[hits[n]], bitmap = bitmapByKey.get(item.sceneKey);
          if (bitmap || blobByKey.has(item.sceneKey) || options.loadBitmap) {
            // Artwork and the terrain erasure mask must use the same world
            // rectangle. Rounding the origin and adding a display pixel to
            // the extent stretches scenes differently at every OSD LOD.
            const dx = (item.osdX - originX - bx) * scale;
            const dy = (item.osdY - originY - by) * scale;
            const dw = item.w * scale;
            const dh = item.h * scale;
            if (dw > 0 && dh > 0) {
              if (bitmap) context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
              else await bitmaps!.draw(item.sceneKey, context, dx, dy, dw, dh, () => work.aborted || destroyed);
              cancelled();
            }
          }
          // A whole-map tile can touch ten thousand scenes. Yield actual tasks,
          // rather than microtasks, so pointer/zoom/paint work can run between
          // bounded compositor batches. Ordinary detail tiles need no timer.
          if (++count >= 128 || performance.now() - start >= 4) {
            finishChunk();
            if (n + 1 < hits.length) {
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              cancelled();
            }
            start = performance.now();
            count = 0;
          }
        }
        if (count) finishChunk();
        cancelled();
        cache.set(key, context, level >= cutoff && level <= baseEnd);
        rendered++;
        work.context = context;
        return context;
      } catch (error) {
        canvas.width = canvas.height = 0;
        throw error;
      }
    }).finally(() => {
      if (inflight.get(key) === work) inflight.delete(key);
    });
    inflight.set(key, work);
    return work;
  }
  source.downloadTileStart = (context: any) => {
    const previous = context.userData;
    previous?.abort?.();
    const loaderCallback = previous?.loaderCallback ?? context.callback;
    let settled = false, release = () => {};
    const cleanup = () => {
      settled = true;
      pending.delete(cancel);
      release();
    };
    const cancel = (fail = false) => {
      if (settled) return;
      cleanup();
      if (fail) context.fail("Scene layer removed");
    };
    context.userData = { abort: () => cancel(), loaderCallback };
    if (typeof loaderCallback === "function") {
      let delivered = false;
      context.callback = (...args: any[]) => {
        if (delivered) return;
        delivered = true;
        // OSD timeouts bypass downloadTileAbort. Retire this subscriber before
        // its late compositor result can finish the already failed ImageJob.
        cleanup();
        loaderCallback.apply(context, args);
      };
    }
    pending.add(cancel);
    if (destroyed) { cancel(true); return; }
    const { level, x, y } = context.tile;
    const key = source.getTileUrl(level, x, y);
    let result: Promise<CanvasRenderingContext2D | undefined>;
    try {
      const hit = cache.get(key);
      if (hit) result = Promise.resolve(hit);
      else {
        const work = inflight.get(key) ?? render(key, level, x, y);
        work.subscribers++;
        let released = false;
        release = () => {
          if (released) return;
          released = true;
          if (--work.subscribers === 0) {
            work.aborted = true;
            if (inflight.get(key) === work) inflight.delete(key);
            // Cache and consumers own independent copies. Release the shared
            // compositor buffer immediately, including after successful jobs.
            if (work.context) work.context.canvas.width = work.context.canvas.height = 0;
            work.context = undefined;
          }
        };
        result = work.promise.then(ctx => settled ? undefined : copyTerrainContext(ctx));
      }
    } catch (error) {
      cleanup();
      context.fail(String(error));
      return;
    }
    void result.then(ctx => {
      if (settled) {
        if (ctx) ctx.canvas.width = ctx.canvas.height = 0;
        return;
      }
      cleanup();
      context.finish(ctx, null, "context2d");
    }, error => {
      if (settled) return;
      cleanup();
      context.fail(String(error));
    });
  };
  // ImageJob.abort() performs fail() itself. Cancel only this consumer's copy.
  source.downloadTileAbort = (context: any) => context.userData?.abort?.();
  source.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const cancel of pending) cancel(true);
    for (const work of inflight.values()) work.aborted = true;
    inflight.clear();
    cache.clear();
    pages?.dispose();
    options.disposeBitmaps?.();
    bitmaps?.dispose();
    for (const bitmap of new Set(bitmapByKey.values())) bitmap.close?.();
    bitmapByKey.clear();
  };
  if (source.__drawViewport && options.viewer) installViewportLayerDrawing(options.viewer, source);
  return { source, originX, originY, width, height };
}
