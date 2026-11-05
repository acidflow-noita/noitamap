/** Prepare one opaque, world-aligned Hell patch. No runtime canvas work.
 * Run: node --import tsx build_scripts/build-dark-sun-background.mts */
import { readFile, writeFile } from 'node:fs/promises';
import { decode, encode } from 'fast-png';
import { MOON_BOUNDS } from '../src/portals/suns/moon-patches';
import { WORLD_TOP } from '../src/telescope/terrain-policy';

const root = new URL('../', import.meta.url);
const original = await readFile(new URL('public/biome_bg/background_the_end.png', root));
const texture = decode(original);
const { x, y, width } = MOON_BOUNDS.dark_sun;
if (texture.channels !== 3 || texture.depth !== 8 || texture.palette ||
  !texture.transparency?.every(value => value === 0)) throw new Error('Unexpected Hell background format');
// Same native-pixel repetition and phase as biome-background-layer.ts.
const phaseX = -17920, phaseY = WORLD_TOP;
const modulo = (value: number, size: number) => ((value % size) + size) % size;
const pixels = new Uint8Array(width * width * 3);
for (let row = 0; row < width; row++) for (let column = 0; column < width; column++) {
  const input = (modulo(y + row - phaseY, texture.height) * texture.width +
    modulo(x + column - phaseX, texture.width)) * 3;
  pixels.set(texture.data.subarray(input, input + 3), (row * width + column) * 3);
}
// Opaque RGB intentionally turns the texture's transparent black into black:
// transparent holes in a replacement would expose the old Moon underneath.
const baked = Buffer.from(encode({ width, height: width, channels: 3, depth: 8, data: pixels }));
// Live layers decode the original PNG in the browser; bakes use raw PNG values.
// Preserve original color metadata for the live patch and omit it for the
// baked patch, matching each existing path without changing either renderer.
const colorChunks: Buffer[] = [];
for (let offset = 8; offset < original.length;) {
  const size = original.readUInt32BE(offset), type = original.toString('ascii', offset + 4, offset + 8);
  if (['gAMA', 'sRGB', 'iCCP', 'cHRM'].includes(type)) colorChunks.push(original.subarray(offset, offset + size + 12));
  offset += size + 12;
}
const live = Buffer.concat([baked.subarray(0, 33), ...colorChunks, baked.subarray(33)]);
for (const [name, bytes] of [['dark-sun-hell.png', live], ['dark-sun-hell-baked.png', baked]] as const)
  await writeFile(new URL(`src/portals/assets/backgrounds/${name}`, root), bytes);
console.log(`Prepared ${width}x${width} Hell backgrounds at (${x}, ${y}), ${live.length + baked.length} bytes total.`);
