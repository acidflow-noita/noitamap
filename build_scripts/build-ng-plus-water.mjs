// Rebuild the fixed water artwork with: node --import tsx build_scripts/build-ng-plus-water.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { GENERATOR_CONFIG } from '../lib/noita-telescope-vm/js/generator_config.js';
import { BIOME_ENGINE, MATERIAL_NAMES_BY_ID, MATERIAL_FLAT_RGB_BY_ID, MATERIAL_FLAT_ALPHA_BY_ID } from '../lib/noita-telescope-vm/js/engine_resolve/engine_data.js';
import { resolveCellFull } from '../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js';
import { captureWorlds, visibleWorldSpan } from '../src/telescope/world-coverage.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'src/telescope/assets/ng-plus-water');
const game = await JSZip.loadAsync(await readFile(join(root, 'public/data.zip')));
const backdropPath = (await game.file('data/biome/water.xml').async('string')).match(/background_image="([^"]+)"/)[1];
const background = PNG.sync.read(await game.file(backdropPath).async('nodebuffer'));
const template = PNG.sync.read(await game.file('data/biome_impl/biome_map_newgame_plus.png').async('nodebuffer'));
const width = template.width, chunk = 512;
const colors = Uint32Array.from({ length: width * template.height }, (_, i) => template.data.readUInt32BE(4 * i) >>> 8);
const water = GENERATOR_CONFIG.water.color & 0xffffff;
const noise = new Map(BIOME_ENGINE.map(b => [b.color, b.noiseBiomeEdges]));
const hasNoise = color => noise.get(color) !== false;
const grid = { w: width, colorAt: (x, y) => colors[y * width + x] };
const id = MATERIAL_NAMES_BY_ID.indexOf('water');
const rgb = MATERIAL_FLAT_RGB_BY_ID[id], alpha = MATERIAL_FLAT_ALPHA_BY_ID[id];
// Use opaque, already composited art: the empty-world capture contains pools
// at different stages of drainage and must not supply a second water tint.
const wet = Buffer.from(background.data);
for (let i = 0; i < wet.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const channel = (rgb >>> (16 - 8 * c)) & 255;
    wet[i + c] = Math.round((channel * alpha + wet[i + c] * (255 - alpha)) / 255);
  }
}

await mkdir(output, { recursive: true });
for (const pw of captureWorlds('normal', true)) {
  const span = visibleWorldSpan(pw, width * chunk, 'normal', true);
  for (const [i, color] of colors.entries()) {
    if (color !== water) continue;
    const cx = i % width - width / 2 + pw * width, cy = Math.floor(i / width) - 14;
    const left = cx * chunk, top = cy * chunk;
    if (left < span.minX || left >= span.minX + span.width) continue;
    const pixels = Buffer.alloc(chunk * chunk * 4), cell = {};
    for (let y = 0; y < chunk; y++) for (let x = 0; x < chunk; x++) {
      resolveCellFull(grid, left + x, top + y, hasNoise, cell);
      if (cell.color !== water) continue;
      const tx = ((left + x) % background.width + background.width) % background.width;
      const ty = ((top + y) % background.height + background.height) % background.height;
      const src = 4 * (ty * background.width + tx);
      wet.copy(pixels, 4 * (y * chunk + x), src, src + 4);
    }
    const png = await sharp(pixels, { raw: { width: chunk, height: chunk, channels: 4 } })
      .png({ palette: true, colours: 8, dither: 0, compressionLevel: 9 }).toBuffer();
    await writeFile(join(output, `${cx}_${cy}.png`), png);
  }
}
