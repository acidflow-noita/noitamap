// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ImageData as NativeImageData, createCanvas } from '@napi-rs/canvas';
import { putTelescopeImageData } from '../src/telescope/telescope-canvas-pixels';

beforeEach(() => {
  vi.stubGlobal('ImageData', NativeImageData);
  vi.stubGlobal('CanvasRenderingContext2D', createCanvas(1, 1).getContext('2d').constructor);
});
afterEach(() => { vi.unstubAllGlobals(); document.getElementById('telescope-shim')?.remove(); });

it('leaves browser canvas methods and bitmap decoding untouched when installing Telescope', async () => {
  vi.resetModules();
  const prototype = CanvasRenderingContext2D.prototype;
  const before = [prototype.putImageData, prototype.drawImage, prototype.getImageData, window.createImageBitmap];
  const { installTelescopeShim } = await import('../src/telescope/telescope-dom-shim');
  installTelescopeShim();
  expect([prototype.putImageData, prototype.drawImage, prototype.getImageData, window.createImageBitmap]).toEqual(before);
});

it('retains exact legacy encoder pixels only for an explicit Telescope output', () => {
  const pixels = new NativeImageData(new Uint8ClampedArray([11, 22, 33, 255]), 1, 1);
  const canvas = { width: 1, height: 1 } as any, putImageData = vi.fn();
  putTelescopeImageData({ canvas, putImageData } as any, pixels as unknown as ImageData);
  expect(putImageData).toHaveBeenCalledWith(pixels, 0, 0);
  pixels.data.fill(0);
  expect([...canvas.__noitamap_rawImageData.data]).toEqual([11, 22, 33, 255]);
  expect(canvas.__noitamap_rawImageData).not.toBe(pixels);
});
