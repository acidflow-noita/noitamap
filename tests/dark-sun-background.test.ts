import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { MOON_BOUNDS } from '../src/portals/suns/moon-patches';
import { WORLD_TOP } from '../src/telescope/terrain-policy';

const source = readFileSync('public/biome_bg/background_the_end.png');
const raw = decode(source);
const bounds = MOON_BOUNDS.dark_sun;
const phaseX = -17920, phaseY = WORLD_TOP;

describe('Dark Moon replacement artwork', () => {
  it.each([false, true])('matches the surrounding Hell texture at every pixel (baked=%s)', async baked => {
    const patch = await loadImage(readFileSync(`src/portals/assets/backgrounds/dark-sun-hell${baked ? '-baked' : ''}.png`));
    expect([patch.width, patch.height]).toEqual([bounds.width, bounds.width]);
    const actual = createCanvas(bounds.width, bounds.width).getContext('2d');
    // A colored Moon underneath must not show through transparent texture gaps.
    actual.fillStyle = '#00ffff'; actual.fillRect(0, 0, bounds.width, bounds.width);
    actual.drawImage(patch, 0, 0);
    const expected = createCanvas(bounds.width, bounds.width).getContext('2d');
    expected.fillStyle = '#000'; expected.fillRect(0, 0, bounds.width, bounds.width);
    if (baked) {
      // The baker consumes raw PNG RGB values, without browser color conversion.
      const pixels = expected.createImageData(bounds.width, bounds.width);
      for (let y = 0; y < bounds.width; y++) for (let x = 0; x < bounds.width; x++) {
        const tx = (bounds.x + x - phaseX) % raw.width;
        const ty = (bounds.y + y - phaseY) % raw.height;
        const input = (ty * raw.width + tx) * raw.channels, output = (y * bounds.width + x) * 4;
        pixels.data.set(raw.data.subarray(input, input + 3), output);
        pixels.data[output + 3] = 255;
      }
      expected.putImageData(pixels, 0, 0);
    } else {
      // The live background repeats the decoded original PNG at native scale.
      const image = await loadImage(source);
      expected.translate(-bounds.x, -bounds.y);
      const left = Math.floor((bounds.x - phaseX) / image.width) * image.width + phaseX;
      const top = Math.floor((bounds.y - phaseY) / image.height) * image.height + phaseY;
      for (let y = top; y < bounds.y + bounds.width; y += image.height)
        for (let x = left; x < bounds.x + bounds.width; x += image.width) expected.drawImage(image, x, y);
    }
    const a = actual.getImageData(0, 0, bounds.width, bounds.width).data;
    const e = expected.getImageData(0, 0, bounds.width, bounds.width).data;
    expect(Buffer.from(a).equals(Buffer.from(e))).toBe(true);
    expect(a.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
  });
});
