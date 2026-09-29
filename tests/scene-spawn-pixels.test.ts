import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { clearSceneSpawnPixels, FRIEND_SCENE_SPAWN_COLORS } from '../src/telescope/scene-spawn-pixels';
import { paintTerrainScene } from '../src/telescope/terrain-scenes';

const rgba = (...colors: number[]) => Uint8Array.from(colors.flatMap(rgb => [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255, 255]));

describe('per-placement pixel scene spawn instructions', () => {
  it('uses the exact registrations from all six bundled friend biome scripts', async () => {
    const zip = await JSZip.loadAsync(await readFile(new URL('../public/data.zip', import.meta.url)));
    for (let i = 1; i <= 6; i++) {
      const script = await zip.file(`data/scripts/biomes/friend_${i}.lua`)!.async('string');
      const colors = [...script.matchAll(/RegisterSpawnFunction\s*\(\s*0x([\da-f]+)/gi)]
        .map(match => parseInt(match[1], 16) & 0xffffff).sort((a, b) => a - b);
      expect(colors).toEqual([...FRIEND_SCENE_SPAWN_COLORS].sort((a, b) => a - b));
    }
  });

  it('clears shared-room instructions using the placed biome without changing raw material or unknown artwork', () => {
    const data = rgba(0x9dd0b0, 0x80ff5a, 0xebcd01, 0x3462ad, 0xf0bbee, 0x123456, 0x000042);
    const before = data.slice();
    const scene = { key: 'general/cavern', variantKey: 'biome=general@friend_6' };
    const output = clearSceneSpawnPixels(scene, { data });
    expect([...output.subarray(0, 8)]).toEqual(Array(8).fill(0));
    expect([...output.subarray(8)]).toEqual([...before.subarray(8)]);
    expect(data).toEqual(before);
    expect(clearSceneSpawnPixels({ key: 'general/cavern' }, { data: rgba(0x9dd0b0), biome: 'friend_1' }))
      .toEqual(new Uint8Array(4));
  });

  it('removes markers before substitution and preserves the selected liquid/gold material', () => {
    const data = rgba(0x9dd0b0, 0xf0bbee, 0xebcd01);
    const scene = { key: 'general/cavern', name: 'cavern', variantKey: 'f0bbee=ebcd01&biome=general@friend_6',
      x: 0, y: 0, width: 3, height: 1 };
    const recolorPixelScene = vi.fn((input: Uint8Array, from: number, to: number) => {
      expect(from).toBe(0xf0bbee); expect(to).toBe(0xebcd01);
      expect(input.subarray(0, 4)).toEqual(new Uint8Array(4));
      const output = input.slice(); output.set(rgba(to), 4); return output;
    });
    const texturePixelSceneForBiome = vi.fn((_name: string, input: Uint8Array) => ({ pixels: input.slice(), airMask: null }));
    const painted = paintTerrainScene(scene, { data, width: 3, height: 1 }, { recolorPixelScene, texturePixelSceneForBiome });
    expect(painted.pixels).toEqual(Uint8Array.from([0, 0, 0, 0, ...rgba(0xebcd01, 0xebcd01)]));
    expect(recolorPixelScene).toHaveBeenCalledOnce();
    expect(texturePixelSceneForBiome).toHaveBeenCalledOnce();
    expect(data).toEqual(rgba(0x9dd0b0, 0xf0bbee, 0xebcd01));
  });
});
