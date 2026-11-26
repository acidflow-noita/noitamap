import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { addNGPlusWater, ngPlusWaterPlacements } from '../src/telescope/ng-plus-water';
import { decodePngToRgba } from '../src/telescope/png-decode';
import { compositeTerrain, textureColor } from '../src/telescope/terrain-backgrounds';
import { captureWorlds } from '../src/telescope/world-coverage';
import { createMaterialField } from '../lib/noita-telescope-vm/js/engine_resolve/material_field.js';
import { MATERIAL_NAMES_BY_ID, MATERIAL_FLAT_RGB_BY_ID, MATERIAL_FLAT_ALPHA_BY_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';

const width = 64, worlds = captureWorlds('normal', true);
const cell = (x: number, y: number) => (y + 14) * width + x + width / 2;

it('draws only Water cells in the final NG+ map and only in the selected captured worlds', () => {
  const pixels = new Uint32Array(width * 48);
  pixels[cell(28, 8)] = 0xff0000ff;
  const placed = ngPlusWaterPlacements(pixels, width, worlds);
  expect(placed.map(p => p.osdX / 512).sort((a, b) => a - b)).toEqual([-100, -36, 28, 92]);
  expect(placed.every(p => p.osdY === 4096 && p.w === 512 && p.h === 512)).toBe(true);
  expect(ngPlusWaterPlacements(pixels, width, [0])).toHaveLength(1);
  pixels[cell(28, 8)] = 0xff006c42; // A seed's Magical Temple cave can replace a template cell.
  expect(ngPlusWaterPlacements(pixels, width, worlds)).toEqual([]);
});

it('matches initial game materials and the cave backdrop at native pixels, including wobbled edges', async () => {
  const zip = await JSZip.loadAsync(readFileSync('public/data.zip'));
  const png = async (name: string) => decodePngToRgba(await zip.file(name)!.async('arraybuffer'));
  const template = await png('data/biome_impl/biome_map_newgame_plus.png');
  const backdrop = await png('data/weather_gfx/background_cave_04.png');
  const pixels = Uint32Array.from({ length: width * 48 }, (_, i) =>
    (0xff000000 | template.data[4*i] << 16 | template.data[4*i+1] << 8 | template.data[4*i+2]) >>> 0);
  const placements = ngPlusWaterPlacements(pixels, width, worlds);
  expect(placements).toHaveLength(18);
  const water = MATERIAL_NAMES_BY_ID.indexOf('water');
  const tint = ((MATERIAL_FLAT_ALPHA_BY_ID[water] << 24) | MATERIAL_FLAT_RGB_BY_ID[water]) >>> 0;
  const field = createMaterialField([], { pixels }, {}, width, 1830516114, {
    lattice: { GW: 1, GH: 1, cov: new Float32Array(1), mat: new Uint16Array(1), chunkCovered: new Uint8Array(pixels.length) },
  });
  for (const { osdX, osdY } of placements) {
    const image = await loadImage(readFileSync(`src/telescope/assets/ng-plus-water/${osdX/512}_${osdY/512}.png`));
    expect([image.width, image.height]).toEqual([512, 512]);
    const context = createCanvas(512, 512).getContext('2d');
    context.drawImage(image, 0, 0);
    const art = context.getImageData(0, 0, 512, 512);
    let wet = 0, dry = 0, mismatches = 0;
    for (let y = 0; y < 512; y += 7) for (let x = 0; x < 512; x += 7) {
      const wx = osdX + x, wy = osdY + y, p = (y * 512 + x) * 4;
      if (field.materialAt(wx, wy) !== water) {
        dry++;
        if (art.data[p + 3] !== 0) mismatches++;
      } else {
        wet++;
        if (textureColor(art, x, y) !== compositeTerrain(tint, textureColor(backdrop, wx, wy))) mismatches++;
      }
    }
    expect({ mismatches, hasWater: wet > 0, hasBoundary: dry > 0 }).toEqual({ mismatches: 0, hasWater: true, hasBoundary: true });
  }
});

it('displays prebuilt artwork below seed overlays using only the saved biome grid', async () => {
  vi.stubGlobal('OpenSeadragon', { TileSource: class {
    getClosestLevel() { return 0; }
    tileExists() { return true; }
  } });
  const image = await loadImage(readFileSync('src/telescope/assets/ng-plus-water/28_8.png'));
  const close = vi.fn();
  const fetcher = vi.fn(async () => new Response('image'));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('createImageBitmap', async () => Object.assign(image, { close }));
  const viewer = { addTiledImage: vi.fn(), forceRedraw: vi.fn(), world: { removeItem: vi.fn() } };
  const pixels = new Uint32Array(width * 48);
  pixels[cell(28, 8)] = 0xff0000ff;
  try {
    addNGPlusWater(viewer, pixels, width, [0], 7, 3, () => true, () => {});
    const options = viewer.addTiledImage.mock.calls[0][0];
    expect(options.index).toBe(3);
    const source = options.tileSource;
    const ctx = createCanvas(64, 64).getContext('2d');
    const draw = (x: number, y: number) => source.__drawViewport(ctx, {
      imageToViewportCoordinates: (a: number, b: number) => ({ x: a + options.x - x, y: b + options.y - y }),
    }, { pixelFromPoint: (p: unknown) => p });
    draw(0, 0);
    expect(fetcher).not.toHaveBeenCalled();
    draw(14592, 4352);
    await vi.waitFor(() => expect(viewer.forceRedraw).toHaveBeenCalled());
    draw(14592, 4352);
    expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([46, 70, 61, 255]);
    expect(fetcher).toHaveBeenCalledOnce();
    source.destroy();
    expect(close).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
