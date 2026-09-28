import { copyTerrainContext, InstantTerrainCache } from "./instant-terrain-cache";
import { getMapMemoryBudget } from '../map-memory-budget';
import { drawViewportArt } from './viewport-art';

declare const OpenSeadragon: any;

export interface BiomeBackgroundRegion {
  /** All SVG subpaths participate in one nonzero-winding clip, including holes. */
  rings: Array<Array<{ x: number; y: number }>>;
  textureKey: string;
}

export interface BiomeBackgroundTiles {
  regions: BiomeBackgroundRegion[];
  textures: Map<string, ImageBitmap>;
  originX: number;
  originY: number;
  width: number;
  height: number;
  phaseX: number;
  phaseY: number;
  maxCacheBytes?: number;
}

let nextPack = 0;
const TILE_SIZE = 256;

/** Tile original background artwork at one game pixel per native-level pixel.
 * Parallel-world sources share cache ownership, while sampling their actual
 * world positions. Textures belong to the caller and survive every teardown. */
export function createBiomeBackgroundTiles(options: BiomeBackgroundTiles) {
  const { textures, originX, originY, width, height, phaseX, phaseY } = options;
  if (![originX, originY, width, height, phaseX, phaseY].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new RangeError("Invalid biome background bounds or texture phase");
  const regions = options.regions.map(region => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of region.rings) for (const point of ring) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    return { ...region, minX, minY, maxX, maxY };
  });
  const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(width, height))));
  const cache = new InstantTerrainCache(options.maxCacheBytes ?? getMapMemoryBudget().biomeBackgroundCacheBytes);
  const pack = ++nextPack;
  const sources = new Set<any>();
  let destroyed = false, rendered = 0, renderMs = 0;
  type Work = { aborted: boolean; subscribers: number; promise: Promise<CanvasRenderingContext2D> };
  const inflight = new Map<string, Work>();

  function bounds(level: number, x: number, y: number) {
    const scale = 2 ** (level - maxLevel);
    const w = Math.ceil(Math.min(TILE_SIZE, width * scale - x * TILE_SIZE));
    const h = Math.ceil(Math.min(TILE_SIZE, height * scale - y * TILE_SIZE));
    return { scale, w, h, left: originX + x * TILE_SIZE / scale, top: originY + y * TILE_SIZE / scale };
  }

  function render(key: string, level: number, x: number, y: number, worldOffsetX: number, pinned: boolean) {
    const work: Work = { aborted: false, subscribers: 0, promise: null! };
    work.promise = Promise.resolve().then(() => {
      if (destroyed || work.aborted) throw new DOMException("Background tile cancelled", "AbortError");
      const start = performance.now();
      const { scale, w, h, left, top } = bounds(level, x, y);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Cannot render biome background tile");
      ctx.imageSmoothingEnabled = false;
      try {
        ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
        for (const region of regions) {
          if (region.maxX <= left || region.maxY <= top || region.minX >= left + w / scale || region.minY >= top + h / scale) continue;
          const texture = textures.get(region.textureKey);
          if (!texture) continue;
          if (!texture.width || !texture.height) throw new Error(`Biome background texture was closed: ${region.textureKey}`);
          ctx.save();
          ctx.beginPath();
          for (const ring of region.rings) {
            if (ring.length < 3) continue;
            ctx.moveTo(ring[0].x, ring[0].y);
            for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
            ctx.closePath();
          }
          ctx.clip("nonzero");
          const textureOriginX = phaseX - worldOffsetX;
          if (scale === 1) {
            // Direct blits preserve authored bytes even on native canvas
            // engines that filter CanvasPattern at 1:1. The world footprint
            // is at most 256 square here, so repetitions stay tile-bounded.
            const startX = Math.floor((left - textureOriginX) / texture.width) * texture.width + textureOriginX;
            const startY = Math.floor((top - phaseY) / texture.height) * texture.height + phaseY;
            for (let ty = startY; ty < top + h; ty += texture.height)
              for (let tx = startX; tx < left + w; tx += texture.width)
                ctx.drawImage(texture, tx, ty);
          } else {
            // Coarse tiles can span the whole world. A pattern avoids a loop
            // proportional to that world area and keeps every canvas small.
            const pattern = ctx.createPattern(texture, "repeat");
            if (!pattern) throw new Error(`Cannot repeat biome background ${region.textureKey}`);
            ctx.translate(textureOriginX, phaseY);
            ctx.fillStyle = pattern;
            ctx.fillRect(left - textureOriginX, top - phaseY, w / scale, h / scale);
          }
          ctx.restore();
        }
        cache.set(key, ctx, pinned);
        rendered++;
        renderMs += performance.now() - start;
        return ctx;
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

  function createSource(worldOffsetX = 0): any {
    if (destroyed) throw new Error("Biome background tiles were destroyed");
    if (!Number.isFinite(worldOffsetX)) throw new RangeError("Invalid biome background world offset");
    const source = new OpenSeadragon.TileSource({ width, height, tileSize: TILE_SIZE, tileOverlap: 0, minLevel: 0, maxLevel });
    let detached = false;
    const pending = new Set<(fail?: boolean) => void>();
    const cutoff = source.getClosestLevel();
    const keyFor = (level: number, x: number, y: number) => `${worldOffsetX}/${level}/${x}/${y}`;
    source.__biomeBg = true;
    source.__instantCoverage = true;
    source.instantCoverageExtraLevels = 1;
    source.instantCoverageTileBytes = (level: number, x: number, y: number) => {
      const { w, h } = bounds(level, x, y);
      return w * h * 4;
    };
    source.hasTransparency = () => true;
    source.__drawViewport = (context: CanvasRenderingContext2D, item: any, viewport: any) => {
      if (detached || destroyed) return true;
      return drawViewportArt(context, item, viewport, width, height, bounds => {
        const left = bounds.left + originX, top = bounds.top + originY;
        const right = bounds.right + originX, bottom = bounds.bottom + originY;
        context.translate(-originX, -originY);
        for (const region of regions) {
          if (region.maxX <= left || region.maxY <= top || region.minX >= right || region.minY >= bottom) continue;
          const texture = textures.get(region.textureKey);
          if (!texture?.width || !texture.height) continue;
          context.save();
          try {
            context.beginPath();
            for (const ring of region.rings) {
              if (ring.length < 3) continue;
              context.moveTo(ring[0].x, ring[0].y);
              for (let i = 1; i < ring.length; i++) context.lineTo(ring[i].x, ring[i].y);
              context.closePath();
            }
            context.clip('nonzero');
            const tx = phaseX - worldOffsetX;
            if (bounds.scale >= 1) {
              // Only repeat across the visible intersection. A close-up must
              // never visit every texture repetition in a world-sized biome.
              const x0 = Math.max(left, region.minX), y0 = Math.max(top, region.minY);
              const x1 = Math.min(right, region.maxX), y1 = Math.min(bottom, region.maxY);
              const startX = Math.floor((x0 - tx) / texture.width) * texture.width + tx;
              const startY = Math.floor((y0 - phaseY) / texture.height) * texture.height + phaseY;
              for (let y = startY; y < y1; y += texture.height)
                for (let x = startX; x < x1; x += texture.width) context.drawImage(texture, x, y);
            } else {
              const pattern = context.createPattern(texture, 'repeat');
              if (!pattern) continue;
              context.translate(tx, phaseY);
              context.fillStyle = pattern;
              context.fillRect(left - tx, top - phaseY, right - left, bottom - top);
            }
          } finally { context.restore(); }
        }
      });
    };
    source.getTileUrl = (level: number, x: number, y: number) => `biome-background://${pack}/${keyFor(level, x, y)}`;
    source.hasCachedTile = (tile: { level: number; x: number; y: number }) => cache.has(keyFor(tile.level, tile.x, tile.y));
    const validTile = source.tileExists.bind(source);
    source.tileExists = (level: number, x: number, y: number) => !detached && !destroyed && validTile(level, x, y);

    source.downloadTileStart = (context: any) => {
      const previous = context.userData;
      previous?.abort?.();
      const loaderCallback = previous?.loaderCallback ?? context.callback;
      let settled = false, release = () => {};
      const cleanup = () => { settled = true; pending.delete(cancel); release(); };
      const cancel = (fail = false) => {
        if (settled) return;
        cleanup();
        if (fail) context.fail("Biome background layer removed");
      };
      context.userData = { abort: () => cancel(), loaderCallback };
      if (typeof loaderCallback === "function") {
        let delivered = false;
        context.callback = (...args: any[]) => {
          if (delivered) return;
          delivered = true;
          cleanup();
          loaderCallback.apply(context, args);
        };
      }
      pending.add(cancel);
      const { level, x, y } = context.tile;
      if (!source.tileExists(level, x, y)) { cancel(true); return; }
      const key = keyFor(level, x, y);
      let result: Promise<CanvasRenderingContext2D | undefined>;
      try {
        const hit = cache.get(key);
        if (hit) result = Promise.resolve(hit);
        else {
          const work = inflight.get(key) ?? render(key, level, x, y, worldOffsetX, level >= cutoff && level <= cutoff + 1);
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
        cleanup(); context.fail(String(error)); return;
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
        cleanup(); context.fail(String(error));
      });
    };
    source.downloadTileAbort = (context: any) => context.userData?.abort?.();
    source.destroy = () => {
      if (detached) return;
      detached = true;
      for (const cancel of pending) cancel(true);
      sources.delete(source);
    };
    sources.add(source);
    return source;
  }

  return {
    createSource,
    get stats() { return { ...cache.stats, rendered, renderMs, inflight: inflight.size, sources: sources.size }; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const source of sources) source.destroy();
      for (const work of inflight.values()) work.aborted = true;
      inflight.clear();
      cache.clear();
    },
  };
}
