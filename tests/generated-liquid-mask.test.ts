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
vi.mock("noita-telescope-full-pixels/gl/material_atlas.js", () => ({ getMaterialAtlas: () => ({}), materialTexelRGBA: () => 0 }));
vi.mock("noita-telescope-full-pixels/gl/engine_resources.js", () => ({ buildMatColorTable: () => ({ data: new Uint8Array() }) }));
import JSZip from "jszip";
import { createTerrainEdges } from "../src/telescope/terrain-edges";
import { clearStaticLiquidMask } from "../src/telescope/terrain-composition";
import { liquidMaterialIds, createLiquidSurfacePainter } from "../src/telescope/liquid-surfaces";
import { MATERIAL_NAMES_BY_ID, WANG_COLOR_TO_ID } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { GENERATOR_CONFIG } from "../lib/noita-telescope-vm/js/generator_config.js";

const id = (name: string) => MATERIAL_NAMES_BY_ID.indexOf(name);
const water = id("water"), lava = id("lava"), rock = id("rock_static_wet");
const gen = () => ({ seed: 786433191, isNGP: false, tileLayers: [],
  biomeData: { pixels: new Uint32Array(70 * 48).fill(GENERATOR_CONFIG.coalmine.color) } });
const rgba = (material: number) => {
  const color = material === 0 ? 66 : WANG_COLOR_TO_ID.find((entry: number[]) => entry[1] === material)![0];
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, 255];
};
let ids: Set<number>;
beforeAll(async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL("../public/data.zip", import.meta.url)));
  ids = liquidMaterialIds(await zip.file("data/materials.xml")!.async("string"), MATERIAL_NAMES_BY_ID);
});

describe("generated liquid masks from actual material composition", () => {
  it("includes opaque/glowing fluids, excludes air, powders, solids and unowned terrain without another sampling pass", async () => {
    const materials = [0, water, id("blood"), lava, rock, id("sand"), id("material_rainbow")];
    let calls = 0;
    const edges = await createTerrainEdges(gen(), GENERATOR_CONFIG, 70,
      (x: number) => { calls++; return materials[((x % materials.length) + materials.length) % materials.length]; });
    const plain = new Uint8ClampedArray(7 * 3 * 4).fill(91), masked = plain.slice(), mask = new Uint8Array(21).fill(123);
    edges.paint(plain, 0, 0, 7, 3, (x: number) => x !== 6);
    const initial = calls;
    edges.paint(masked, 0, 0, 7, 3, (x: number) => x !== 6, { pixels: mask, ids });
    expect(calls - initial).toBe(initial);
    expect(masked).toEqual(plain);
    expect([...mask]).toEqual(Array(3).fill([0, 255, 255, 255, 0, 0, 0]).flat());
  });

  it("uses scene FORCE AIR and solid/fluid replacements even under misleading visual art", async () => {
    const g = { ...gen(), sceneData: {
      scenes: [{ key: "general/test", name: "test", x: 0, y: 0, width: 4, height: 1 }],
      sources: { "general/test": { width: 4, height: 1, skipEdgeTextures: true,
        data: new Uint8Array([...rgba(0), ...rgba(rock), ...rgba(lava), 0, 0, 0, 0]),
        visualArt: { width: 4, height: 1, data: new Uint8Array(16).fill(255) } } },
    } };
    const edges = await createTerrainEdges(g, GENERATOR_CONFIG, 70, () => water);
    const mask = new Uint8Array(4);
    edges.paint(new Uint8ClampedArray(16), 0, 0, 4, 1, () => true, { pixels: mask, ids });
    expect([...mask]).toEqual([0, 0, 255, 255]);
    // Material identity remains authoritative even for an invisible scene cell
    // outside generated terrain ownership.
    edges.paint(new Uint8ClampedArray(16), 0, 0, 4, 1, () => false, { pixels: mask, ids });
    expect([...mask]).toEqual([0, 0, 255, 0]);
  });

  it("matches leveled pool occupancy while preserving scene and static-area exclusions", async () => {
    const w = 16, h = 32, original = new Int16Array(w * h);
    for (let x = 0; x < w; x++) for (let y = (x < 8 ? 8 : 18) + x % 3 - 1; y < 26; y++) original[y * w + x] = water;
    original[10 * w + 3] = rock;
    const sample = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h ? original[y * w + x] : 0;
    const g = { ...gen(), sceneData: {
      scenes: [{ key: "general/test", name: "test", x: 8, y: 14, width: 3, height: 1 }],
      sources: { "general/test": { width: 3, height: 1, skipEdgeTextures: true,
        data: new Uint8Array([...rgba(0), ...rgba(rock), ...rgba(lava)]) } },
    } };
    const edges = await createTerrainEdges(g, GENERATOR_CONFIG, 70, sample);
    const pixels = new Uint8ClampedArray(w * h * 4), mask = new Uint8Array(w * h), changes = new Map<number, number>();
    createLiquidSurfacePainter([
      { left: 0, right: 8, y: 13, sourceY: 8, material: water },
      { left: 8, right: 16, y: 13, sourceY: 18, material: water },
    ], 35840)(pixels, 0, 0, w, h, sample, () => 0xff112233, (pixel, material) => changes.set(pixel, material));
    edges.paint(pixels, 0, 0, w, h, () => true, { pixels: mask, ids, surfaceChanges: changes });
    clearStaticLiquidMask(mask, 0, 0, w, h, [{ x: 2, y: 16, width: 3, height: 1,
      bits: new Uint8Array([1]), airBits: new Uint8Array([4]) }]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const excluded = y === 14 && (x === 8 || x === 9) || y === 16 && (x === 2 || x === 4);
      expect(mask[y * w + x], `${x},${y}`).toBe(y >= 13 && y < 26 && !excluded ? 255 : 0);
    }
    expect(changes.size).toBeGreaterThan(20);
  });
});
