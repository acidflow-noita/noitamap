import { describe, expect, it } from 'vitest';
import { decodeLiquidMask, encodeLiquidMask, maskBlock, paintMaskBlock } from '../src/liquids/mask-codec';
import { cropLiquidMask, LiquidMaskIndex } from '../src/liquids/mask-index';

describe('bounded material-mask storage', () => {
  it('roundtrips disjoint liquid runs across negative coordinates and crops without scaling', () => {
    const input = new Uint8Array([0, 255, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0]);
    const block = maskBlock(-3, -7, 6, 2, input)!;
    expect([...block.runs]).toEqual([0, 1, 2, 0, 4, 1, 1, 1, 4]);
    const encoded = encodeLiquidMask([block]);
    const unaligned = new Uint8Array(encoded.length + 1); unaligned.set(encoded, 1);
    const [decoded] = decodeLiquidMask(unaligned.subarray(1));
    const output = new Uint8Array(12); paintMaskBlock(decoded, output, -3, -7, 6, 2);
    expect(output).toEqual(input);
    const crop = new Uint8Array(6); new LiquidMaskIndex([decoded]).paint(crop, { x: -2, y: -7, width: 3, height: 2 });
    expect([...crop]).toEqual([255, 255, 0, 255, 255, 255]);
  });
  it('distinguishes an empty complete mask from missing/truncated input', () => {
    expect(maskBlock(0, 0, 2, 2, new Uint8Array(4))).toBeNull();
    expect(decodeLiquidMask(encodeLiquidMask([]))).toEqual([]);
    expect(() => decodeLiquidMask(new Uint8Array())).toThrow();
    const valid = encodeLiquidMask([maskBlock(0, 0, 2, 2, new Uint8Array([255, 0, 0, 0]))!]);
    for (let end = 0; end < valid.length; end++) expect(() => decodeLiquidMask(valid.subarray(0, end))).toThrow();
  });
  it('rejects invalid allocation sizes, out-of-bounds runs and incompatible formats', () => {
    const sample = maskBlock(0, 0, 2, 2, new Uint8Array([255, 0, 0, 0]))!;
    for (const runs of [new Uint16Array([0, 1, 2]), new Uint16Array([3, 0, 1]),
      new Uint16Array([0, 0, 2, 0, 1, 1]), new Uint16Array([0, 0, 0])])
      expect(() => encodeLiquidMask([{ ...sample, runs }])).toThrow();
    expect(() => encodeLiquidMask([{ ...sample, width: 513 }])).toThrow();
    const bytes = encodeLiquidMask([sample]);
    for (const [at, value] of [[0, 0], [4, 2], [8, 0xffffffff], [24, 0xffffffff]]) {
      const corrupt = bytes.slice(); new DataView(corrupt.buffer).setUint32(at, value, true);
      expect(() => decodeLiquidMask(corrupt)).toThrow();
    }
  });
  it('excludes POI footprints, preserves every remaining liquid pixel, and skips empty views', () => {
    const bounds = { x: 100, y: -200, width: 8, height: 4 };
    const pixels = new Uint8Array(32); pixels.fill(255, 9, 15); pixels.fill(255, 17, 23);
    const result = cropLiquidMask(pixels, bounds, [{ x: 103, y: -199, width: 2, height: 2 }])!;
    expect(result).toMatchObject({ x: 101, y: -199, width: 6, height: 2 });
    expect([...result.pixels]).toEqual([255, 255, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255]);
    expect(cropLiquidMask(new Uint8Array(32), bounds)).toBeNull();
    expect(() => cropLiquidMask(new Uint8Array(1), { ...bounds, width: 100000, height: 100000 })).toThrow();
  });
});
