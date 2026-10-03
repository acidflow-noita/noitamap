import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import sharp from 'sharp';
import atlas from '../src/data/atlas.json';

const { PNG } = createRequire(import.meta.url)('pngjs');
let zip: JSZip;
let sheet: { width: number; data: Buffer };
const entries = atlas as Record<string, { x: number; y: number; w: number; h: number; ox?: number; oy?: number }>;

beforeAll(async () => {
  zip = await JSZip.loadAsync(readFileSync(new URL('../public/data.zip', import.meta.url)));
  sheet = PNG.sync.read(readFileSync(new URL('../public/assets/spritesheet.png', import.meta.url)));
});

describe('native spell-card pixels', () => {
  // One real action per gun_enums.lua type; use the game's PNGs as the
  // reference, composited independently by libvips rather than the builder.
  it.each([
    ['projectile', 'bomb'],
    ['static_projectile', 'black_hole_big'],
    ['modifier', 'spread_reduce'],
    ['draw_many', 'burst_2'],
    ['material', 'soil'],
    ['other', 'duplicate'],
    ['utility', 'temporary_wall'],
    ['passive', 'torch'],
  ])('preserves the %s border around %s', async (type, sprite) => {
    const bg = await zip.file(`data/ui_gfx/inventory/item_bg_${type}.png`)!.async('nodebuffer');
    const icon = await zip.file(`data/ui_gfx/gun_actions/${sprite}.png`)!.async('nodebuffer');
    const expected = await sharp(bg).composite([{ input: icon, left: 2, top: 2 }])
      .ensureAlpha().raw().toBuffer();
    const entry = entries[`spell:card/${sprite}`];
    expect(entry).toMatchObject({ w: 20, h: 20 });
    const actual = Buffer.alloc(20 * 20 * 4);
    for (let y = 0; y < 20; y++) {
      const start = ((entry.y + y) * sheet.width + entry.x) * 4;
      sheet.data.copy(actual, y * 20 * 4, start, start + 20 * 4);
    }
    // PNGs may retain white RGB under zero alpha; libvips discards that
    // invisible colour. Compare their rendered pixels, including all alpha.
    for (let i = 0; i < actual.length; i += 4) {
      if (actual[i + 3] === 0) actual.fill(0, i, i + 3);
      if (expected[i + 3] === 0) expected.fill(0, i, i + 3);
    }
    // libvips truncates fractional source-over colours; the builder rounds.
    let maxColourError = 0;
    for (let i = 0; i < actual.length; i++) {
      if (i % 4 === 3) expect(actual[i]).toBe(expected[i]);
      else maxColourError = Math.max(maxColourError, Math.abs(actual[i] - expected[i]));
    }
    expect(maxColourError).toBeLessThanOrEqual(1);
  });

  it('keeps the raw action glyph available for non-card markers', async () => {
    const glyph = PNG.sync.read(await zip.file('data/ui_gfx/gun_actions/bomb.png')!.async('nodebuffer'));
    const entry = entries['spell:bomb'];
    expect(entry).toMatchObject({ w: 16, h: 16 });
    for (let y = 0; y < 16; y++) {
      const start = ((entry.y + y) * sheet.width + entry.x) * 4;
      expect(sheet.data.subarray(start, start + 16 * 4)).toEqual(glyph.data.subarray(y * 16 * 4, (y + 1) * 16 * 4));
    }
  });

  it('uses the game entity hotspot without changing GUI card dimensions or glyph alignment', async () => {
    for (const file of ['data/entities/base_custom_card.xml', 'data/entities/misc/custom_cards/action.xml']) {
      const xml = (await zip.file(file)!.async('string')).replace(/<!--[\s\S]*?-->/g, '');
      const sprites = [...xml.matchAll(/<SpriteComponent\b([^>]+)>/g)].map(match => match[1]);
      const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w_]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      const background = attributes(sprites.find(tag => /\bitem_bg\b/.test(tag))!);
      const glyph = attributes(sprites.find(tag => /\bitem_identified\b/.test(tag))!);
      const bgPixels = PNG.sync.read(await zip.file(background.image_file)!.async('nodebuffer'));
      const glyphPixels = PNG.sync.read(await zip.file(glyph.image_file)!.async('nodebuffer'));
      expect(bgPixels).toMatchObject({ width: 20, height: 20 });
      expect(glyphPixels).toMatchObject({ width: 16, height: 16 });
      expect(Number(background.offset_x) - Number(glyph.offset_x)).toBe(2);
      expect(Number(background.offset_y) - Number(glyph.offset_y)).toBe(2);
      for (const [key, entry] of Object.entries(entries)) if (key.startsWith('spell:card/')) {
        expect(entry, key).toMatchObject({ w: bgPixels.width, h: bgPixels.height,
          ox: Number(background.offset_x), oy: Number(background.offset_y) });
      }
    }
  });
});
