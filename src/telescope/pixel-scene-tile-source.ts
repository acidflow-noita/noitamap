import Flatbush from "flatbush";
import { copyTerrainContext, InstantTerrainCache } from "./instant-terrain-cache";

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
  generationId: number;
  maxCacheBytes?: number;
}) {
  const { items, bitmapByKey, generationId } = options;
  if (!items.length) throw new Error("Cannot tile an empty scene layer");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let maxSceneDim = 0;
  for (const item of items) {
    minX = Math.min(minX, item.osdX);
    minY = Math.min(minY, item.osdY);
    maxX = Math.max(maxX, item.osdX + item.w);
    maxY = Math.max(maxY, item.osdY + item.h);
    maxSceneDim = Math.max(maxSceneDim, item.w, item.h);
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
  const cache = new InstantTerrainCache(options.maxCacheBytes ?? 16 * 1024 * 1024);
  const cutoff = source.getClosestLevel();
  const baseEnd = Math.min(maxLevel, cutoff + 1);
  let destroyed = false, rendered = 0, renderMs = 0, chunks = 0, maxChunkMs = 0;
  type Work = { aborted: boolean; subscribers: number; promise: Promise<CanvasRenderingContext2D> };
  const inflight = new Map<string, Work>();
  const pending = new Set<(fail?: boolean) => void>();
  // Explicit opt-in to the existing HD coverage scheduler, without pretending
  // this transparent artwork layer is GPU terrain (or applying its smoothing).
  source.__instantCoverage = true;
  source.instantCoverageExtraLevels = 1;
  source.instantCoverageTileBytes = () => tileSize * tileSize * 4;
  source.__pixelScenes = true;
  Object.defineProperty(source, "sceneTileStats", { get: () => ({ ...cache.stats, rendered, renderMs, chunks, maxChunkMs }) });
  source.getTileUrl = (level: number, x: number, y: number) =>
    `pixel-scene-tile://${generationId}/${level}/${x}/${y}`;
  source.hasCachedTile = (tile: { level: number; x: number; y: number }) =>
    cache.has(source.getTileUrl(tile.level, tile.x, tile.y));
  source.hasTransparency = () => true;

  function query(level: number, x: number, y: number) {
    const span = tileSize * 2 ** (maxLevel - level);
    const bx = x * span, by = y * span;
    // Retain the existing compositor's padded query and integer overlap. This
    // changes tile lifetime, not scene placement, ordering or output pixels.
    return { bx, by, span,
      hits: index.search(bx - maxSceneDim, by - maxSceneDim,
        bx + span + maxSceneDim, by + span + maxSceneDim) };
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
          if (bitmap) {
            const dx = Math.floor((item.osdX - originX - bx) * scale);
            const dy = Math.floor((item.osdY - originY - by) * scale);
            const dw = Math.ceil(item.w * scale) + 1;
            const dh = Math.ceil(item.h * scale) + 1;
            if (dw >= 1 && dh >= 1)
              context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
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
          if (--work.subscribers === 0 && inflight.get(key) === work) {
            work.aborted = true;
            inflight.delete(key);
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
    for (const bitmap of new Set(bitmapByKey.values())) bitmap.close?.();
    bitmapByKey.clear();
  };
  return { source, originX, originY, width, height };
}
