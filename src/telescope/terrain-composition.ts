import {
  createLiquidSurfacePainter,
  findLiquidSurfaces,
  loadLiquidMaterialIds,
} from "./liquid-surfaces";
import {
  getMaterialAtlas,
  materialTexelRGBA,
} from "noita-telescope-full-pixels/gl/material_atlas.js";
import { buildMatColorTable } from "noita-telescope-full-pixels/gl/engine_resources.js";
import { createStaticTerrainMask } from "./static-terrain-mask";
import { createTerrainEdges, type TerrainMaterialAt } from "./terrain-edges";
import { includeElevatorOwnership } from "./terrain-elevator";
import {
  createPlaneOwnership,
  createBackgroundOwnership,
  WORLD_HEIGHT,
} from "./terrain-policy";
import {
  compositeTerrain,
  loadTerrainBackgrounds,
  textureColor,
} from "./terrain-backgrounds";
import { createTerrainScenes, readRGBA, writeRGBA } from "./terrain-scenes";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";

/** One pixel pipeline for GPU tiles, CPU tiles and the native bake. The source
 * terrain stays separate from the background until scene air masks have erased
 * cells. The resulting image is then reduced, never regenerated at lower zoom. */
export async function createTerrainComposition(
  gen: GLTerrainGeneration,
  config: Record<string, any>,
  width: number,
  materialAt?: TerrainMaterialAt,
  lattice?: any,
) {
  const ownership = createPlaneOwnership(
    gen.tileLayers,
    (gen.sourceBiomeData ?? gen.biomeData).pixels,
    gen.biomeData.pixels,
    config,
    width,
  );
  includeElevatorOwnership(ownership, gen.elevatorShafts, gen.plane);
  const backgroundOwnership = createBackgroundOwnership(
    ownership,
    gen.biomeData.pixels,
    config,
    gen.plane ?? 0,
  );
  const backgrounds = await loadTerrainBackgrounds(backgroundOwnership.names);
  const scenes = gen.sceneData
    ? await createTerrainScenes(gen.sceneData)
    : null;
  const edges = await createTerrainEdges(gen, config, width, materialAt);
  const staticMask = createStaticTerrainMask(gen.sceneData?.staticMasks);
  const offsetY = (gen.plane ?? 0) * WORLD_HEIGHT;
  const water = createLiquidSurfacePainter(
    findLiquidSurfaces(
      lattice ?? edges.lattice,
      await loadLiquidMaterialIds(),
      width,
      offsetY,
    ),
    width * 512,
  );
  const atlas = getMaterialAtlas(),
    materialColors = buildMatColorTable(atlas).data;
  const liquidColor = (id: number, x: number, y: number) => {
    const i = id * 4,
      entry = materialColors[i] & 255;
    if (entry) {
      const c = materialTexelRGBA(atlas, entry, x, y);
      return c === -1 ? 0 : c;
    }
    return (
      (((materialColors[i] >> 8) << 24) |
        (materialColors[i + 1] << 16) |
        (materialColors[i + 2] << 8) |
        materialColors[i + 3]) >>>
      0
    );
  };
  const backgroundAt = (x: number, y: number) => {
    const owner = backgroundOwnership.at(x, y - offsetY);
    const texture =
      owner < 0 ? null : backgrounds.get(backgroundOwnership.names[owner]);
    return texture
      ? textureColor(texture, x + width * 256, y - offsetY + 7168)
      : 0;
  };
  const hasTerrain = (x: number, y: number, w: number, h: number) => {
    if (scenes?.contains(x, y, w, h)) return true;
    for (
      let cy = Math.max(0, Math.floor((y - offsetY + 7168 - 42) / 512));
      cy <= Math.min(47, Math.floor((y + h - 1 - offsetY + 7168 + 42) / 512));
      cy++
    )
      for (
        let cx = Math.floor((x + width * 256 - 42) / 512);
        cx <= Math.floor((x + w - 1 + width * 256 + 42) / 512);
        cx++
      )
        if (
          ownership.owners[cy * width + (((cx % width) + width) % width)] >= 0
        )
          return true;
    return false;
  };
  return {
    ownership,
    backgroundAt,
    edgeStats: edges.stats,
    contains(x: number, y: number, w: number, h: number) {
      if (scenes?.contains(x, y, w, h)) return true;
      for (
        let cy = Math.floor((y - offsetY + 7168) / 512);
        cy <= Math.floor((y + h - 1 - offsetY + 7168) / 512);
        cy++
      )
        for (
          let cx = Math.floor((x + width * 256) / 512);
          cx <= Math.floor((x + w - 1 + width * 256) / 512);
          cx++
        )
          if (
            ownership.at(cx * 512 - width * 256, cy * 512 - 7168) >= 0 ||
            backgroundOwnership.at(cx * 512 - width * 256, cy * 512 - 7168) >= 0
          )
            return true;
      return false;
    },
    finish(
      pixels: Uint8ClampedArray,
      x: number,
      y: number,
      w: number,
      h: number,
    ) {
      const background = new Uint8ClampedArray(pixels.length);
      for (let row = 0; row < h; row++)
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4;
          if (ownership.at(x + col, y + row - offsetY) < 0)
            pixels.fill(0, i, i + 4);
          writeRGBA(background, i, backgroundAt(x + col, y + row));
        }
      water(pixels, x, y, w, h,
        (wx, wy) => ownership.at(wx, wy - offsetY) < 0 ? -1 : edges.sample(wx, wy),
        liquidColor);
      scenes?.paint(pixels, background, x, y, w, h);

      if (hasTerrain(x, y, w, h))
        edges.paint(
          pixels,
          x,
          y,
          w,
          h,
          (wx, wy) =>
            ownership.at(wx, wy - offsetY) >= 0 || !!scenes?.paintsAt(wx, wy),
        );
      staticMask.clear(pixels, x, y, w, h, true);
      for (let i = 0; i < pixels.length; i += 4)
        writeRGBA(
          pixels,
          i,
          compositeTerrain(readRGBA(pixels, i), readRGBA(background, i)),
        );
      staticMask.clear(pixels, x, y, w, h);
      return pixels;
    },
  };
}
