import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';
import { decodePngToRgba } from '../src/telescope/png-decode';
import * as scenes from '../lib/noita-telescope-vm/js/pixel_scene_generation.js';
import { nativeSceneBitmapKey, nativeSceneBitmapReplacesTerrain, renderNativeSceneBitmap, usesNativeSceneBitmap } from '../src/telescope/native-scene-bitmap';
import { paintTerrainScene, readRGBA, type TerrainScene, type TerrainSceneSource } from '../src/telescope/terrain-scenes';
import { compositeTerrain, textureColor, type TerrainTexture } from '../src/telescope/terrain-backgrounds';
import { BIOME_BACKGROUND_MAP, sceneBiomeNames } from '../src/telescope/terrain-policy';
import { createInstantClip } from '../src/telescope/instant-terrain-clip';
import { staticSceneBits } from '../src/telescope/static-terrain-mask';
import { clearSceneSpawnPixels } from '../src/telescope/scene-spawn-pixels';

let restoreFetch = () => {};
const backgrounds = new Map<string, TerrainTexture>();
beforeAll(async () => {
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), new URL('../lib/noita-telescope-vm/js/', import.meta.url));
    return new Response(await readFile(url));
  });
  restoreFetch = () => fetchSpy.mockRestore();
  await scenes.loadPixelSceneData();
  expect(await scenes.initPixelSceneTextures()).toBeTruthy();
  const zip = await JSZip.loadAsync(await readFile(new URL('../public/data.zip', import.meta.url)));
  const decoded = new Map<string, TerrainTexture>();
  for (const [name, path] of Object.entries(BIOME_BACKGROUND_MAP)) {
    if (!decoded.has(path)) decoded.set(path, await decodePngToRgba(await zip.file(path)!.async('arraybuffer')));
    backgrounds.set(name, decoded.get(path)!);
  }
  for (const name of ['watercave', 'solid_wall_hidden_cavern', 'friend_1', 'friend_6']) {
    const xml = await zip.file(`data/biome/${name}.xml`)!.async('string');
    expect(BIOME_BACKGROUND_MAP[name]).toBe(xml.match(/background_image="([^"]+)"/)![1]);
  }
});
afterAll(() => { restoreFetch(); vi.unstubAllGlobals(); });

async function room(name: string, biome: string, x: number, y: number) {
  const key = `general/${name}`;
  const raw = (scenes.PIXEL_SCENE_DATA as Record<string, any>)[key];
  expect(raw).toBeTruthy();
  await scenes.ensureScenePixels(raw);
  const scene: TerrainScene = { key, name, x, y, width: raw.width, height: raw.height, variantKey: `biome=${biome}` };
  const source: TerrainSceneSource = { data: raw.imgElement, width: raw.width, height: raw.height, visualArt: raw.visualArt, biome: raw.biome };
  return { scene, source };
}

