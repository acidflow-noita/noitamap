import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { capturedFluidMasks, clipCapturedFluids, clearCapturedFluids } from '../src/liquids/captured-reservations';
import { createStaticTerrainMask } from '../src/telescope/static-terrain-mask';

describe('captured fluid pixels at procedural biome edges', () => {
  it.each([-35840, 0, 35840])('keeps the exact upper basin surface in world %s, retaining the air around it', offset => {
    // All three capture worlds have a filled basin ending at the 2560 boundary.
    const x = offset === -35840 ? -37888 : offset === 0 ? -1024 : 33792;
    const bounds = { x, y: 2520, width: 512, height: 64 };
    const canvas = createCanvas(512, 64), ctx = canvas.getContext('2d');
    ctx.translate(-x + offset, -bounds.y);
    clipCapturedFluids(ctx as unknown as CanvasRenderingContext2D, { ...bounds, x: x - offset }, offset);
    ctx.fillStyle = '#d04532'; ctx.fillRect(x - offset, bounds.y, 512, 64);
    const pixels = ctx.getImageData(0, 0, 512, 64).data;
    const staticMask = createStaticTerrainMask(capturedFluidMasks());
    let protectedPixels = 0;
    for (let row = 0; row < 64; row++) for (let col = 0; col < 512; col++) {
      const protectedPixel = row === 25 ? col >= 257 && col < 440 : row >= 26 && row < 40 && col >= 73 && col < 440;
      expect(staticMask.at(x + col, bounds.y + row)).toBe(protectedPixel);
      expect(pixels[(row * 512 + col) * 4 + 3]).toBe(protectedPixel ? 0 : 255);
      if (protectedPixel) protectedPixels++;
    }
    expect(protectedPixels).toBe(5321);
  });
  it('uses the same reservation to remove generated bake pixels, and excludes only legacy worlds from wobble', () => {
    const bounds = { x: 585, y: 1009, width: 367, height: 16 };
    const rgba = new Uint8ClampedArray(bounds.width * bounds.height * 4).fill(255);
    createStaticTerrainMask(capturedFluidMasks([0])).clear(rgba, bounds.x, bounds.y, bounds.width, bounds.height);
    const mask = new Uint8Array(bounds.width * bounds.height).fill(255);
    clearCapturedFluids(mask, bounds, [{ x: -53760, width: 35840 }]);
    expect(mask.every(Boolean)).toBe(true);
    clearCapturedFluids(mask, bounds, [{ x: -17920, width: 35840 }]);
    for (let i = 0; i < mask.length; i++) expect(mask[i]).toBe(rgba[i * 4 + 3]);
    expect(mask.slice(15 * 367).every(Boolean)).toBe(true);
    expect(capturedFluidMasks([0]).every(m => m.x > -17920 && m.x < 17920)).toBe(true);
    expect(capturedFluidMasks([2])).toEqual([]);
  });
});
