import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { expect, it, vi } from 'vitest';
import { loadNGPlusSurfaceLandmarkMasks } from '../src/telescope/ng-plus-surface-landmarks';
import { createStaticTerrainMask } from '../src/telescope/static-terrain-mask';

const getArchive = vi.hoisted(() => vi.fn());
vi.mock('../src/data-archive', () => ({ getDataZip: getArchive }));

it('preserves the capture only on actual ground-level NG+ landmark pixels', async () => {
  const archive = await JSZip.loadAsync(readFileSync('public/data.zip'));
  getArchive.mockResolvedValueOnce(null).mockResolvedValue(archive);
  await expect(loadNGPlusSurfaceLandmarkMasks()).rejects.toThrow('archive unavailable');
  const masks = await loadNGPlusSurfaceLandmarkMasks();
  expect(await loadNGPlusSurfaceLandmarkMasks()).toBe(masks);
  expect(getArchive).toHaveBeenCalledTimes(2);

  const reference = [
    { x: -6948, y: -270, width: 128, height: 240, material: 'overworld/essence_altar', visual: 'overworld/essence_altar_visual' },
    { x: 2560, y: 0, width: 512, height: 512, material: 'spliced/mountain_lake' },
  ];
  expect(masks).toHaveLength(reference.length);
  const pixels = async (name: string) => {
    const image = await loadImage(await archive.file('data/biome_impl/' + name + '.png')!.async('nodebuffer'));
    const ctx = createCanvas(image.width, image.height).getContext('2d');
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, image.width, image.height).data;
  };
  for (const [i, { material, visual, ...bounds }] of reference.entries()) {
    expect(masks[i]).toMatchObject(bounds);
    const raw = await pixels(material), art = visual && await pixels(visual);
    let mismatches = 0, reserved = 0, densityCells = 0;
    for (let p = 0; p < bounds.width * bounds.height; p++) {
      const k = p * 4;
      const written = raw[k + 3] > 0 && (raw[k] + raw[k + 1] + raw[k + 2]) > 0;
      const visibleArt = !!art?.[k + 3];
      const density = written && raw[k] === raw[k + 1] && raw[k + 1] === raw[k + 2] && !visibleArt;
      const expected = (written && !density) || visibleArt;
      const protectedPixel = !!(masks[i].bits[p >> 3] & (1 << (p & 7)));
      const densityPixel = !!((masks[i].densityBits?.[p >> 3] ?? 0) & (1 << (p & 7)));
      if (protectedPixel) reserved++;
      if (densityPixel) densityCells++;
      if (protectedPixel !== expected || densityPixel !== density) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(reserved).toBe(i === 0 ? 12735 : 135282);
    expect(densityCells).toBe(i === 0 ? 0 : 104002);
  }
  const fixed = createStaticTerrainMask(masks);
  expect(fixed.at(-6948 + 61, -270 + 77)).toBe(true); // Altar force-air.
  expect(fixed.at(2560 + 109, 0)).toBe(true); // Mountain Lake force-air.
  expect(fixed.at(2560, 0)).toBe(false); // The black material sentinel leaves new ground visible.
  expect(fixed.at(2560 + 109 + 32768, 0)).toBe(false);
  expect(fixed.at(-16541, -6767)).toBe(false); // Gourd Room is above the surface draw.
});
