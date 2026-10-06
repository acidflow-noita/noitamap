import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { encode } from 'fast-png';
import sharp from 'sharp';
import { telescopePngRgba } from '../src/telescope/png-rgba';

const UPNG = createRequire(import.meta.url)('upng-js');
const reference = (image: any) => new Uint8Array(UPNG.toRGBA8(image)[0]);

it('copies RGBA8 exactly, including invisible RGB, without sharing input or trailing scanline bytes', () => {
  const raw = Uint8Array.from([7, 8, 9, 0, 40, 80, 120, 128, 201, 202, 203, 255]);
  const image = UPNG.decode(encode({ width: 3, height: 1, channels: 4, data: raw }));
  const before = image.data.slice(), expected = reference(image);
  const fallback = { toRGBA8: vi.fn(() => { throw new Error('Unexpected fallback'); }) };
  const actual = telescopePngRgba(image, fallback);
  expect(actual).toEqual(expected); expect(actual).toEqual(raw);
  expect(actual.buffer).not.toBe(image.data.buffer);
  expect(actual.length).toBe(12);
  actual.fill(0);
  expect(image.data).toEqual(before);
  expect(telescopePngRgba(image, fallback)).toEqual(expected);
  expect(fallback.toRGBA8).not.toHaveBeenCalled();
});

it('handles offset/truncated views and detached empty storage like the original byte loop', () => {
  for (const length of [0, 1, 7, 8, 9, 19]) {
    const storage = Uint8Array.from({ length: length + 9 }, (_, i) => (i * 37) & 255);
    const image = { width: 2, height: 1, depth: 8, ctype: 6, tabs: {}, data: storage.subarray(5, 5 + length) };
    expect(telescopePngRgba(image, UPNG)).toEqual(reference(image));
  }
  const data = new Uint8Array(16);
  structuredClone(data.buffer, { transfer: [data.buffer] });
  const image = { width: 2, height: 1, depth: 8, ctype: 6, tabs: {}, data };
  expect(telescopePngRgba(image, UPNG)).toEqual(reference(image));
});

it.each([1, 2, 3, 4] as const)('preserves 8/16-bit %i-channel decoding and fallback conversion', channels => {
  for (const depth of [8, 16] as const) {
    const data = depth === 8
      ? Uint8Array.from({ length: 11 * 7 * channels }, (_, i) => (i * 57 + 11) & 255)
      : Uint16Array.from({ length: 11 * 7 * channels }, (_, i) => (i * 409 + 255) & 65535);
    const image = UPNG.decode(encode({ width: 11, height: 7, channels, depth, data }));
    const fallback = { toRGBA8: vi.fn((value: any) => UPNG.toRGBA8(value)) };
    expect(telescopePngRgba(image, fallback)).toEqual(reference(image));
    const packedRGB = channels === 3 && new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    expect(fallback.toRGBA8).toHaveBeenCalledTimes(depth === 8 && (channels === 4 || packedRGB) ? 0 : 1);
  }
});

it('preserves RGB color keys, hidden color bytes and high source-depth keys', () => {
  const image = UPNG.decode(encode({ width: 3, height: 1, channels: 3,
    data: new Uint8Array([107, 0, 128, 28, 36, 18, 107, 0, 129]) }));
  for (const key of [[107, 0, 128], [0x806b, 0, 128], [0, 0, 0]]) {
    image.tabs.tRNS = key;
    expect(telescopePngRgba(image, UPNG)).toEqual(reference(image));
  }
  image.tabs.tRNS = [107, 0, 128];
  expect(Array.from(telescopePngRgba(image, UPNG).subarray(0, 4))).toEqual([107, 0, 128, 0]);
  image.data = image.data.subarray(0, 4);
  expect(telescopePngRgba(image, UPNG)).toEqual(reference(image));
});

it('keeps palette transparency on the original conversion path', () => {
  const png = encode({ width: 3, height: 1, channels: 1, depth: 8,
    palette: [[2, 3, 4, 0], [5, 6, 7, 128], [8, 9, 10, 255]], data: new Uint8Array([0, 1, 2]) });
  const image = UPNG.decode(png), fallback = { toRGBA8: vi.fn((value: any) => UPNG.toRGBA8(value)) };
  expect(telescopePngRgba(image, fallback)).toEqual(reference(image));
  expect(fallback.toRGBA8).toHaveBeenCalledOnce();
});

it('preserves interlaced RGBA8 after UPNG has reconstructed its rows', async () => {
  const input = Uint8Array.from({ length: 17 * 13 * 4 }, (_, i) => (i * 113 + 41) & 255);
  const png = await sharp(input, { raw: { width: 17, height: 13, channels: 4 } }).png({ progressive: true }).toBuffer();
  expect(png[28]).toBe(1);
  const image = UPNG.decode(png);
  expect(image.ctype).toBe(6); expect(image.depth).toBe(8);
  expect(telescopePngRgba(image, UPNG)).toEqual(reference(image));
});

it('retains APNG frame composition rather than copying the default image data', () => {
  const width = 32, height = 24;
  const pixels = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const p = i >>> 2;
    return i % 4 === 0 ? p & 255 : i % 4 === 1 ? p >>> 8 : i % 4 === 2 ? (p * 73) & 255 : 128 + (p % 127);
  });
  const other = pixels.slice(); other[0] ^= 255;
  const image = UPNG.decode(UPNG.encode([pixels.buffer, other.buffer], width, height, 0, [100, 100]));
  expect(image.tabs.acTL).toBeDefined(); expect(image.ctype).toBe(6);
  const fallback = { toRGBA8: vi.fn((value: any) => UPNG.toRGBA8(value)) };
  expect(telescopePngRgba(image, fallback)).toEqual(reference(image));
  expect(fallback.toRGBA8).toHaveBeenCalledOnce();
});
