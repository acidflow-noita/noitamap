import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { MATERIAL_NAMES_BY_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';
import { loadNGPlusSurfaceLandmarkMasks } from '../src/telescope/ng-plus-surface-landmarks';
import { createNGPlusSurfaceRaster } from '../src/telescope/ng-plus-surface-raster';

// Encode the sampler's native material identity into RG for comparison with
// the game's MATDUMP files. The production atlas and EdgeGraphics are exercised
// separately by the native surface renderer.
vi.mock('noita-telescope-full-pixels/engine_resolve/material_field.js', async () =>
  import('../lib/noita-telescope-vm/js/engine_resolve/material_field.js'));
vi.mock('noita-telescope-full-pixels/engine_resolve/band_select.js', async () =>
  import('../lib/noita-telescope-vm/js/engine_resolve/band_select.js'));
vi.mock('../src/data-archive', () => ({
  async getDataZip() { return (await import('jszip')).default.loadAsync(readFileSync('public/data.zip')); },
}));
vi.mock('noita-telescope-full-pixels/gl/material_atlas.js', () => ({
  initMaterialAtlas: () => ({}), materialTexelRGBA: vi.fn(),
}));
vi.mock('noita-telescope-full-pixels/gl/engine_resources.js', () => ({
  buildMatColorTable: () => {
    const data = new Uint16Array(512 * 4);
    for (let id = 0; id < 512; id++) { data[id * 4] = 255 << 8; data[id * 4 + 1] = id >> 8; data[id * 4 + 2] = id & 255; }
    return { data };
  },
}));
vi.mock('../src/telescope/terrain-edges', () => ({ createTerrainEdges: () => ({ paint() {} }) }));

const width = 64;
const indexAt = (x: number, y: number) => ((Math.floor(x / 512) + width / 2) % width + width) % width
  + (Math.floor(y / 512) + 14) * width;
const winter = 0xffd6d8e3, desert = 0xffcc9944;

it.each([
  ['winter_surface_line_materials', winter], ['desert_surface_materials', desert],
  ['winter_surface_pw2_air', winter], ['desert_surface_pw2_materials', desert],
] as const)('matches the game material dump for %s', async (name, biome) => {
  const dir = 'lib/noita-telescope-vm/test/fixtures/regression/';
  const fixture = JSON.parse(readFileSync(dir + name + '.json', 'utf8'));
  const { x, y, w, h } = fixture.world;
  const pixels = new Uint32Array(width * 48).fill(biome);
  const cells = new Set<number>();
  for (const wx of [x, x + w - 1]) for (const wy of [y, y + h - 1]) cells.add(indexAt(wx, wy));
  const render = await createNGPlusSurfaceRaster(fixture.seed, pixels, Uint16Array.from(cells), []);
  const output = render(x, y, w, h, 1);
  const expected = readFileSync(dir + fixture.expected.file);
  const palette = fixture.expected.palette.map((id: string) => MATERIAL_NAMES_BY_ID.indexOf(id));
  let matches = 0;
  for (let i = 0; i < w * h; i++) {
    const id = output[i * 4] << 8 | output[i * 4 + 1];
    if (output[i * 4 + 3] === 255 && id === palette[expected.readUInt16LE(i * 2)]) matches++;
  }
  expect(100 * matches / (w * h)).toBeGreaterThanOrEqual(fixture.tier1.pixels.threshold);
});

it('retains landmarks, unchanged cells and high sky at their actual sample coordinates', async () => {
  const x = -301, y = -200, pixels = new Uint32Array(width * 48).fill(desert);
  const mask = { x, y, width: 4, height: 1, bits: Uint8Array.of(1), airBits: Uint8Array.of(4) };
  const render = await createNGPlusSurfaceRaster(1234, pixels, Uint16Array.of(indexAt(x, y)), [mask]);
  const alpha = (data: Uint8ClampedArray) => Array.from(data.filter((_, i) => i % 4 === 3));
  expect(alpha(render(x - 1, y, 6, 1, 1))).toEqual([255, 0, 255, 0, 255, 255]);
  expect(alpha(render(x - 1, y - 1, 3, 1, 2))).toEqual([0, 0, 255]);
  expect(alpha(render(x + width * 512, y, 4, 1, 1))).toEqual([255, 255, 255, 255]);
  expect(alpha(render(x + 512, y, 1, 1, 1))).toEqual([0]);
  const highSky = await createNGPlusSurfaceRaster(1234, pixels, Uint16Array.of(indexAt(x, -4096)), []);
  expect(alpha(highSky(x, -4096, 1, 1, 1))).toEqual([0]);
});

it.each([
  [winter, 'snowrock_static', 'snowrock_static', 'snow_static'],
  [desert, 'rock_static', 'sand_static', 'air'],
] as const)('uses the replacement biome for Mountain Lake’s density-written bank (%s)', async (biome, east, west, untouched) => {
  const pixels = new Uint32Array(width * 48).fill(biome);
  const landmarks = await loadNGPlusSurfaceLandmarkMasks();
  const render = await createNGPlusSurfaceRaster(1244794027, pixels, Uint16Array.of(indexAt(2560, 0)), landmarks);
  const material = (x: number, y: number, step = 1) => {
    const [r, g, , alpha] = render(x, y, 1, 1, step);
    return alpha === 255 ? MATERIAL_NAMES_BY_ID[r << 8 | g] : null;
  };
  // Scene gray 193 and 203 both request density 1 at their absolute position.
  expect(material(3055, 150)).toBe(east);
  expect(material(3054, 149, 2)).toBe(east);
  expect(material(2640, 240)).toBe(west);
  expect(material(2669, 0)).toBeNull(); // Authored force-air keeps the capture.
  expect(material(2560, 0)).toBe(untouched); // Black sentinel leaves ordinary generation.
});
