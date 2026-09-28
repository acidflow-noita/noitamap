import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { decodePngToRgba } from '../src/telescope/png-decode';
import * as scenes from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { nativeSceneBitmapKey, renderNativeSceneBitmap, usesNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';
import { paintTerrainScene, readRGBA, type TerrainScene, type TerrainSceneSource } from '../src/telescope/terrain-scenes';
import { compositeTerrain, textureColor, type TerrainTexture } from '../src/telescope/terrain-backgrounds';
import { BIOME_BACKGROUND_MAP } from '../src/telescope/terrain-policy';

let restoreFetch = () => {};
const backgrounds = new Map<string, TerrainTexture>();
beforeAll(async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url));
    return new Response(await readFile(url));
  });
  restoreFetch = () => fetchSpy.mockRestore();
  await scenes.loadPixelSceneData();
  expect(await scenes.initPixelSceneTextures()).toBeTruthy();
  const zip = await JSZip.loadAsync(await readFile(new URL('../public/data.zip', import.meta.url)));
  for (const name of ['watercave', 'solid_wall_hidden_cavern']) {
    const xml = await zip.file(`data/biome/${name}.xml`)!.async('string');
    const path = xml.match(/background_image="([^"]+)"/)![1];
    expect(BIOME_BACKGROUND_MAP[name]).toBe(path);
    backgrounds.set(name, await decodePngToRgba(await zip.file(path)!.async('arraybuffer')));
  }
});
afterAll(() => restoreFetch());

async function room(name: string, biome: string, x: number, y: number) {
  const key = `general/${name}`;
  const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[key];
  expect(raw).toBeTruthy();
  await scenes.ensureScenePixels(raw);
  const scene: TerrainScene = { key, name, x, y, width: raw.width, height: raw.height, variantKey: `biome=${biome}` };
  const source: TerrainSceneSource = { data: raw.imgElement, width: raw.width, height: raw.height, visualArt: raw.visualArt };
  return { scene, source };
}

describe('native material bitmaps for authored rooms', () => {
  it.each([1, 2, 3, 4, 5])('textures every pixel of dark cave layout %i and restores its real backdrop', async layout => {
    const { scene, source } = await room(`watercave_layout_${layout}`, 'watercave', -2048, 515);
    expect([source.width, source.height]).toEqual([512, 512]);
    expect(usesNativeSceneBitmap(scene)).toBe(true);
    const background = backgrounds.get('watercave')!;
    const actual = renderNativeSceneBitmap(scene, source,
      (instance, pixels) => paintTerrainScene(instance, pixels, scenes), 70, background);
    const native = scenes.texturePixelSceneForBiome(scene.name, source.data, 512, 512, 'watercave', scene.x, scene.y);
    let mismatches = 0, texturedRock = 0, clearedAir = 0;
    const rockColors = new Set<number>();
    for (let i = 0; i < actual.length; i += 4) {
      const raw = readRGBA(source.data, i), p = i / 4;
      const forceAir = raw === 0xff000042;
      const under = forceAir || native.airMask?.[i + 3]
        ? textureColor(background, scene.x + p % 512 + 70 * 256, scene.y + Math.floor(p / 512) + 7168) : 0;
      const expected = compositeTerrain(forceAir ? 0 : readRGBA(native.pixels, i), under);
      if (readRGBA(actual, i) !== expected) mismatches++;
      if (raw === 0xff103344) {
        rockColors.add(readRGBA(actual, i));
        if (readRGBA(actual, i) !== raw) texturedRock++;
      }
      if (forceAir && readRGBA(actual, i) === under) clearedAir++;
    }
    expect(mismatches).toBe(0);
    expect(texturedRock).toBeGreaterThan(100_000);
    // rock.png is the game's two-color texture, not a flat Wang swatch.
    expect(rockColors.size).toBe(2);
    expect(clearedAir).toBeGreaterThan(10_000);
  });

  it('renders the hidden cavern gold and carved air at its Ancient Laboratory placement', async () => {
    const { scene, source } = await room('solid_wall_hidden_cavern', 'solid_wall_hidden_cavern', -3102, 0);
    expect(usesNativeSceneBitmap(scene)).toBe(true);
    const background = backgrounds.get('solid_wall_hidden_cavern')!;
    const actual = renderNativeSceneBitmap(scene, source,
      (instance, pixels) => paintTerrainScene(instance, pixels, scenes), 70, background);
    const native = scenes.texturePixelSceneForBiome(scene.name, source.data, 512, 512,
      'solid_wall_hidden_cavern', scene.x, scene.y);
    let gold = 0, air = 0;
    const goldColors = new Set<number>();
    for (let i = 0; i < actual.length; i += 4) {
      const raw = readRGBA(source.data, i), p = i / 4;
      if (raw === 0xffebcd01) {
        expect(readRGBA(actual, i)).toBe(readRGBA(native.pixels, i));
        goldColors.add(readRGBA(actual, i)); gold++;
      }
      if (raw === 0xff000042) {
        expect(readRGBA(actual, i)).toBe(textureColor(background,
          scene.x + p % 512 + 70 * 256, scene.y + Math.floor(p / 512) + 7168));
        air++;
      }
    }
    expect(gold).toBeGreaterThan(100);
    expect(goldColors.size).toBeGreaterThan(1);
    expect(air).toBeGreaterThan(100);
  });

  it('keeps native cache identity separate by placement, variant and world size, and rejects larger bitmaps', () => {
    const scene: TerrainScene = { key: 'general/solid_wall_hidden_cavern', name: 'solid_wall_hidden_cavern', x: -3102, y: 0, width: 512, height: 512 };
    const keys = [nativeSceneBitmapKey(scene, 70), nativeSceneBitmapKey({ ...scene, x: 2560 }, 70),
      nativeSceneBitmapKey({ ...scene, variantKey: 'biome=solid_wall' }, 70), nativeSceneBitmapKey(scene, 72)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => key.startsWith('native-scene-'))).toBe(true);
    expect(usesNativeSceneBitmap({ ...scene, width: 513 })).toBe(false);
    expect(usesNativeSceneBitmap({ ...scene, key: 'general/watercave' })).toBe(false);
  });
});