describe('native material bitmaps for authored rooms', () => {
  it('uses fully opaque real textures for every mapped biome backdrop', () => {
    const textures = new Set(backgrounds.values());
    expect(textures.size).toBe(20);
    for (const texture of textures) {
      let translucent = 0;
      for (let i = 3; i < texture.data.length; i += 4) if (texture.data[i] !== 255) translucent++;
      expect(translucent).toBe(0);
    }
  });
  it('covers every painted source color from the actual scene inventory, leaving instruction no-ops untouched', async () => {
    let covered = 0, erased = 0, translucent = 0, untouched = 0;
    const failures: string[] = [], authoredTranslucency = new Set<string>();
    const entries = Object.entries(scenes.PIXEL_SCENE_DATA as Record<string, any>);
    expect(entries).toHaveLength(352);
    for (const [key, record] of entries) {
      await scenes.ensureScenePixels(record, { art: false });
      const colors = new Set<number>();
      for (let i = 0; i < record.imgElement.length; i += 4) colors.add(readRGBA(record.imgElement, i));
      const data = new Uint8Array(colors.size * 4);
      let next = 0;
      for (const rgba of colors) {
        data[next++] = rgba >>> 16 & 255; data[next++] = rgba >>> 8 & 255;
        data[next++] = rgba & 255; data[next++] = rgba >>> 24;
      }
      // Shared general scenes receive their real underlying biome at runtime.
      // Supply a known biome for those variants, keeping their script identity.
      const variantKey = `biome=${record.biome}${BIOME_BACKGROUND_MAP[record.biome] ? '' : '@coalmine'}`;
      const scene: TerrainScene = { key, name: record.name, variantKey,
        x: -37, y: 91, width: colors.size, height: 1 };
      const source = { data, width: colors.size, height: 1, biome: record.biome };
      const biome = sceneBiomeNames(scene).find(name => BIOME_BACKGROUND_MAP[name])!;
      const paint = (instance: TerrainScene, pixels: TerrainSceneSource) => paintTerrainScene(instance, pixels, scenes);
      const output = renderNativeSceneBitmap(scene, source, paint, 70, backgrounds.get(biome)!);
      const painted = paint(scene, source);
      const replaces = nativeSceneBitmapReplacesTerrain(scene, { materials: true, background: true });
      for (let i = 3; i < output.length; i += 4) {
        const alpha = painted.pixels[i], erase = painted.airMask?.[i] ?? 0;
        if (erase) erased++;
        if (alpha > 0 && alpha < 255) translucent++;
        if (alpha || erase) {
          covered++;
          if (output[i] !== 255) {
            authoredTranslucency.add(key);
            if (replaces) failures.push(`${key} color=${readRGBA(data, i - 3).toString(16)} alpha=${output[i]}`);
          }
        } else {
          untouched++;
          if (output[i] !== 0) failures.push(`${key} instruction no-op painted`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect([...authoredTranslucency].sort()).toEqual(['excavationsite/meditation_cube_visual', 'mountain/right_bottom']);
    expect(covered).toBeGreaterThan(1000);
    expect(erased).toBeGreaterThan(100);
    expect(translucent).toBeGreaterThan(100);
    expect(untouched).toBeGreaterThan(100);
  }, 20_000);
  it('removes registered friend spawn colors from actual shared cavern artwork without changing the source', async () => {
    const { scene, source } = await room('cavern', 'friend_6', 3072, 5632);
    const original = source.data.slice(), clean = clearSceneSpawnPixels(scene, source);
    const actual = renderNativeSceneBitmap(scene, source,
      (instance, data) => paintTerrainScene(instance, data, scenes), 70, backgrounds.get('friend_6'));
    let killers = 0, removed = 0, visibleMarkers = 0;
    for (let i = 0; i < original.length; i += 4) {
      if (readRGBA(original, i) === 0xff9dd0b0) killers++;
      if (!original[i + 3] || clean[i + 3]) continue;
      removed++;
      if (actual[i + 3]) visibleMarkers++;
    }
    expect(killers).toBe(14);
    expect(removed).toBeGreaterThanOrEqual(35);
    expect(visibleMarkers).toBe(0);
    expect(Buffer.from(source.data).equals(Buffer.from(original))).toBe(true);
  });
  it.each([
    ['friendroom', 'friend_1'], ['cavern', 'friend_6'],
    ['solid_wall_hidden_cavern', 'solid_wall_hidden_cavern'], ['watercave_layout_1', 'watercave'],
    ['orbroom', 'orbroom@coalmine'],
  ])('keeps real %s artwork sealed to underlying terrain throughout changing camera samples', async (name, biome) => {
    const { scene, source } = await room(name, biome, 0, 0);
    const backgroundBiome = sceneBiomeNames(scene).find(name => BIOME_BACKGROUND_MAP[name])!;
    const pixels = renderNativeSceneBitmap(scene, source,
      (instance, data) => paintTerrainScene(instance, data, scenes), 70, backgrounds.get(backgroundBiome)!);
    const artwork = createCanvas(512, 512), art = artwork.getContext('2d');
    const data = art.createImageData(512, 512); data.data.set(pixels); art.putImageData(data, 0, 0);
    const clean = clearSceneSpawnPixels(scene, source);
    const mask = { x: 0, y: 0, width: 512, height: 512,
      bits: staticSceneBits(clean), airBits: staticSceneBits(clean, true) };
    // The displayed room paints every pixel for which its material PNG would
    // erase terrain, including FORCE AIR's actual cave backdrop.
    let claimed = 0, missing = 0;
    for (let p = 0; p < 512 * 512; p++) if ((mask.bits[p >> 3] | mask.airBits[p >> 3]) & (1 << (p & 7))) {
      if (pixels[p * 4 + 3] !== 255) missing++; claimed++;
    }
    expect(missing).toBe(0);
    expect(claimed).toBeGreaterThan(10_000);
    const owners = Array.from({ length: 3 }, () => ({ width: 70, owners: new Int16Array(70 * 48) }));
    const replaces = nativeSceneBitmapReplacesTerrain(scene, { background: true, materials: true });
    expect(replaces).toBe(true);
    const clip = createInstantClip(owners, replaces ? [] : [mask]);
    try {
      for (const oldScale of [1, 2, 4]) {
        const priorSize = 512 / oldScale;
        const generated = createCanvas(priorSize, priorSize), terrain = generated.getContext('2d');
        terrain.fillStyle = '#735846'; terrain.fillRect(0, 0, priorSize, priorSize);
        const saved = createCanvas(priorSize, priorSize);
        clip.draw(saved.getContext('2d') as any, generated as any,
          { x: 0, y: 0, width: priorSize, height: priorSize, scale: oldScale });
        for (const [frame, scale] of [1.13, 1.37, 1.71, 2.19, 1.49, .83].entries()) {
          const x = -5.31 + frame * .17, y = -8.17 + frame * .23;
          const output = createCanvas(512, 512), actual = output.getContext('2d');
          actual.imageSmoothingEnabled = false;
          actual.setTransform(1 / scale, 0, 0, 1 / scale, -x / scale, -y / scale);
          actual.drawImage(saved, 0, 0, 512, 512);
          actual.drawImage(artwork, 0, 0);
          const result = actual.getImageData(0, 0, 512, 512).data;
          let gaps = 0;
          for (let py = 0; py < 512; py++) for (let px = 0; px < 512; px++) {
            const wx = x + (px + .5) * scale, wy = y + (py + .5) * scale;
            if (wx < 2 || wy < 2 || wx >= 510 || wy >= 510) continue;
            if (result[(py * 512 + px) * 4 + 3] !== 255) gaps++;
          }
          expect(gaps, `${name}: prior=${oldScale}, camera=${scale}`).toBe(0);
        }
      }
    } finally { clip.dispose(); }
  });
  it.each([
    ['friendroom', 'friend_1', 6 * 512, 11 * 512],
    ['cavern', 'friend_6', -10 * 512, 25 * 512],
  ] as const)('keeps %s cave air, authored cells and untouched EDR distinct', async (name, biome, x, y) => {
    const { scene, source } = await room(name, biome, x, y);
    expect(usesNativeSceneBitmap(scene)).toBe(true);
    const background = backgrounds.get(biome)!;
    const clean = clearSceneSpawnPixels(scene, source);
    const actual = renderNativeSceneBitmap(scene, source,
      (instance, pixels) => paintTerrainScene(instance, pixels, scenes), 70, background);
    const native = scenes.texturePixelSceneForBiome(scene.name, clean, 512, 512, biome, x, y);
    let untouched = 0, air = 0, materials = 0, mismatches = 0;
    const caveColors = new Set<number>();
    for (let i = 0; i < actual.length; i += 4) {
      const raw = readRGBA(clean, i), p = i / 4;
      // The material PNG is the source of geometry. FORCE AIR owns only the
      // carved cave; transparent cells must leave the EDR fill beneath intact.
      if (raw >>> 24 === 0) {
        if (actual[i + 3] !== 0) mismatches++;
        untouched++;
      } else if (raw === 0xff000042) {
        const expected = textureColor(background, x + p % 512 + 70 * 256, y + Math.floor(p / 512) + 7168);
        if (readRGBA(actual, i) !== expected) mismatches++;
        caveColors.add(expected);
        air++;
      } else {
        if (readRGBA(actual, i) !== readRGBA(native.pixels, i)) mismatches++;
        materials++;
      }
    }
    expect(mismatches).toBe(0);
    expect(untouched).toBeGreaterThan(190_000);
    expect(air).toBeGreaterThan(60_000);
    expect(materials).toBeGreaterThan(1_000);
    expect(caveColors.size).toBeGreaterThan(1);
  });

  it.each([1, 2, 3, 4, 5])('textures every pixel of dark cave layout %i and restores its real backdrop', async layout => {
    const { scene, source } = await room(`watercave_layout_${layout}`, 'watercave', -2048, 515);
    expect([source.width, source.height]).toEqual([512, 512]);
    expect(usesNativeSceneBitmap(scene)).toBe(true);
    const background = backgrounds.get('watercave')!;
    const clean = clearSceneSpawnPixels(scene, source);
    const actual = renderNativeSceneBitmap(scene, source,
      (instance, pixels) => paintTerrainScene(instance, pixels, scenes), 70, background);
    const native = scenes.texturePixelSceneForBiome(scene.name, clean, 512, 512, 'watercave', scene.x, scene.y);
    let mismatches = 0, texturedRock = 0, clearedAir = 0;
    const rockColors = new Set<number>();
    for (let i = 0; i < actual.length; i += 4) {
      const raw = readRGBA(clean, i), p = i / 4;
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

  it('keeps native identity separate by placement, variant and world size, including larger material scenes', () => {
    const scene: TerrainScene = { key: 'general/solid_wall_hidden_cavern', name: 'solid_wall_hidden_cavern', x: -3102, y: 0, width: 512, height: 512 };
    const keys = [nativeSceneBitmapKey(scene, 70), nativeSceneBitmapKey({ ...scene, x: 2560 }, 70),
      nativeSceneBitmapKey({ ...scene, variantKey: 'biome=solid_wall' }, 70), nativeSceneBitmapKey(scene, 72)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => key.startsWith('native-scene-'))).toBe(true);
    expect(usesNativeSceneBitmap({ ...scene, width: 513 })).toBe(true);
    expect(usesNativeSceneBitmap({ ...scene, key: 'general/watercave' })).toBe(true);
    expect(usesNativeSceneBitmap({ ...scene, key: 'static_tile/temples-assets/darkness' })).toBe(false);
    const room = { ...scene, variantKey: 'biome=solid_wall_hidden_cavern' };
    expect(nativeSceneBitmapReplacesTerrain(room, { background: true, materials: true })).toBe(true);
    expect(nativeSceneBitmapReplacesTerrain(scene, { background: true, materials: true })).toBe(false);
    expect(nativeSceneBitmapReplacesTerrain(room, { background: false, materials: true })).toBe(false);
    expect(nativeSceneBitmapReplacesTerrain(room, { background: true, materials: false })).toBe(false);
    expect(nativeSceneBitmapReplacesTerrain({ ...room, width: 513 }, { background: true, materials: true })).toBe(true);
    expect(nativeSceneBitmapReplacesTerrain({ ...room, key: 'static_tile/temples-assets/darkness' },
      { background: true, materials: true })).toBe(false);
    expect(nativeSceneBitmapReplacesTerrain({ ...room, key: 'excavationsite/meditation_cube_visual' },
      { background: true, materials: true })).toBe(false);
  });
});
