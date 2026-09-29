import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as scenes from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { renderNativeSceneBitmap, usesNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';
import { paintTerrainScene, readRGBA } from '../src/telescope/terrain-scenes';
import { compositeTerrain, textureColor } from '../src/telescope/terrain-backgrounds';

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(await readFile(
    new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url)))));
  await scenes.loadPixelSceneData();
  expect(await scenes.initPixelSceneTextures()).toBeTruthy();
});
afterAll(() => vi.restoreAllMocks());

it('does not paint a scene background over untouched terrain cells', () => {
  const scene = { key: 'coalmine/test', name: 'test', x: 0, y: 0, width: 2, height: 1 };
  const source = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 0, 0, 0, 66, 255]),
    backgroundArt: { width: 2, height: 1, data: new Uint8Array([200, 80, 10, 255, 200, 80, 10, 255]) } };
  const pixels = renderNativeSceneBitmap(scene, source,
    () => ({ pixels: new Uint8Array(8), airMask: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]) }), 70);
  expect([...pixels]).toEqual([0, 0, 0, 0, 200, 80, 10, 255]);
});

it.each([
  ['coalmine/oiltank_1', 'f0bbee=ebcd01&biome=coalmine'],
  ['excavationsite/machine_7', 'biome=excavationsite'],
  ['snowcave/shop', 'biome=snowcave'],
  ['vault/shop', 'biome=vault'],
  ['general/the_end_shop', 'biome=general@the_end'],
])('renders ordinary %s scenes at native material resolution and keeps block boundaries exact', async (key, variantKey) => {
  const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[key];
  expect(raw).toBeTruthy();
  await scenes.ensureScenePixels(raw);
  const scene = { key, name: raw.name, width: raw.width, height: raw.height,
    x: -1567, y: 5791, variantKey };
  const source = { data: raw.imgElement, width: raw.width, height: raw.height,
    biome: raw.biome, visualArt: raw.visualArt };
  const backdrop = { width: 2, height: 1, data: new Uint8ClampedArray([19, 31, 47, 255, 23, 37, 53, 255]) };
  const paint = (instance: any, pixels: any) => paintTerrainScene(instance, pixels, scenes);
  expect(usesNativeSceneBitmap(scene)).toBe(true);
  const expected = paint(scene, source);
  let largestBlock = 0;
  const actual = renderNativeSceneBitmap(scene, source, (instance, pixels) => {
    largestBlock = Math.max(largestBlock, pixels.width * pixels.height);
    return paint(instance, pixels);
  }, 70, backdrop);
  let mismatches = 0, visible = 0, changed = 0;
  for (let i = 0; i < actual.length; i += 4) {
    const p = i / 4;
    const under = expected.airMask?.[i + 3] ? textureColor(backdrop,
      scene.x + p % scene.width + 70 * 256, scene.y + Math.floor(p / scene.width) + 7168) : 0;
    if (readRGBA(actual, i) !== compositeTerrain(readRGBA(expected.pixels, i), under)) mismatches++;
    if (actual[i + 3]) visible++;
    if (raw.imgElement[i + 3] && readRGBA(actual, i) !== readRGBA(raw.imgElement, i)) changed++;
  }
  expect(mismatches).toBe(0);
  expect(visible).toBeGreaterThan(100);
  expect(changed).toBeGreaterThan(100);
  expect(largestBlock).toBeLessThanOrEqual(512 ** 2);
});
