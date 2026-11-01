// Two initial stills, not an animation atlas. Never runs in the visitor's browser.
import fs from 'node:fs/promises';
import sharp from 'sharp';
import structures from '../src/data/structures.json' with { type: 'json' };
import { SunRenderer, SUN_SIZE } from '../src/portals/suns/renderer.mjs';
import { nativeSunGL } from '../tests/helpers/native-sun-gl.mjs';

const root = new URL('../src/portals/suns/', import.meta.url);
const bytes = await fs.readFile(new URL('effects.bin', root));
const native = nativeSunGL();
globalThis.OffscreenCanvas = native.Canvas;
const renderer = new SunRenderer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 0);
try {
for (const [effect, name, filename] of [['sun', 'Sun/Moon', 'sun-preview.webp'], ['dark_sun', 'Dark Sun/Dark Moon', 'dark-sun-preview.webp']]) {
  const { x, y } = structures.find(place => place.name === name);
  const stats = renderer.render(effect, x, y, 0, SUN_SIZE);
  const rgba = native.read(SUN_SIZE, SUN_SIZE);
  // GLES output is premultiplied alpha, image encoders expect straight alpha.
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    for (let c = 0; c < 3; c++) rgba[i + c] = alpha ? Math.min(255, Math.round(rgba[i + c] * 255 / alpha)) : 0;
  }
  const output = await sharp(rgba, { raw: { width: SUN_SIZE, height: SUN_SIZE, channels: 4 } })
    .flip().resize(512, 512).webp({ lossless: true }).toBuffer();
  await fs.writeFile(new URL(filename, root), output);
  console.log(`${filename}: ${output.length} bytes, ${stats.estimatedGPUBytes} GPU bytes`);
}
} finally { renderer.dispose(); native.dispose(); }
