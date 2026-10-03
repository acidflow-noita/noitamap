import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/engine_data.js",
  async () =>
    import("../lib/noita-telescope-vm/js/engine_resolve/engine_data.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/chunk_wobble.js",
  async () =>
    import("../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/band_select.js",
  async () =>
    import("../lib/noita-telescope-vm/js/engine_resolve/band_select.js"),
);
vi.mock(
  "noita-telescope-full-pixels/generator_config.js",
  async () => import("../lib/noita-telescope-vm/js/generator_config.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/material_field.js",
  async () =>
    import("../lib/noita-telescope-vm/js/engine_resolve/material_field.js"),
);
vi.mock("noita-telescope-full-pixels/edge_decals.js", async () => {
  const actual = await import("../lib/noita-telescope-vm/js/edge_decals.js");
  return {
    ...actual,
    initEdgeDecalAtlas: async () =>
      actual.setEdgeDecalAtlas(
        await readFile(
          new URL(
            "../lib/noita-telescope-vm/data/edge_atlas.bin",
            import.meta.url,
          ),
        ),
      ),
  };
});
import { createTerrainEdges } from "../src/telescope/terrain-edges";
import { MATERIAL_NAMES_BY_ID } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { GENERATOR_CONFIG } from "../lib/noita-telescope-vm/js/generator_config.js";
import { sceneMaterialGrid } from "../src/telescope/scene-material-grid";
const rock = MATERIAL_NAMES_BY_ID.indexOf("rock_static_wet");
const gen = () => ({
  seed: 786433191,
  isNGP: false,
  tileLayers: [],
  biomeData: {
    pixels: new Uint32Array(70 * 48).fill(GENERATOR_CONFIG.coalmine.color),
  },
});
const raw = (x: number, y: number) =>
  y >= 64 + Math.round(Math.sin(x / 15) * 10) ? rock : 0;
describe("actual EdgeGraphics stamps", () => {
  it("dresses dense stone, leaves air/deep interiors alone, and is deterministic", async () => {
    const edges = await createTerrainEdges(gen(), GENERATOR_CONFIG, 70, raw);
    const a = new Uint8ClampedArray(128 * 128 * 4),
      b = a.slice();
    edges.paint(a, 0, 0, 128, 128, () => true);
    edges.paint(b, 0, 0, 128, 128, () => true);
    expect(a).toEqual(b);
    expect(edges.stats.stampedPixels).toBeGreaterThan(100);
    expect(a.subarray(0, 32 * 128 * 4).some((a) => a !== 0)).toBe(false);
    expect(a.subarray(100 * 128 * 4).some((a) => a !== 0)).toBe(false);
  });
  it("preserves exact protected static pixels even where a rock edge would stamp", async () => {
    const edges = await createTerrainEdges(gen(), GENERATOR_CONFIG, 70, raw),
      a = new Uint8ClampedArray(128 * 128 * 4);
    edges.paint(a, 0, 0, 128, 128, (x) => x >= 64);
    for (let y = 0; y < 128; y++)
      expect(
        a.subarray(y * 128 * 4, (y * 128 + 64) * 4).some((a) => a !== 0),
      ).toBe(false);
    expect(edges.stats.stampedPixels).toBeGreaterThan(20);
  });
  it("erases terrain stamps under scene FORCE AIR before running scene edges", async () => {
    const source = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < source.length; i += 4) {
      source[i + 2] = 66;
      source[i + 3] = 255;
    }
    const g = {
      ...gen(),
      sceneData: {
        scenes: [
          {
            key: "general/test",
            name: "test",
            x: 40,
            y: 48,
            width: 32,
            height: 32,
          },
        ],
        sources: {
          "general/test": {
            data: source,
            width: 32,
            height: 32,
            skipEdgeTextures: true,
          },
        },
      },
    };
    const edges = await createTerrainEdges(g, GENERATOR_CONFIG, 70, raw),
      a = new Uint8ClampedArray(128 * 128 * 4);
    edges.paint(a, 0, 0, 128, 128, () => true);
    for (let y = 48; y < 80; y++)
      expect(
        a.subarray((y * 128 + 40) * 4, (y * 128 + 72) * 4).some((v) => v !== 0),
      ).toBe(false);
  });
  it("does not stamp rock graphics on true liquids", async () => {
    const water = MATERIAL_NAMES_BY_ID.indexOf("water");
    const edges = await createTerrainEdges(
        gen(),
        GENERATOR_CONFIG,
        70,
        (_x, y) => (y >= 64 ? water : 0),
      ),
      a = new Uint8ClampedArray(128 * 128 * 4);
    edges.paint(a, 0, 0, 128, 128, () => true);
    expect(edges.stats.stampedPixels).toBe(0);
  });
});
it("scene material grids distinguish air, untouched and authored materials and preserve skip_edge_textures", () => {
  const source = {
    width: 3,
    height: 1,
    data: new Uint8Array([0, 0, 0, 0, 0, 0, 66, 255, 235, 205, 1, 255]),
    skipEdgeTextures: true,
  };
  const grid = sceneMaterialGrid(
    {
      key: "general/test",
      name: "test",
      variantKey: "biome=coalmine",
      x: 0,
      y: 0,
      width: 3,
      height: 1,
    },
    source,
  );
  expect(Array.from(grid.grid)).toEqual([
    -2,
    0,
    MATERIAL_NAMES_BY_ID.indexOf("gold"),
  ]);
  expect(grid.skipEdges).toBe(true);
});
it("keeps edge pixels identical across independently rendered tile boundaries", async () => {
  const edges = await createTerrainEdges(gen(), GENERATOR_CONFIG, 70, raw);
  const full = new Uint8ClampedArray(256 * 128 * 4);
  edges.paint(full, -128, 0, 256, 128, () => true);
  const joined = new Uint8ClampedArray(full.length);
  for (const x of [-128, 0]) {
    const half = new Uint8ClampedArray(128 * 128 * 4);
    edges.paint(half, x, 0, 128, 128, () => true);
    for (let y = 0; y < 128; y++)
      joined.set(
        half.subarray(y * 128 * 4, (y + 1) * 128 * 4),
        (y * 256 + x + 128) * 4,
      );
  }
  expect(joined).toEqual(full);
});
