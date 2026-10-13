import { expect, it } from "vitest";
import { cacheMaterialAt } from "../src/telescope/material-cache";

it("uses native IDs including air while preserving lazy JS fallback for negative IDs", () => {
  const queries: [number, number][] = [];
  const cache = cacheMaterialAt((x, y) => {
    queries.push([x, y]);
    return x < 0 ? 17 : -1;
  });
  cache.prefill(-1, -1, 3, 2, new Int32Array([3, 0, -1, -1, 9, 2]));
  expect(queries).toEqual([]);
  expect(cache.hasMissing(-1, -1, 3, 2)).toBe(false);
  expect(cache.hasMissing(-1, -1, 4, 2)).toBe(true);
  expect(cache.materialAt(-1, -1)).toBe(3);
  expect(cache.materialAt(0, -1)).toBe(0);
  expect(cache.materialAt(1, -1)).toBe(-1);
  expect(cache.materialAt(-1, 0)).toBe(17);
  expect(cache.materialAt(0, 0)).toBe(9);
  expect(cache.materialAt(1, 0)).toBe(2);
  expect(cache.materialAt(-1, 0)).toBe(17);
  expect(queries).toEqual([
    [1, -1],
    [-1, 0],
  ]);
  expect(cache.materialAt(2, 0)).toBe(-1);
  expect(queries.at(-1)).toEqual([2, 0]);
});

it("does not retain a borrowed WASM view and keeps prefilled storage bounded", () => {
  let reads = 0;
  const cache = cacheMaterialAt(() => {
    reads++;
    return 23;
  }, 1);
  const native = new Int32Array([7]);
  cache.prefill(0, 0, 1, 1, native);
  native[0] = 12;
  expect(cache.materialAt(0, 0)).toBe(7);
  cache.prefill(128, 0, 1, 1, native);
  expect(cache.materialAt(128, 0)).toBe(12);
  expect(cache.materialAt(0, 0)).toBe(23);
  expect(reads).toBe(1);
});
