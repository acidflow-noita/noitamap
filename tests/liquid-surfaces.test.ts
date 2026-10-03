import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { MATERIAL_NAMES_BY_ID as GAME_MATERIALS } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import {
  MATERIAL_TYPE_BY_NAME,
  MATERIAL_TYPE_KEYS,
} from "../lib/noita-telescope-vm/js/engine_resolve/edge_data.js";
import { describe, it, expect, vi } from "vitest";
vi.mock("noita-telescope-full-pixels/engine_resolve/engine_data.js", () => ({
  MATERIAL_NAMES_BY_ID: [],
}));
import {
  liquidMaterialIds,
  findLiquidSurfaces,
  createLiquidSurfacePainter,
} from "../src/telescope/liquid-surfaces";
describe("flat authored liquid surfaces", () => {
  it("distinguishes liquids from powdered metals using inherited liquid_sand", () => {
    const ids = liquidMaterialIds(
      `<Materials>
      <CellData name="water" cell_type="liquid" liquid_sand="0"></CellData>
      <CellData name="gold" cell_type="liquid" liquid_sand="1"></CellData>
      <CellDataChild name="blood" _parent="water"></CellDataChild>
      <CellDataChild name="copper" _parent="gold"></CellDataChild>
      <CellData name="rock" cell_type="solid"></CellData></Materials>`,
      ["air", "water", "gold", "blood", "copper", "rock"],
    );
    expect([...ids]).toEqual([1, 3]);
  });
  it("finds a straight pool even when neighbor-majority copied its id into zero coverage above", () => {
    const mat = new Uint16Array(4 * 4),
      cov = new Float32Array(4 * 4);
    for (let x = 1; x <= 2; x++) {
      mat[4 + x] = 57;
      mat[8 + x] = 57;
      cov[8 + x] = 1;
    }
    const surfaces = findLiquidSurfaces(
      { GW: 4, GH: 4, mat, cov },
      new Set([56]),
      70,
    );
    expect(surfaces).toEqual([
      { left: -17915, right: -17895, y: -7153, material: 56 },
    ]);
    expect(
      findLiquidSurfaces({ GW: 4, GH: 4, mat, cov }, new Set([135]), 70),
    ).toEqual([]);
  });
  it("levels only the free surface, preserving rocks, powders, and liquid bottoms", () => {
    const w = 16,
      h = 20,
      original = new Int16Array(w * h),
      pixels = new Uint8ClampedArray(w * h * 4);
    for (let x = 0; x < w; x++)
      for (let y = 8 + (x % 3); y < 16; y++) original[y * w + x] = 56;
    original[10 * w + 2] = 135;
    original[9 * w + 3] = 8;
    pixels.fill(255);
    const sample = (x: number, y: number) =>
      x >= 0 && x < w && y >= 0 && y < h ? original[y * w + x] : 0;
    const paint = createLiquidSurfacePainter(
      [{ left: 0, right: 16, y: 10, material: 56 }],
      35840,
    );
    paint(pixels, 0, 0, w, h, sample, () => 0xff112233);
    for (let x = 0; x < w; x++)
      for (let y = 4; y < 10; y++)
        if (original[y * w + x] === 56)
          expect(pixels[(y * w + x) * 4 + 3]).toBe(0);
    expect(pixels[(10 * w + 2) * 4]).toBe(255); // powder unchanged
    expect(pixels[(9 * w + 3) * 4]).toBe(255); // rock unchanged
    expect(pixels[(16 * w + 1) * 4]).toBe(255); // outside surface band
  });
  it("produces identical surface pixels for independent tiles across a seam", () => {
    const paint = createLiquidSurfacePainter(
      [{ left: 0, right: 32, y: 10, material: 56 }],
      35840,
    );
    const sample = (x: number, y: number) =>
      y >= 8 + (x % 4) && y < 20 ? 56 : 0;
    const full = new Uint8ClampedArray(32 * 24 * 4).fill(255),
      parts = new Uint8ClampedArray(full.length);
    paint(full, 0, 0, 32, 24, sample, () => 0xff112233);
    for (const x of [0, 16]) {
      const tile = new Uint8ClampedArray(16 * 24 * 4).fill(255);
      paint(tile, x, 0, 16, 24, sample, () => 0xff112233);
      for (let y = 0; y < 24; y++)
        parts.set(
          tile.subarray(y * 16 * 4, (y + 1) * 16 * 4),
          (y * 32 + x) * 4,
        );
    }
    expect(parts).toEqual(full);
  });
});

describe("classification from shipped Noita materials.xml", () => {
  it("excludes desert ground, loose sand, gunpowder and powdered metals from leveling", async () => {
    const zip = await JSZip.loadAsync(
      await readFile(new URL("../public/data.zip", import.meta.url)),
    );
    const xml = await zip.file("data/materials.xml")!.async("string");
    const ids = liquidMaterialIds(xml, GAME_MATERIALS);
    for (const name of [
      "sand_static",
      "sand",
      "sandstone",
      "soil",
      "soil_lush",
      "snow",
      "coal",
      "gunpowder",
      "gunpowder_explosive",
      "gold",
      "copper",
      "brass",
      "silver",
      "diamond",
      "purifying_powder",
    ]) {
      const id = GAME_MATERIALS.indexOf(name);
      expect(id, `No engine material for ${name}`).toBeGreaterThanOrEqual(0);
      expect(ids.has(id), `${name} MUST NOT be leveled as a fluid`).toBe(false);
    }
    for (const name of [
      "water",
      "water_static",
      "blood",
      "oil",
      "acid",
      "lava",
      "magic_liquid_charm",
    ]) {
      expect(
        ids.has(GAME_MATERIALS.indexOf(name)),
        `${name} should be recognized as fluid`,
      ).toBe(true);
    }
    // Independent generated engine type table classifies sand/powder separately.
    // Check the whole shader material list, not only the hand-selected examples.
    let powders = 0;
    GAME_MATERIALS.forEach((name, id) => {
      if (
        MATERIAL_TYPE_KEYS[
          (MATERIAL_TYPE_BY_NAME as Record<string, number>)[name]
        ] !== "sand"
      )
        return;
      expect(
        ids.has(id),
        `engine sand/powder ${name} was treated as fluid`,
      ).toBe(false);
      powders++;
    });
    expect(powders).toBeGreaterThan(50);
  });
  it("does not treat an unknown flag or commented-out definition as liquid", () => {
    const xml = `<Materials>
      <CellData name="sand_static" cell_type="liquid" liquid_sand="1" liquid_static="1" />
      <!-- <CellData name="sand_static" cell_type="liquid" liquid_sand="0" /> -->
      <CellData name="unknown" cell_type="liquid" />
      <CellDataChild name="unknown_child" _parent="missing" cell_type="liquid" />
    </Materials>`;
    expect([
      ...liquidMaterialIds(xml, ["sand_static", "unknown", "unknown_child"]),
    ]).toEqual([]);
  });
});
