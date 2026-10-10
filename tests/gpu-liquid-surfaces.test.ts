import { describe, expect, it, vi } from 'vitest';
vi.mock('noita-telescope-full-pixels/engine_resolve/engine_data.js', () => ({ MATERIAL_NAMES_BY_ID: [] }));
import { packLiquidSurfaces } from '../src/telescope/gpu-liquid-surfaces';

describe('sparse GPU liquid-surface records', () => {
  const table = () => ({ width: 8, height: 3, data: Float32Array.from({ length: 96 }, (_, i) => i + 0.25) });
  const ownership = () => Array.from({ length: 3 }, () => new Int16Array(2 * 48).fill(-1));
  it('preserves biome parameters and the final Wang row while adding per-plane ownership', () => {
    const input = table(), before = input.data.slice(), owners = ownership();
    owners[0][28] = 0; owners[2][28] = 2;
    const result = packLiquidSurfaces(input, [{ left: -500, right: -400, y: 10, material: 56 }], owners, 2, 256);
    expect(input.data).toEqual(before);
    expect(result.data.subarray(0, 64)).toEqual(before.subarray(0, 64));
    expect(result.data.subarray((result.height - 1) * 32)).toEqual(before.subarray(64));
    const header = result.data.subarray(result.liquidRow * 32 + 28 * 4, result.liquidRow * 32 + 29 * 4);
    expect([...header].slice(1)).toEqual([1, 5 | (6 << 3), 1]);
    const offset = result.liquidRow * 32 + header[0] * 4;
    expect([...result.data.subarray(offset, offset + 4)]).toEqual([-500, -400, 10, 56]);
    expect(result.bytes).toBeLessThan(2048);
  });
  it('indexes both sides of chunk seams and wraps the lattice anchor across parallel worlds', () => {
    const result = packLiquidSurfaces(table(), [{ left: -517, right: -480, y: 0, material: 56 }], ownership(), 2, 256);
    const records = (cell: number) => {
      const start = result.liquidRow * 32, header = start + cell * 4;
      return Array.from({ length: result.data[header + 1] }, (_, n) =>
        [...result.data.subarray(start + (result.data[header] + n * 2) * 4, start + (result.data[header] + n * 2 + 1) * 4)]);
    };
    for (const y of [13, 14]) {
      expect(records(y * 2)).toEqual([[-512, -480, 0, 56]]);
      expect(records(y * 2 + 1)).toEqual([[507, 512, 0, 56]]);
      const mask = result.data[result.liquidRow * 32 + y * 2 * 4 + 3];
      expect(mask).toBe(y === 13 ? 32768 : 1);
    }
    expect(records(25)).toEqual([]);
  });
  it('rejects invalid ownership and oversized uploads', () => {
    expect(() => packLiquidSurfaces(table(), [], [], 2, 256)).toThrow('ownership');
    expect(() => packLiquidSurfaces(table(), [], ownership(), 2, 8)).toThrow('capacity');
  });
  it('indexes the entire interval between old and new levels, including the next chunk', () => {
    const surfaces = [
      { left: -500, right: -450, y: 8, sourceY: -10, material: 56 },
      { left: -450, right: -400, y: 8, sourceY: 16, material: 56 },
    ];
    const result = packLiquidSurfaces(table(), surfaces, ownership(), 2, 256);
    const start = result.liquidRow * 32, header = start + 28 * 4;
    expect(result.data[header + 1]).toBe(2);
    const offset = start + result.data[header] * 4;
    expect([...result.data.subarray(offset, offset + 16)]).toEqual([
      -500, -450, 8, 56, -10, 0, 0, 0,
      -450, -400, 8, 56, 16, 0, 0, 0,
    ]);
    expect(result.data[start + 26 * 4 + 1]).toBe(1); // old surface extends into the preceding chunk
    expect(result.data[start + 26 * 4 + 3]).toBe(32768);
  });
});
