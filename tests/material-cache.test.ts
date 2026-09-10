import { it, expect } from "vitest";
import { cacheMaterialAt } from "../src/telescope/material-cache";
it("shares final material IDs with edge work without recomputing pixels", () => {
  let reads = 0;
  const cache = cacheMaterialAt((x, y) => {
    reads++;
    return ((x + y) % 3 + 3) % 3;
  });
  for (let pass = 0; pass < 2; pass++)
    for (let y = -12; y < 160; y++)
      for (let x = -14; x < 175; x++)
        expect(cache.materialAt(x, y)).toBe(((x + y) % 3 + 3) % 3);
  expect(reads).toBe(172 * 189);
  expect(cache.stats.reused).toBe(reads);
});
it("bounds storage without conflating negative, far-away, or air/unresolved values", () => {
  const cache = cacheMaterialAt((x, y) => (x < 0 ? -1 : y < 0 ? 0 : 5), 1);
  expect(cache.materialAt(-1, 0)).toBe(-1);
  expect(cache.materialAt(0, -1)).toBe(0);
  expect(cache.materialAt(0, 0)).toBe(5);
  expect(cache.materialAt(-1, 0)).toBe(-1);
  expect(cache.stats.resolved).toBe(4);
});
