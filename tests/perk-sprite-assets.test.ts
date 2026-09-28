import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import atlas from '../src/data/atlas.json';

const { PNG } = createRequire(import.meta.url)('pngjs');

it('bakes both Stainless Armour icons from the original local game pixels', async () => {
  const zip = await JSZip.loadAsync(readFileSync(new URL('../public/data.zip', import.meta.url)));
  const sheet = PNG.sync.read(readFileSync(new URL('../public/assets/spritesheet.png', import.meta.url)));
  for (const [key, path] of [
    ['item:perks/stainless_armour', 'data/items_gfx/perks/stainless_armour.png'],
    ['perk:stainless_armour', 'data/ui_gfx/perk_icons/stainless_armour.png'],
  ]) {
    const icon = PNG.sync.read(await zip.file(path)!.async('nodebuffer'));
    const entry = (atlas as Record<string, { x: number; y: number; w: number; h: number }>)[key];
    expect(entry).toMatchObject({ w: icon.width, h: icon.height });
    for (let row = 0; row < icon.height; row++) {
      const start = ((entry.y + row) * sheet.width + entry.x) * 4;
      expect(sheet.data.subarray(start, start + icon.width * 4)).toEqual(
        icon.data.subarray(row * icon.width * 4, (row + 1) * icon.width * 4),
      );
    }
  }
});
