import { describe, expect, it } from "vitest";
import {
  createStaticTerrainMask,
  staticSceneBits,
} from "../src/telescope/static-terrain-mask";
describe("authored static scene mask", () => {
  it("preserves material and force-air but not untouched pixels or the entire bbox", () => {
    const data = new Uint8Array([
      0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 66, 255, 0, 0, 0, 255,
    ]);
    const mask = createStaticTerrainMask([
      {
        x: -1536,
        y: 984,
        width: 4,
        height: 1,
        bits: staticSceneBits(data),
        airBits: staticSceneBits(data, true),
      },
    ]);
    expect([-1536, -1535, -1534, -1533].map((x) => mask.at(x, 984))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(mask.at(-1534, 983)).toBe(false);
    const pixels = new Uint8ClampedArray(16).fill(127);
    mask.clear(pixels, -1536, 984, 4, 1);
    expect(Array.from(pixels)).toEqual([
      127, 127, 127, 127, 0, 0, 0, 0, 127, 127, 127, 127, 127, 127, 127, 127,
    ]);
  });
  it("protects an altar above y=1024 with identical results across a tile seam", () => {
    const data = new Uint8Array(4 * 80).fill(255);
    const mask = createStaticTerrainMask([
      {
        x: 0,
        y: 984,
        width: 1,
        height: 80,
        bits: staticSceneBits(data),
        airBits: staticSceneBits(data, true),
      },
    ]);
    const full = new Uint8ClampedArray(4 * 1024).fill(255),
      split = full.slice();
    mask.clear(full, 0, 512, 1, 1024);
    mask.clear(split.subarray(0, 512 * 4), 0, 512, 1, 512);
    mask.clear(split.subarray(512 * 4), 0, 1024, 1, 512);
    expect(split).toEqual(full);
    expect(full[(983 - 512) * 4 + 3]).toBe(255);
    expect(full[(984 - 512) * 4 + 3]).toBe(0);
    expect(full[(1064 - 512) * 4 + 3]).toBe(255);
  });
});
it("does not turn static-scene force-air into a black hole over a dynamic backdrop", () => {
  const raw = new Uint8Array([0, 0, 66, 255]);
  const mask = createStaticTerrainMask([
    {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      bits: staticSceneBits(raw),
      airBits: staticSceneBits(raw, true),
    },
  ]);
  const terrain = new Uint8ClampedArray([80, 70, 40, 255]);
  mask.clear(terrain, 0, 0, 1, 1, true);
  expect(Array.from(terrain)).toEqual([0, 0, 0, 0]);
  // The normal backdrop composite runs between erasing cells and preserving
  // static material art. FORCE AIR must not erase that replacement backdrop.
  terrain.set([12, 13, 14, 255]);
  mask.clear(terrain, 0, 0, 1, 1);
  expect(Array.from(terrain)).toEqual([12, 13, 14, 255]);
});
