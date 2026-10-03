import { it, expect } from "vitest";
import { createTerrainFootprint } from "../src/telescope/terrain-footprint";
const make = () => {
  const pixels = new Uint32Array(70 * 48);
  pixels[14 * 70 + 35] = 1;
  return {
    seed: 42,
    isNGP: false,
    tileLayers: [
      {
        biomeName: "coalmine",
        buffer: new Uint8Array(3),
        validChunks: new Set(["35,14"]),
      },
    ],
    biomeData: { pixels },
  };
};
it("skips whole empty subtrees without dropping a dynamic biome or its boundary halo", () => {
  const has = createTerrainFootprint(
    make(),
    { coalmine: { color: 1, wangFile: "mine" } },
    70,
  );
  expect(has(0, 0, 512, 512)).toBe(true);
  expect(has(-30, 0, 10, 512)).toBe(true);
  expect(has(-16000, -7000, 8192, 8192)).toBe(false);
});
it("keeps scene backgrounds that extend beyond scene material dimensions", () => {
  const has = createTerrainFootprint(
    {
      ...make(),
      sceneData: {
        scenes: [
          { key: "test", name: "test", x: -15000, y: 0, width: 20, height: 20 },
        ],
        sources: {
          test: {
            width: 20,
            height: 20,
            data: new Uint8Array(1600),
            backgroundArt: { width: 600, height: 600, data: new Uint8Array(1) },
          },
        },
      },
    },
    { coalmine: { color: 1, wangFile: "mine" } },
    70,
  );
  expect(has(-14500, 500, 10, 10)).toBe(true);
  expect(has(-14000, 500, 10, 10)).toBe(false);
});
