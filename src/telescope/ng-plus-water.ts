import { installViewportLayerDrawing } from './instant-terrain-viewport';
import { createPixelSceneTileSource } from './pixel-scene-tile-source';

const artwork = import.meta.glob<string>('./assets/ng-plus-water/*.png', {
  eager: true, import: 'default', query: '?url&no-inline',
});
const WATER = 0x0000ff;

/** The capture mod retained these Water cells but cleared much of the terrain
 * holding them in. Only restore a pocket if it survives this seed's Lua map. */
export function ngPlusWaterPlacements(pixels: Uint32Array, worldSize: number, worlds: readonly number[]) {
  return Object.entries(artwork).flatMap(([path, url]) => {
    const [x, y] = path.slice(path.lastIndexOf('/') + 1, -4).split('_').map(Number);
    const pw = Math.floor((x + worldSize / 2) / worldSize);
    const col = x + worldSize / 2 - pw * worldSize;
    if (!worlds.includes(pw) || (pixels[(y + 14) * worldSize + col] & 0xffffff) !== WATER) return [];
    return [{ osdX: x * 512, osdY: y * 512, w: 512, h: 512, sceneKey: url }];
  });
}

export function addNGPlusWater(viewer: any, pixels: Uint32Array, worldSize: number, worlds: readonly number[],
  generationId: number, index: number, isCurrent: () => boolean, onAdd: (item: any) => void) {
  const placements = ngPlusWaterPlacements(pixels, worldSize, worlds);
  if (!placements.length || !isCurrent()) return;
  const bitmaps = new Map<string, ImageBitmap>();
  const pending = new Map<string, Promise<ImageBitmap | undefined>>();
  const lifetime = new AbortController();
  const load = (url: string) => {
    if (lifetime.signal.aborted || !isCurrent()) return Promise.resolve(undefined);
    let request = pending.get(url);
    if (!request) {
      request = fetch(url, { signal: lifetime.signal }).then(async response => {
        if (!response.ok) throw new Error(`Failed to load NG+ water artwork (HTTP ${response.status})`);
        const bitmap = await createImageBitmap(await response.blob());
        if (lifetime.signal.aborted || !isCurrent()) { bitmap.close(); return; }
        bitmaps.set(url, bitmap);
        return bitmap;
      }).finally(() => pending.delete(url));
      pending.set(url, request);
    }
    return request;
  };
  const items = placements.map(p => ({ ...p, loadBitmap: () => load(p.sceneKey) }));
  const { source, originX, originY, width } = createPixelSceneTileSource({
    items, bitmapByKey: bitmaps, generationId, maxCacheBytes: 4 * 1024 * 1024,
    releaseBitmaps: () => {
      lifetime.abort();
      for (const bitmap of bitmaps.values()) bitmap.close();
    },
    redraw: () => (viewer.viewer ?? viewer).forceRedraw?.(),
  });
  source.getTileUrl = (level: number, x: number, y: number) => `ng-plus-water://${generationId}/${level}/${x}/${y}`;
  installViewportLayerDrawing(viewer, source);
  try {
    viewer.addTiledImage({ tileSource: source, x: originX, y: originY, width, index,
      success: ({ item }: any) => {
        if (isCurrent()) onAdd(item);
        else viewer.world.removeItem(item);
      },
      error: () => source.destroy(),
    });
  } catch (error) { source.destroy(); throw error; }
}
