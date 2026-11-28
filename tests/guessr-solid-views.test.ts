import sharp from 'sharp';
import { expect, it } from 'vitest';
import { classifySolidViews } from '../build_scripts/guessr/solid-views.mts';
import { cameraRect } from '../src/guessr/clue-camera';
import { prepareAreaStarts, SOLID_START_LEVEL } from '../src/guessr/starting-view';
import type { PrivateImageSet } from '../src/guessr/image-game-server';

it('excludes exactly the solid four-zoom windows across native seams and partial edge tiles', async () => {
  const width = 2101,
    height = 997,
    tileSize = 256,
    overlap = 2,
    originX = -17920,
    originY = -512;
  const pixels = Buffer.alloc(width * height * 4);
  const hDiff = new Uint32Array((width + 1) * (height + 1)),
    vDiff = new Uint32Array(hDiff.length);
  const stride = width + 1;
  for (let y = 0; y < height; y++) {
    let rowH = 0,
      rowV = 0;
    for (let x = 0; x < width; x++) {
      // Two flat colors only one intensity unit apart, a transparent band, black rock and a single shoreline pixel.
      const color =
        y > 780 ? 0 : x > 1520 ? 0xff : (x === 510 && y === 255) || x >= 1120 ? 0xff6100ff : 0xff6000ff;
      const p = (y * width + x) * 4;
      pixels.writeUInt32BE(color, p);
      rowH += Number(x > 0 && color !== pixels.readUInt32BE(p - 4));
      rowV += Number(y > 0 && color !== pixels.readUInt32BE(p - 4 * width));
      hDiff[(y + 1) * stride + x + 1] = hDiff[y * stride + x + 1] + rowH;
      vDiff[(y + 1) * stride + x + 1] = vDiff[y * stride + x + 1] + rowV;
    }
  }
  const grid: Record<string, string> = {},
    files = new Map<string, Buffer>();
  const index: PrivateImageSet = {
    schemaVersion: 1,
    version: 'test',
    capture: { originX, originY, width, height, tileSize, overlap, maxLevel: 12, sha256: 'test' },
    images: {},
    levels: { 12: { images: grid } },
  };
  for (let y = 0; y < height; y += tileSize)
    for (let x = 0; x < width; x += tileSize) {
      const w = Math.min(tileSize, width - x),
        h = Math.min(tileSize, height - y);
      const left = x ? overlap : 0,
        top = y ? overlap : 0;
      const iw = left + w + Math.min(overlap, width - x - w),
        ih = top + h + Math.min(overlap, height - y - h);
      const raw = Buffer.alloc(iw * ih * 4, 197); // Mismatched duplicate halos must never affect clue classification.
      for (let row = 0; row < h; row++)
        pixels.copy(
          raw,
          ((top + row) * iw + left) * 4,
          ((y + row) * width + x) * 4,
          ((y + row) * width + x + w) * 4,
        );
      const id = (files.size + 1).toString(16).padStart(32, '0');
      files.set(
        id,
        await sharp(raw, { raw: { width: iw, height: ih, channels: 4 } })
          .png()
          .toBuffer(),
      );
      grid[`${x / tileSize},${y / tileSize}`] = id;
      index.images[id] = { width: iw, height: ih, content: 'full' };
    }
  index.solidViews = await classifySolidViews(index, async (id) => files.get(id)!);
  const seen = new Uint8Array(width * height);
  for (const rect of index.solidViews.rectangles)
    for (let y = rect.y - originY; y < rect.y - originY + rect.height; y++) {
      const at = y * width + rect.x - originX;
      seen.fill(1, at, at + rect.width);
    }
  const sum = (table: Uint32Array, l: number, t: number, r: number, b: number) =>
    table[b * stride + r] - table[t * stride + r] - table[b * stride + l] + table[t * stride + l];
  const view = cameraRect({ dx: 0, dy: 0, level: SOLID_START_LEVEL });
  let excluded = 0,
    mismatches = 0;
  // Independent oracle: a window is constant iff no adjacent pair of its pixels differs in either axis.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const l = x + view.x,
        t = y + view.y,
        r = l + view.width,
        b = t + view.height;
      const sample = pixels.readUInt32BE((y * width + x) * 4);
      const solid =
        l >= 0 &&
        r <= width &&
        t >= 0 &&
        b <= height &&
        (sample & 255) !== 0 &&
        sample >>> 8 !== 0 &&
        !sum(hDiff, l + 1, t, r, b) &&
        !sum(vDiff, l, t + 1, r, b);
      if (solid) excluded++;
      if (Number(solid) !== seen[y * width + x]) mismatches++;
    }
  expect(excluded).toBeGreaterThan(0);
  expect(mismatches).toBe(0);
  const area = {
    id: 'lake',
    label: 'Lake',
    originY,
    runs: [
      [0, 0, 4],
      [1, 0, 4],
    ] as [number, number, number][],
  };
  const starts = prepareAreaStarts(index, area);
  expect(starts.contains({ x: originX + 885, y: originY + 450 })).toBe(false);
  expect(starts.contains({ x: originX + 1100, y: originY + 450 })).toBe(true);
  index.solidViews.imageVersion = 'other';
  expect(() => prepareAreaStarts(index, area)).toThrow('does not match');
});
