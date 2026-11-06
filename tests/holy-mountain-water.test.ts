import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeLiquidMask } from '../src/liquids/mask-codec';
import { LiquidMaskIndex } from '../src/liquids/mask-index';
import { decodePngToRgba } from '../src/telescope/png-decode';
import { MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';
import manifest from '../src/liquids/holy-mountain-water.json';

const compressed = readFileSync(new URL('../src/liquids/assets/holy-mountain-water.bin.gz', import.meta.url));
const raw = gunzipSync(compressed), blocks = decodeLiquidMask(raw), index = new LiquidMaskIndex(blocks);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function mask(x: number, y: number, width: number, height: number) {
  const pixels = new Uint8Array(width * height); index.paint(pixels, { x, y, width, height }); return pixels;
}
function png(path: string) {
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
  return decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe('Holy Mountain water-only artifact', () => {
  it('has bounded size, verified source provenance and eighteen captured water pools', () => {
    expect(compressed.byteLength).toBeLessThan(2048);
    expect(hash(compressed)).toBe(manifest.artifact.sha256);
    expect(hash(raw)).toBe(manifest.artifact.rawSha256);
    expect(blocks).toHaveLength(36); // Two lower-room sections per pool, six per world.
    expect(blocks.reduce((n, block) => n + [...block.runs].filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0), 0)).toBe(174114);
    for (const source of manifest.sourceChecks)
      expect(hash(readFileSync(new URL(`../${source.path}`, import.meta.url))), source.path).toBe(source.sha256);
  });

  it('matches only authored water in every lower Holy Mountain room at the Lua offset', () => {
    const biome = png('lib/noita-telescope-vm/data/biome_maps/biome_map.png');
    const materials = new Map<number, string>((WANG_COLOR_TO_ID as [number, number][])
      .map(([color, id]) => [color, MATERIAL_NAMES_BY_ID[id]]));
    const rooms = new Map([[0x93cb4c, 'altar'], [0x93cb4d, 'altar_left'],
      [0x93cb4e, 'altar_right'], [0x93cb4f, 'altar_right_snowcastle'], [0x93cb5a, 'altar_right_snowcastle']]);
    let waterPixels = 0;
    for (let p = 0; p < biome.width * biome.height; p++) {
      const i = p * 4, room = rooms.get((biome.data[i] << 16) | (biome.data[i + 1] << 8) | biome.data[i + 2]);
      if (!room) continue;
      const scene = png(`lib/noita-telescope-vm/data/pixel_scenes/temple/${room}.png`);
      const expected = new Uint8Array(scene.width * scene.height);
      for (let n = 0; n < expected.length; n++) {
        const j = n * 4, rgb = (scene.data[j] << 16) | (scene.data[j + 1] << 8) | scene.data[j + 2];
        expected[n] = scene.data[j + 3] && materials.get(rgb) === 'water' ? 255 : 0;
      }
      const x = (p % biome.width) * 512 - 17920, y = (Math.floor(p / biome.width) - 14) * 512 + 260;
      for (const offset of [-35840, 0, 35840]) {
        expect(Buffer.from(mask(x + offset, y, scene.width, scene.height)).equals(Buffer.from(expected)),
          `${room} at ${x + offset},${y}`).toBe(true);
        waterPixels += expected.filter(Boolean).length;
      }
    }
    expect(waterPixels).toBe(174114); // Accounts for every enabled pixel, with no extras elsewhere.
    expect(mask(-571, 1401, 183, 1).some(Boolean)).toBe(false);
    expect(mask(-571, 1402, 183, 1).some(Boolean)).toBe(true);
  });

  it.each([-35840, 0, 35840])('leaves portal basins, teleportation cups and other liquids still in world %s', offset => {
    for (const [x, y, width, height] of [[-1536, 984, 3584, 300], [528, 1984, 200, 120],
      [-4096, 13312, 512, 512], [-5120, 512, 512, 512], [-14848, 512, 512, 512]])
      expect(mask(x + offset, y, width, height).some(Boolean), `${x + offset},${y}`).toBe(false);
  });
});
