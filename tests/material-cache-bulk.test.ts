import { expect, it } from "vitest";
import { cacheMaterialAt } from "../src/telescope/material-cache";

it("copies negative, partial block rows into caller-owned strided storage", () => {
  const queries: [number, number][] = [];
  const sample = (x: number, y: number) => (x < 0 ? -1 : y < 0 ? 0 : 17);
  const cache = cacheMaterialAt((x, y) => {
    queries.push([x, y]);
    return sample(x, y);
  });
  const width = 260,
    height = 3,
    stride = width + 7,
    offset = stride + 3;
  const out = new Int16Array(stride * (height + 2)).fill(99);
  cache.readRect(-129, -1, width, height, { data: out, stride, offset });
  for (let row = 0; row < height + 2; row++)
    for (let col = 0; col < stride; col++)
      expect(out[row * stride + col]).toBe(
        row >= 1 && row <= height && col >= 3 && col < 3 + width
          ? sample(col - 3 - 129, row - 2)
          : 99,
      );
  expect(queries).toHaveLength(width * height);
  expect(queries[0]).toEqual([-129, -1]);
  expect(queries.at(-1)).toEqual([130, 1]);
  // Decal painters mutate their copy; cached material identities survive.
  out.fill(42);
  cache.readRect(-129, -1, width, height, { data: out, stride, offset });
  expect(queries).toHaveLength(width * height);
  expect(out[offset]).toBe(-1);
  expect(cache.stats.reused).toBe(width * height);
});

it("resolves only requested native fallback pixels and retains true JS -1", () => {
  const queries: [number, number][] = [];
  const cache = cacheMaterialAt((x, y) => {
    queries.push([x, y]);
    return -1;
  });
  cache.prefill(-2, -1, 5, 1, new Int32Array([-1, 0, -1, 17, -1]));
  const out = new Int16Array(3);
  cache.readRect(-1, -1, 3, 1, { data: out, stride: 3 });
  expect([...out]).toEqual([0, -1, 17]);
  expect(queries).toEqual([[0, -1]]);
  cache.readRect(-1, -1, 3, 1, { data: out, stride: 3 });
  expect(queries).toEqual([[0, -1]]);
  expect(cache.stats).toEqual({ resolved: 1, reused: 5, prefilled: 2 });
});

it("bounds bulk cache storage without retaining evicted or borrowed blocks", () => {
  const cache = cacheMaterialAt((x) => (x < 0 ? 7 : 9), 1);
  const out = new Int16Array(1);
  cache.prefill(-128, 0, 1, 1, new Int32Array([31]));
  cache.readRect(-128, 0, 1, 1, { data: out, stride: 1 });
  expect(out[0]).toBe(31);
  cache.readRect(128, 0, 1, 1, { data: out, stride: 1 });
  expect(out[0]).toBe(9);
  cache.readRect(-128, 0, 1, 1, { data: out, stride: 1 });
  expect(out[0]).toBe(7);
  expect(cache.stats.resolved).toBe(2);
});

it("matches scalar reads across repeated eviction and partially prefetched rectangles", () => {
  const sample = (x: number, y: number) =>
    (((Math.imul(x, 31) ^ Math.imul(y, 17)) >>> 0) % 193) - 1;
  for (const limit of [1, 3, 64]) {
    const scalar = cacheMaterialAt(sample, limit),
      bulk = cacheMaterialAt(sample, limit);
    for (const [x, y, width, height] of [
      [-133, -131, 270, 5],
      [126, 126, 7, 6],
      [-2, -1, 6, 3],
    ]) {
      const source = Int32Array.from({ length: width * height }, (_, i) =>
        i % 7 ? sample(x + (i % width), y + Math.floor(i / width)) : -1,
      );
      for (const cache of [scalar, bulk])
        cache.prefill(x, y, width, height, source);
      const expected = Int16Array.from({ length: width * height }, (_, i) =>
        scalar.materialAt(x + (i % width), y + Math.floor(i / width)),
      );
      const result = new Int16Array(expected.length);
      bulk.readRect(x, y, width, height, { data: result, stride: width });
      expect(result).toEqual(expected);
      expect(bulk.stats).toEqual(scalar.stats);
    }
  }
});

it("checks output bounds before resolving and permits an empty rectangle", () => {
  let reads = 0;
  const cache = cacheMaterialAt(() => ++reads),
    data = new Int16Array(4);
  for (const target of [
    { data, stride: 1 },
    { data, stride: 2, offset: -1 },
    { data, stride: 2, offset: 1 },
    { data, stride: 2.5 },
  ])
    expect(() => cache.readRect(0, 0, 2, 2, target)).toThrow(RangeError);
  cache.readRect(0, 0, 0, 0, { data, stride: 0 });
  expect(reads).toBe(0);
});
