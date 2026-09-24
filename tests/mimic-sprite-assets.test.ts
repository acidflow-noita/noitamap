import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import atlas from '../src/data/atlas.json';
import spritesheetRevision from '../src/data/spritesheet-revision.json';
import { getMimicEntityId, getMimicSpriteKey } from '../src/telescope/poi-mimics';

const variants = [
  ['mimic', 'chest_mimic'], ['chest_leggy', 'chest_leggy'], ['heart_mimic', 'dark_alchemist'],
  ['refresh_mimic', 'shaman_wind'], ['mimic_potion', 'mimic_potion'],
];
interface DecodedPNG { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: { sync: { read(data: Buffer): DecodedPNG } } };
let zip: JSZip, sheet: DecodedPNG;
const png = readFileSync(new URL('../public/assets/spritesheet.png', import.meta.url));
beforeAll(async () => {
  zip = await JSZip.loadAsync(readFileSync(new URL('../public/data.zip', import.meta.url)));
  sheet = PNG.sync.read(png);
});

describe('canonical mimic artwork', () => {
  it.each(variants)('%s uses the actual game animal icon for %s in both emitted shapes', async (item, entity) => {
    const source = zip.file(`data/ui_gfx/animal_icons/${entity}.png`);
    expect(source).not.toBeNull();
    const icon = PNG.sync.read(await source!.async('nodebuffer'));
    const key = getMimicSpriteKey({ type: 'item', item })!;
    expect(getMimicSpriteKey({ type: 'entity', entity: `data/entities/animals/${entity}.xml` })).toBe(key);
    const entry = (atlas as Record<string, { x: number; y: number; w: number; h: number }>)[key];
    expect(entry).toMatchObject({ w: icon.width, h: icon.height });
    for (let row = 0; row < icon.height; row++) {
      const start = ((entry.y + row) * sheet.width + entry.x) * 4;
      expect(sheet.data.subarray(start, start + icon.width * 4)).toEqual(icon.data.subarray(row * icon.width * 4, (row + 1) * icon.width * 4));
    }
  });

  it('versions the image by its actual bytes so cached sheets cannot mismatch a new atlas', () => {
    expect(spritesheetRevision).toBe(createHash('sha256').update(png).digest('hex'));
  });

  it('does not turn ordinary pickups or unrelated entities into mimics', () => {
    for (const item of ['heart', 'spell_refresh', 'potion', 'potion_mimic_empty', 'chest', 'constructor'])
      expect(getMimicEntityId({ type: 'item', item })).toBeNull();
    expect(getMimicEntityId({ type: 'entity', entity: 'lukki' })).toBeNull();
  });
});
