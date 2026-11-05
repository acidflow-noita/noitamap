import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { decodeLiquidMask, paintMaskBlock, type LiquidMaskBlock } from '../src/liquids/mask-codec';
import { liquidMaterialIds } from '../src/liquids/materials';
import { decodePngToRgba } from '../src/telescope/png-decode';
import { StaticMaskBuilder, sceneMaterialAt, fixedScenePlacements, rectangularPolygonMask, capturedSpawnedScenePlacements } from '../build_scripts/build-static-liquid-masks.mts';
import { WANG_COLOR_TO_ID, MATERIAL_NAMES_BY_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';

const manifest = JSON.parse(readFileSync(new URL('../src/liquids/static-sources.json', import.meta.url), 'utf8'));
const compressed = new Uint8Array(readFileSync(new URL('../src/liquids/assets/static-mask.bin.gz', import.meta.url)));
const bytes = new Uint8Array(gunzipSync(compressed));
const blocks = decodeLiquidMask(bytes);
const wang = new Map<number, number>(WANG_COLOR_TO_ID as [number, number][]);
let eligible: Set<number>;
let zip: JSZip;
beforeAll(async () => {
  zip = await JSZip.loadAsync(readFileSync(new URL('../public/data.zip', import.meta.url)));
  eligible = liquidMaterialIds(await zip.file('data/materials.xml')!.async('string'), MATERIAL_NAMES_BY_ID);
});

function source(key: string) {
  const bytes = readFileSync(new URL(`../lib/noita-telescope-vm/data/pixel_scenes/${key}.png`, import.meta.url));
  return decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function rect(x: number, y: number, width: number, height: number, list: LiquidMaskBlock[] = blocks) {
  const out = new Uint8Array(width * height);
  for (const block of list) if (block.x < x + width && block.y < y + height && block.x + block.width > x && block.y + block.height > y)
    paintMaskBlock(block, out, x, y, width, height, 1);
  return out;
}
function authoredMask(key: string) {
  const raw = source(key), pixels = new Uint8Array(raw.width * raw.height);
  for (let p = 0; p < pixels.length; p++) {
    const i = p * 4, rgb = (raw.data[i] << 16) | (raw.data[i + 1] << 8) | raw.data[i + 2];
    pixels[p] = raw.data[i + 3] && eligible.has(wang.get(rgb) ?? -1) ? 1 : 0;
  }
  return { ...raw, pixels };
}

describe('captured liquid mask provenance and boundaries', () => {
  it('is the reviewed sparse artifact for this capture identity', () => {
    expect(manifest.capture.mapKey).toBe('dynamic-main-branch');
    expect(manifest.capture.materialSeed).toBe(786433191);
    expect(manifest.capture.filenameSeed).toBe(78633191);
    expect(createHash('sha256').update(compressed).digest('hex')).toBe(manifest.artifact.sha256);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.artifact.rawSha256);
    expect(blocks.length).toBe(manifest.artifact.blocks);
    expect(new Set(blocks.map(b => `${b.x},${b.y}`)).size).toBe(blocks.length);
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.polygonBiomes[0].nativePixelRange).toEqual({ x: [1, 511], y: [11, 511] });
    expect(manifest.coverage.gaps.some((gap: string) => gap.includes('pyramid') || gap.includes('parallel-world'))).toBe(false);
  });

  it('still matches the reviewed material, Lua placement, generator and template sources', async () => {
    for (const check of manifest.sourceChecks) {
      const data = check.archive ? await zip.file(check.path)!.async('uint8array')
        : readFileSync(new URL(`../${check.path}`, import.meta.url));
      expect(createHash('sha256').update(data).digest('hex'), check.path).toBe(check.sha256);
    }
  });

  it.each([
    ['temple/altar_left', -1024, 1284, 4688],
    ['temple/altar', -512, 1284, 4985],
    ['general/secret_lab', -5120, 512, 1802],
    ['excavationsite/cube_chamber', -4608, 2048, 1114],
    ['temple/altar_top_blood', -1024, 984, 21511],
    ['temple/altar_top', -1536, 984, 355],
  ])('preserves every authored liquid boundary in %s at (%i,%i)', (key, x, y, count) => {
    const raw = authoredMask(String(key));
    expect(raw.pixels.reduce((a, b) => a + b, 0)).toBe(count);
    expect(rect(Number(x), Number(y), raw.width, raw.height)).toEqual(raw.pixels);
  });

  it('places the Holy Mountain lower rooms at the Lua offset, not the scanner offset', () => {
    const bytes = readFileSync(new URL('../lib/noita-telescope-vm/data/biome_maps/biome_map.png', import.meta.url));
    const map = decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pixels = new Uint32Array(map.width * map.height);
    for (let p = 0; p < pixels.length; p++) pixels[p] = (map.data[p * 4] << 16) | (map.data[p * 4 + 1] << 8) | map.data[p * 4 + 2];
    const placements = fixedScenePlacements(manifest, pixels, map.width);
    expect(placements).toContainEqual(expect.objectContaining({ key: 'temple/altar_left', x: -1024, y: 1284 }));
    expect(placements).not.toContainEqual(expect.objectContaining({ key: 'temple/altar_left', x: -1024, y: 1280 }));
    for (const check of manifest.capture.verification) {
      const suffix = check.material === 'air' ? '' : check.material === 'radioactive_liquid' ? '_radioactive' : `_${check.material}`;
      expect(placements).toContainEqual(expect.objectContaining({ key: `temple/altar_top${suffix}`, x: check.sceneX, y: check.sceneY }));
    }
  });

  it.each(manifest.capture.verification.filter((v: any) => v.world).map((v: any) =>
    [v.world, v.tile, v.sceneX, v.sceneY, v.material] as [string, string, number, number, string]) as [string, string, number, number, string][])(
    'matches the source geometry verified in the %s capture tile %s', (_world, _tile, x, y, material) => {
      const suffix = material === 'radioactive_liquid' ? 'radioactive' : String(material);
      const raw = authoredMask(`temple/altar_top_${suffix}`);
      expect(rect(Number(x), Number(y), raw.width, raw.height)).toEqual(raw.pixels);
    });

  it('includes the authored volcanic-lake polygon with native integer sampling and boundary rules', async () => {
    const xml = await zip.file('data/biome/lava_90percent.xml')!.async('string');
    const pixels = rectangularPolygonMask(xml);
    expect(pixels.slice(0, 11 * 512).some(Boolean)).toBe(false);
    for (let y = 11; y < 512; y++) {
      expect(pixels[y * 512]).toBe(0);
      expect(pixels.subarray(y * 512 + 1, (y + 1) * 512).every(Boolean)).toBe(true);
    }
    expect(pixels.reduce((sum, value) => sum + value, 0)).toBe(501 * 511);
    expect(rect(-4096, 13312, 512, 512)).toEqual(pixels);
    expect(() => rectangularPolygonMask(xml.replace('x="1" y="0.02"', 'x="0.9" y="0.02"'))).toThrow();
  });

  it('checks captured pyramid scene generation and confirms there are no omitted fluid rooms', async () => {
    const { generate } = await import('../lib/noita-telescope-vm/test/helpers/generate.mjs');
    const world = await generate({ seed: manifest.capture.materialSeed });
    const scenes = await capturedSpawnedScenePlacements(manifest, world);
    expect(scenes.length).toBe(96);
    expect([...new Set(scenes.map(s => s.key))].sort()).toEqual(['crypt/stairs_left', 'crypt/stairs_right']);
    for (const key of new Set(scenes.map(s => s.key))) expect(authoredMask(key).pixels.some(Boolean)).toBe(false);
    expect(manifest.coverage.spawnedSceneAudit).toEqual([
      { key: 'crypt/stairs_left', instances: 42 }, { key: 'crypt/stairs_right', instances: 54 },
    ]);
  });

  it('keeps source solid and force-air pixels out of an overlapping liquid mask', () => {
    const store = new StaticMaskBuilder(), x = -512, y = -512;
    store.set(x, y, new Uint8Array(512 * 512).fill(1));
    const water = [...wang].find(([_, id]) => MATERIAL_NAMES_BY_ID[id] === 'water')![0];
    const brick = [...wang].find(([_, id]) => MATERIAL_NAMES_BY_ID[id] === 'templebrick_static')![0];
    const colors = [0, 0x42, brick, water, 0xff13c7];
    const data = new Uint8ClampedArray(colors.flatMap(c => [c >>> 16, (c >>> 8) & 255, c & 255, 255]));
    store.stamp({ data, width: 5, height: 1 }, { key: 'test', x, y }, eligible, () => 0);
    expect([...rect(x, y, 5, 1, store.finish())]).toEqual([1, 0, 0, 1, 0]);
  });

  it('resolves source substitutions before classifying material identity', () => {
    const water = [...wang].find(([_, id]) => MATERIAL_NAMES_BY_ID[id] === 'water')![0];
    const lava = [...wang].find(([_, id]) => MATERIAL_NAMES_BY_ID[id] === 'lava')![0];
    const raw = { width: 1, height: 1, data: new Uint8ClampedArray([water >>> 16, (water >>> 8) & 255, water & 255, 255]) };
    const id = sceneMaterialAt(raw, 0, { key: 'test', x: 0, y: 0, substitutions: { [water.toString(16)]: lava.toString(16) } }, () => 0);
    expect(MATERIAL_NAMES_BY_ID[id!]).toBe('lava');
    expect(eligible.has(id!)).toBe(true);
  });

  it('retains solid and ice eye chambers while including the source meditation blood', () => {
    expect(rect(3584, 4096, 512, 512).some(Boolean)).toBe(false);
    expect(rect(-4096, 5120, 512, 512).some(Boolean)).toBe(false);
    expect(rect(-4608, 2048, 512, 512).reduce((a, b) => a + b, 0)).toBe(1114);
  });
});
