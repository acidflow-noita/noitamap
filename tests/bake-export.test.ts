import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { buildMarkerData } from '../src/telescope/poi-spatial-index';
import type { GenerationResult, PixelScene } from '../src/telescope/telescope-adapter';
import { decodePngToRgba } from '../src/telescope/png-decode';
import { exportBiomeRegionImages, prepareDecorationExport, exportDecorationCell, releaseDecorationExport } from '../src/telescope/bake-export';

vi.mock('../src/telescope/poi-spatial-index', () => ({ buildMarkerData: vi.fn() }));
vi.mock('../src/data/biome_boundries_py.json', () => ({ default: { biomes: [
  { filename: 'coalmine', svg_map_path: 'M 35 14 L 36 14 L 36 15 L 35 15 Z' },
] } }));

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal('OffscreenCanvas', class { constructor(width: number, height: number) { return createCanvas(width, height); } });
});
afterEach(() => { releaseDecorationExport(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function canvas(width: number, height: number, color: string) {
  const image = createCanvas(width, height), ctx = image.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
  return image;
}
function decode(base64: string) {
  return decodePngToRgba(Uint8Array.from(Buffer.from(base64.split(',').at(-1)!, 'base64')).buffer);
}
function pixel(image: ReturnType<typeof decode>, x: number, y = 0) {
  return [...image.data.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4)];
}

it('exports decoration cells synchronously after preparation, preserving scene/marker order across cell boundaries', async () => {
  const sceneImage = canvas(3, 1, '#ff0000');
  const scene = { key: 'static_tile/test', name: 'test', x: 2047, y: 0, width: 3, height: 1, imgElement: sceneImage } as unknown as PixelScene;
  const dynamicScene = { ...scene, key: 'coalmine/test' };
  const generation = { pixelScenesByPW: { '0,0': [scene, dynamicScene] } } as unknown as GenerationResult;
  vi.mocked(buildMarkerData).mockResolvedValue({
    spritesheet: canvas(1, 1, '#0000ff'),
    atlas: { test: { x: 0, y: 0, w: 1, h: 1, ox: 0, oy: 0 } },
    items: [{ spriteKey: 'test', osdX: 2048, osdY: 0, w: 1, h: 1 }],
  } as any);
  const buildSceneBitmaps = vi.fn(async (result: GenerationResult) => ({
    validScenes: Object.values(result.pixelScenesByPW).flat(),
    bitmapByKey: new Map([[scene.key, sceneImage as unknown as ImageBitmap]]),
  }));

  expect(exportDecorationCell(0, 0)).toBeNull();
  expect(await prepareDecorationExport(generation, { buildSceneBitmaps, sceneRenderKey: scene => scene.key }, false))
    .toEqual({ cellSize: 2048, cells: [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }], mimicSpritesVersion: 1 });
  expect(buildSceneBitmaps.mock.calls[0][0].pixelScenesByPW['0,0']).toEqual([scene]);
  expect(pixel(decode(exportDecorationCell(0, 0)!), 2047)).toEqual([255, 0, 0, 255]);
  const second = decode(exportDecorationCell(1, 0)!);
  expect(pixel(second, 0)).toEqual([0, 0, 255, 255]);
  expect(pixel(second, 1)).toEqual([255, 0, 0, 255]);
  expect(exportDecorationCell(2, 0)).toBeNull();
  releaseDecorationExport();
  expect(exportDecorationCell(1, 0)).toBeNull();
});

it('keeps biome region bounds, binary alpha and coverage masks when markers extend beyond terrain', async () => {
  const image = canvas(2, 1, 'transparent'), ctx = image.getContext('2d');
  const pixels = ctx.createImageData(2, 1);
  pixels.data.set([255, 0, 0, 128, 0, 255, 0, 127]); ctx.putImageData(pixels, 0, 0);
  vi.mocked(buildMarkerData).mockResolvedValue({ items: [{ osdX: 30, osdY: 2, w: 4, h: 4 }] } as any);
  const generation = {
    isNGP: false, worldCenter: 35, parallelWorlds: [0], biomeData: {},
    tileLayers: [{ biomeName: 'coalmine', correctedX: 17920, correctedY: 7168 }],
  } as GenerationResult;
  const createTileOverlays = vi.fn(() => [image as unknown as OffscreenCanvas]);
  const result = await exportBiomeRegionImages(generation, { biomeRenderOrder: ['coalmine'], createTileOverlays });
  expect(result.biomeIndex).toEqual({ 1: 'background_coalmine.png' });
  expect(result.regions).toHaveLength(1);
  const region = result.regions[0];
  expect(region).toMatchObject({ pw: 0, pvt: 0, minX: 0, minY: 0, compositeW: 4, compositeH: 1, scale: 10, osdWidth: 40 });
  expect(createTileOverlays).toHaveBeenCalledWith(generation.biomeData, generation.tileLayers, 0, 0, false);
  expect(pixel(decode(region.small), 0)[3]).toBe(255);
  expect(pixel(decode(region.small), 1)[3]).toBe(0);
  const mask = decode(region.mask!);
  expect(pixel(mask, 0)).toEqual([0, 0, 1, 255]);
  expect(pixel(mask, 1)).toEqual([0, 0, 1, 255]);
  expect(pixel(mask, 2)[3]).toBe(0);
});
