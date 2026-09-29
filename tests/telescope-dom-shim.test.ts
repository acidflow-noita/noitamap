// @vitest-environment jsdom
import { Blob } from 'node:buffer';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const prototype = createCanvas(1, 1).getContext('2d').constructor.prototype;
const original = {
  putImageData: prototype.putImageData,
  drawImage: prototype.drawImage,
  getImageData: prototype.getImageData,
};

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '';
  vi.stubGlobal('Blob', Blob);
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('CanvasRenderingContext2D', prototype.constructor);
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) =>
    loadImage(Buffer.from(await blob.arrayBuffer()))));
  const { installTelescopeShim } = await import('../src/telescope/telescope-dom-shim');
  installTelescopeShim();
});

afterEach(() => {
  Object.assign(prototype, original);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('does not retain a second full frame after each pixel upload', () => {
  const canvas = createCanvas(512, 512), ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(512, 512);
  ctx.putImageData(pixels, 0, 0);
  expect(canvas).not.toHaveProperty('__noitamap_rawImageData');
  // Resizing is how the map releases a native surface. It must not leave an
  // unrelated RGBA allocation hanging off the now-empty canvas object.
  canvas.width = canvas.height = 1;
  expect(canvas).not.toHaveProperty('__noitamap_rawImageData');
});

it('decodes a scene bitmap once without a hidden full-size PNG decode', async () => {
  const input = createCanvas(8, 8);
  const blob = new Blob([new Uint8Array(input.toBuffer('image/png'))], { type: 'image/png' });
  const read = vi.spyOn(blob, 'arrayBuffer');
  await createImageBitmap(blob as unknown as globalThis.Blob);
  expect(read).toHaveBeenCalledTimes(1);
});

it('reads current composited pixels after drawing, clearing and resizing', async () => {
  const input = createCanvas(8, 8), source = input.getContext('2d');
  source.fillStyle = '#123456';
  source.fillRect(0, 0, 8, 8);
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(input.toBuffer('image/png'))]) as unknown as globalThis.Blob);
  const canvas = createCanvas(8, 8), ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap as any, 0, 0);
  ctx.fillStyle = '#abcdef';
  ctx.fillRect(0, 0, 1, 1);
  ctx.clearRect(1, 0, 1, 1);
  expect([...ctx.getImageData(0, 0, 8, 8).data.slice(0, 12)])
    .toEqual([171, 205, 239, 255, 0, 0, 0, 0, 18, 52, 86, 255]);
  canvas.width = 8;
  expect([...ctx.getImageData(0, 0, 8, 8).data].every(value => value === 0)).toBe(true);
});
