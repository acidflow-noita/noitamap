import type { TerrainScene, TerrainSceneSource } from "./terrain-scenes";
import {
  BIOME_ENGINE,
  WANG_COLOR_TO_ID,
  MATERIAL_NAMES_BY_ID,
} from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import {
  computeMaterialNoiseDensity,
  selectComponentForCell,
} from "noita-telescope-full-pixels/engine_resolve/band_select.js";
import {
  GENERATOR_CONFIG,
  FILL_BIOME_MATERIALS,
} from "noita-telescope-full-pixels/generator_config.js";

const byColor = new Map<number, any>(
  BIOME_ENGINE.map((b: any) => [b.color & 0xffffff, b]),
);
const wangIds = new Map<number, number>(WANG_COLOR_TO_ID);
const materialIds = new Map<string, number>(
  MATERIAL_NAMES_BY_ID.map((name: string, id: number) => [name, id]),
);
export const SCENE_UNTOUCHED = -2;
const UNKNOWN_MATERIAL = 0x7ffe;

/** Material identity, not display RGB: colors_filename does not change what
 * material a scene creates. Keep force-air, untouched, and unknown distinct so
 * a scene can erase previous terrain stamps without inventing rock edges. */
export function sceneMaterialGrid(
  scene: TerrainScene,
  source: TerrainSceneSource,
) {
  let biome = scene.key.split("/")[0];
  const substitutions: [number, number][] = [];
  for (const part of (scene.variantKey ?? "").split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === "biome") biome = part.slice(eq + 1);
    else
      substitutions.push([
        parseInt(part.slice(0, eq), 16) & 0xffffff,
        parseInt(part.slice(eq + 1), 16) & 0xffffff,
      ]);
  }
  const names = biome.split("@");
  const densityBiome = names
    .map((name) => byColor.get(GENERATOR_CONFIG[name]?.color & 0xffffff))
    .find((b) => b?.bands.length);
  const fill = names
    .map(
      (name) => FILL_BIOME_MATERIALS[GENERATOR_CONFIG[name]?.color & 0xffffff],
    )
    .find((name) => name !== undefined);
  const fillId = materialIds.get(fill) ?? UNKNOWN_MATERIAL;
  const { width, height, data, visualArt } = source;
  const grid = new Int16Array(width * height).fill(SCENE_UNTOUCHED);
  const artMask = visualArt
    ? new Uint8Array(Math.ceil((width * height) / 8))
    : null;
  for (let p = 0; p < grid.length; p++) {
    const i = p * 4;
    if (!data[i + 3]) continue;
    let rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    for (const [from, to] of substitutions) if (rgb === from) rgb = to;
    if (rgb === 0x000042) grid[p] = 0;
    else {
      const r = rgb >>> 16,
        g = (rgb >>> 8) & 255,
        b = rgb & 255;
      grid[p] =
        r === g && g === b && r > 0
          ? densityBiome
            ? Math.max(
                0,
                selectComponentForCell(
                  densityBiome,
                  scene.x + (p % width),
                  scene.y + Math.floor(p / width),
                  computeMaterialNoiseDensity(
                    scene.x + (p % width),
                    scene.y + Math.floor(p / width),
                    1,
                  ),
                ),
              )
            : fillId
          : (wangIds.get(rgb) ?? UNKNOWN_MATERIAL);
    }
    const x = p % width,
      y = Math.floor(p / width);
    if (
      artMask &&
      visualArt &&
      x < visualArt.width &&
      y < visualArt.height &&
      visualArt.data[(y * visualArt.width + x) * 4 + 3] >= 128
    )
      artMask[p >> 3] |= 0x80 >> (p & 7);
  }
  return {
    grid,
    width,
    height,
    x: scene.x,
    y: scene.y,
    skipEdges: !!source.skipEdgeTextures,
    artMask,
  };
}
