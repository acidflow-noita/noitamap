import { expect, it } from "vitest";
import {
  createSeamPolicy,
  staticSceneBits,
  loadSceneBiomeColors,
} from "../src/native-map/composition/world-resources";
import { encode } from "fast-png";
import {
  liquidMaterialIds,
  findLiquidSurfaces,
} from "../src/native-map/composition/liquid-inputs";
import { buildEdgeTables as ownedTables } from "../src/native-map/composition/edge-tables";
import { buildEdgeTables as referenceTables } from "../src/native-map/edges/data";
import { resolveCellFull } from "../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js";
import { BIOME_ENGINE } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { SKIP_SEAM_EDGE_BIOMES } from "../lib/noita-telescope-vm/js/pixel_scene_edge_flags.js";

it("builds identical strict edge ABI tables with owned data and current-runtime Math", () => {
  const owned = ownedTables(),
    expected = referenceTables();
  for (const [name, value] of Object.entries(expected)) {
    const actual = owned[name as keyof typeof owned];
    if (ArrayBuffer.isView(value)) {
      expect(ArrayBuffer.isView(actual)).toBe(true);
      const a = actual as ArrayBufferView;
      expect(
        Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
          Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        ),
        name,
      ).toBe(true);
    } else expect(actual, name).toBe(value);
  }
});
it("resolves aligned seam chunk centers exactly across pitches, world repeats and vertical clamps", () => {
  const colors = [
    0,
    ...BIOME_ENGINE.map((b) => b.color),
    ...SKIP_SEAM_EDGE_BIOMES,
  ];
  const noise = new Map(
    BIOME_ENGINE.map((b) => [b.color & 0xffffff, b.noiseBiomeEdges !== false]),
  );
  let count = 0,
    skipped = 0;
  for (const width of [64, 70, 71]) {
    const pixels = Uint32Array.from(
      { length: width * 48 },
      (_, i) => colors[(i * 37 + 13) % colors.length],
    );
    const sample = createSeamPolicy(pixels, width),
      shiftX = (width * 256) % 512;
    const bmap = {
      w: width,
      colorAt: (cx: number, cy: number) => pixels[cy * width + cx] & 0xffffff,
    };
    for (let cy = -100; cy <= 100; cy += 3)
      for (let cx = -120; cx <= 120; cx += 7) {
        const cell = resolveCellFull(
          bmap,
          cx * 512 - shiftX + 256,
          cy * 512 + 256,
          (color: number) => noise.get(color) !== false,
        ) as { color: number };
        const result = sample(cx, cy);
        expect(result).toBe(SKIP_SEAM_EDGE_BIOMES.has(cell.color));
        count++;
        skipped += Number(result);
      }
  }
  expect(count).toBeGreaterThan(6000);
  expect(skipped).toBeGreaterThan(0);
  expect(skipped).toBeLessThan(count);
});
it("resolves inherited liquid physics and preserves connected-run source levels", () => {
  const ids = liquidMaterialIds(
    `<Materials>
    <CellData name="water" cell_type="liquid" liquid_sand="0"/>
    <CellDataChild name="water_child" _parent="water"/>
    <CellDataChild name="powder" _parent="water" liquid_sand="1"/>
    <!-- <CellData name="water" cell_type="solid"/> -->
    <CellData name="unknown" cell_type="liquid"/>
  </Materials>`,
    ["air", "water", "water_child", "powder", "unknown"],
  );
  expect(ids).toEqual(new Set([1, 2]));
  const GW = 7,
    GH = 5,
    mat = new Uint16Array(GW * GH),
    cov = new Float32Array(GW * GH);
  for (let y = 2; y < GH; y++)
    for (let x = 0; x < 6; x++) {
      if (y === 2 && x >= 3) continue;
      mat[y * GW + x] = 2;
      cov[y * GW + x] = 1;
    }
  const main = findLiquidSurfaces({ GW, GH, mat, cov }, ids, 70);
  const lower = findLiquidSurfaces({ GW, GH, mat, cov }, ids, 70, 24576);
  expect(main).toHaveLength(2);
  expect(main[0].y).toBe(main[1].y);
  expect(main.every((s) => s.sourceY !== undefined)).toBe(true);
  expect(
    lower.map((s) => ({ ...s, y: s.y - 24576, sourceY: s.sourceY! - 24576 })),
  ).toEqual(main);
});
it("keeps ordinary and force-air static ownership bits distinct and LSB first", () => {
  const pixels = Uint8Array.from([
    0, 0, 0, 255, 0, 0, 66, 255, 255, 255, 255, 255, 12, 34, 56, 0, 1, 2, 3,
    128, 0, 0, 66, 0, 0, 0, 0, 0, 0, 0, 66, 128,
  ]);
  expect(staticSceneBits(pixels)).toEqual(new Uint8Array([0b00010100]));
  expect(staticSceneBits(pixels, true)).toEqual(new Uint8Array([0b10000010]));
});
it("requests authoritative game biome color maps explicitly", async () => {
  const paths: string[] = [],
    images: Record<string, Uint8Array> = {};
  for (const [name, rgb] of [
    ["biome_map", [0, 0, 1]],
    ["biome_map_background", [42, 44, 50]],
    ["biome_map_foreground", [60, 70, 80]],
  ] as const)
    images[`data/biome_impl/${name}.png`] = encode({
      width: 1,
      height: 1,
      channels: 4,
      data: new Uint8Array([...rgb, 255]),
    });
  const colors = await loadSceneBiomeColors(
    {
      revision: "explicit-game-color-maps",
      async read(path) {
        paths.push(path);
        if (!images[path]) throw new Error(`Unspecified path ${path}`);
        return images[path];
      },
    },
    { watercave: { color: 1 } },
  );
  expect(paths).toEqual([
    "data/biome_impl/biome_map.png",
    "data/biome_impl/biome_map_background.png",
    "data/biome_impl/biome_map_foreground.png",
  ]);
  expect(colors.biomeBackgroundColors.watercave).toBe(0x2a2c32);
  expect(colors.biomeForegroundColors.watercave).toBe(0x3c4650);
});
