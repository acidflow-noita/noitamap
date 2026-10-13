import { expect, it, vi } from "vitest";
const { textures } = vi.hoisted(() => ({ textures: new Map<string, any>() }));
vi.mock("../src/telescope/liquid-surfaces", () => ({
  createLiquidSurfacePainter: () => () => {},
  findLiquidSurfaces: () => [],
  loadLiquidMaterialIds: async () => new Set(),
}));
vi.mock("../src/telescope/terrain-edges", () => ({
  createTerrainEdges: async () => ({ sample: () => 0, paint() {}, stats: {} }),
}));
vi.mock("noita-telescope-full-pixels/gl/material_atlas.js", () => ({
  getMaterialAtlas: () => ({}),
  materialTexelRGBA: () => 0,
}));
vi.mock("noita-telescope-full-pixels/gl/engine_resources.js", () => ({
  buildMatColorTable: () => ({ data: new Uint16Array(8) }),
}));
vi.mock("../src/telescope/terrain-backgrounds", async (original) => ({
  ...(await original<object>()),
  loadTerrainBackgrounds: async () => textures,
}));
import { createTerrainComposition } from "../src/telescope/terrain-composition";
import { compositeTerrain } from "../src/telescope/terrain-backgrounds";
import { readRGBA, writeRGBA } from "../src/telescope/terrain-scenes";

it("matches scalar background/ownership sampling for partial chunks, planes and arbitrary RGBA", async () => {
  let state = 0x534d414c;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const names = ["coalmine", "snowcave", "vault"];
  const config = Object.fromEntries(
    names.map((name, i) => [name, { color: i + 1, wangFile: "test.png" }]),
  );
  let compared = 0;
  for (const width of [64, 70, 71]) {
    const map = Uint32Array.from({ length: width * 48 }, () => rand() % 4);
    const tileLayers = names.map((name) => ({
      biomeName: name,
      buffer: new Uint8Array([1]),
      minX: 0,
      minY: 0,
      w: width * 512,
      h: 48 * 512,
    }));
    textures.clear();
    for (const name of names.slice(0, 2)) {
      const w = 1 + (rand() % 97),
        h = 1 + (rand() % 83);
      textures.set(name, {
        width: w,
        height: h,
        data: Uint8ClampedArray.from({ length: w * h * 4 }, () => rand() & 255),
      });
    }
    for (const plane of [-1, 0, 1] as const) {
      const offsetY = plane * 24576;
      const composition = await createTerrainComposition(
        {
          seed: 1,
          isNGP: false,
          tileLayers,
          biomeData: { pixels: map },
          plane,
        },
        config,
        width,
      );
      for (const [x, localY, w, h] of [
        [-35855, -7171, 73, 9],
        [-529, -17, 619, 41],
        [-32, 480, 71, 55],
        [487, 511, 139, 65],
        [35819, 17399, 43, 17],
      ]) {
        const y = localY + offsetY;
        const actual = Uint8ClampedArray.from(
          { length: w * h * 4 },
          () => rand() & 255,
        );
        const expected = actual.slice();
        for (let row = 0; row < h; row++)
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            const foreground =
              composition.ownership.at(x + col, localY + row) < 0
                ? 0
                : readRGBA(expected, i);
            writeRGBA(
              expected,
              i,
              compositeTerrain(
                foreground,
                composition.backgroundAt(x + col, y + row),
              ),
            );
          }
        composition.finish(actual, x, y, w, h);
        expect(
          Buffer.from(actual).equals(Buffer.from(expected)),
          JSON.stringify({ x, y, w, h, width }),
        ).toBe(true);
        compared += actual.length;
      }
    }
  }
  expect(compared).toBeGreaterThan(1_000_000);
});
