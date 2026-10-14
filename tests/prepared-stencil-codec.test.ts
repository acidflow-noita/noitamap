import { expect, it } from 'vitest';
import { encodeStencilField, openStencilField } from '../src/native-map/prepared-materials/stencil-codec';

it.each([1, 2, 3, 16, 17, 256, 257, 65536])('round-trips %i symbols without expanding the pixel array', count => {
  const values = Uint16Array.from({ length: Math.max(1093, count) }, (_, i) => ((i * 65537) % count));
  const encoded = encodeStencilField(values);
  // Misaligned network/asset views must remain readable too.
  const container = new Uint8Array(encoded.length + 1); container.set(encoded, 1);
  const field = openStencilField(container.subarray(1), values.length);
  expect(field.paletteSize).toBe(count);
  expect(Array.from({ length: values.length }, (_, i) => field.at(i))).toEqual([...values]);
  expect(() => field.at(-1)).toThrow(); expect(() => field.at(values.length)).toThrow();
});

it('rejects truncated, mismatched and corrupt field records', () => {
  const encoded = encodeStencilField(Uint16Array.from([1, 2, 3, 1, 2, 3, 1]));
  expect(() => openStencilField(encoded, 8)).toThrow();
  expect(() => openStencilField(encoded.subarray(0, encoded.length - 1))).toThrow();
  const corrupt = encoded.slice(); new DataView(corrupt.buffer).setUint32(12, 31, true);
  expect(() => openStencilField(corrupt)).toThrow();
  const badIndex = encoded.slice(); badIndex[22] |= 3;
  expect(() => openStencilField(badIndex).at(0)).toThrow();
});
