import { describe, expect, it } from "vitest";
import {
  createStaticTerrainMask,
  staticSceneBits,
  staticSceneMaskBits,
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

describe('combined material/air mask construction', () => {
  it('keeps transparent, black, material and force-air classifications distinct', () => {
    const data = new Uint8Array([
      0, 0, 66, 0,  // transparent air colour owns nothing
      0, 0, 66, 1,  // partial alpha still owns force air
      0, 0, 0, 255, // opaque black owns nothing
      1, 0, 0, 255, // any nonblack opaque colour owns material
      0, 1, 66, 255,
      0, 0, 65, 255,
      0, 0, 67, 255,
      255, 255, 255, 0,
      0, 0, 66, 255, // cross the packed-byte boundary
      255, 255, 255, 128,
    ]);
    expect(staticSceneMaskBits(data)).toEqual({
      bits: new Uint8Array([0b01111000, 0b00000010]),
      airBits: new Uint8Array([0b00000010, 0b00000001]),
    });
  });

  it('matches both original passes for byte offsets, tails and mixed alpha/RGB', () => {
    let state = 0x12345678;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    for (const Ctor of [Uint8Array, Uint8ClampedArray]) {
      for (const offset of [0, 1, 2, 3, 7]) {
        for (const length of [0, 1, 3, 4, 7, 28, 31, 32, 33, 36, 65, 4096]) {
          const storage = new Ctor(length + offset + 8).fill(117);
          const data = storage.subarray(offset, offset + length);
          for (let i = 0; i < length; i++) data[i] = random() >>> 24;
          for (let i = 0; i + 3 < length; i += 4) {
            if (i % 28 === 0) data.set([0, 0, 66, random() >>> 24], i);
            else if (i % 20 === 0) data.set([0, 0, 0, 255], i);
            else if (i % 12 === 0) data[i + 3] = 0;
          }
          const before = storage.slice();
          expect(staticSceneMaskBits(data)).toEqual({ bits: staticSceneBits(data), airBits: staticSceneBits(data, true) });
          expect(storage).toEqual(before);
        }
      }
    }
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
