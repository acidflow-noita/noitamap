import { sharedCpuTerrainPool } from './cpu-terrain-client';
import { ngPlusSurfaceLayout } from './ng-plus-surface-layout';

declare const OpenSeadragon: any;

const TILE_SIZE = 128;
let nextSource = 0;

/** A sparse OSD pyramid over the replacement surface. Opening an underground
 * view creates no surface jobs. Coordinates remain absolute across all PWs. */
export function addNGPlusSurface(viewer: any, seed: number, pixels: Uint32Array, cells: Uint16Array,
  worldSize: number, worlds: number[], isCurrent: () => boolean, onAdd: (item: any) => void) {
  const layout = ngPlusSurfaceLayout(cells, worldSize, worlds);
  if (!layout || !isCurrent()) return;
  const { x: originX, y: originY, width, height } = layout;
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  const source = new OpenSeadragon.TileSource({ width, height, tileSize: TILE_SIZE, tileOverlap: 0, minLevel: 0, maxLevel });
  const pool = sharedCpuTerrainPool();
  const generation = pool.context({ kind: 'ng-plus-surface', seed, pixels, cells });
  const serial = ++nextSource;
  function bounds(level: number, column: number, row: number) {
    const step = 2 ** (maxLevel - level);
    return { x: originX + column * TILE_SIZE * step, y: originY + row * TILE_SIZE * step, step,
      width: Math.min(TILE_SIZE, Math.ceil(width / step) - column * TILE_SIZE),
      height: Math.min(TILE_SIZE, Math.ceil(height / step) - row * TILE_SIZE) };
  }
  const validTile = source.tileExists.bind(source);
  source.tileExists = (level: number, x: number, y: number) => {
    if (generation.released || !validTile(level, x, y)) return false;
    const tile = bounds(level, x, y);
    return layout.intersects(tile.x, tile.y, tile.width * tile.step, tile.height * tile.step);
  };
  source.getTileUrl = (level: number, x: number, y: number) => `ng-plus-surface://${serial}/${level}/${x}/${y}`;
  source.hasTransparency = () => true;
  source.downloadTileStart = async (job: any) => {
    const { level, x, y } = job.tile, tile = bounds(level, x, y);
    const controller = new AbortController();
    job.userData = { ...job.userData, surfaceAbort: controller };
    try {
      if (!isCurrent() || !source.tileExists(level, x, y)) throw new Error('Obsolete NG+ surface tile');
      const data = await pool.render(generation, tile, controller.signal, () => {
        if (!isCurrent()) throw new DOMException('NG+ surface changed', 'AbortError');
        return level - maxLevel;
      });
      if (controller.signal.aborted) return;
      if (!isCurrent() || generation.released) throw new Error('NG+ surface changed');
      const canvas = document.createElement('canvas');
      canvas.width = tile.width; canvas.height = tile.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Cannot draw NG+ surface tile');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), tile.width, tile.height), 0, 0);
      job.finish(ctx, null, 'context2d');
    } catch (error) {
      if (!controller.signal.aborted) job.fail(String(error));
    }
  };
  source.downloadTileAbort = (job: any) => job.userData?.surfaceAbort?.abort();
  const destroy = source.destroy.bind(source);
  source.destroy = (...args: any[]) => {
    if (generation.released) return;
    pool.release(generation);
    destroy(...args);
  };
  try {
    viewer.addTiledImage({ tileSource: source, x: originX, y: originY, width,
      success: ({ item }: any) => {
        if (isCurrent()) onAdd(item);
        else viewer.world.removeItem(item);
      }, error: () => source.destroy() });
  } catch (error) { source.destroy(); throw error; }
}
