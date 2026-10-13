import {
  currentNativeEdges,
  readyNativeEdges,
  warmNativeEdges,
} from "../native-map/edges";
import Flatbush from "flatbush";
import {
  EDGE_DECAL_HALO,
  initEdgeDecalAtlas,
  stampEdgeDecals,
} from "noita-telescope-full-pixels/edge_decals.js";
import { EDGE_IMAGES } from "noita-telescope-full-pixels/engine_resolve/edge_data.js";
import { createMaterialField } from "noita-telescope-full-pixels/engine_resolve/material_field.js";
import { sceneMaterialGrid } from "./scene-material-grid";
import { compositeTerrain } from "./terrain-backgrounds";
import { readRGBA, writeRGBA } from "./terrain-scenes";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import type { ReadMaterialRect } from "./material-cache";
export type TerrainMaterialAt = (x: number, worldY: number) => number;

// Match the stamper's scan bounds: origins farther than the largest sprite's
// reach cannot affect the kept tile. Its normal rays sample t=1..4, so only
// four extra material pixels are needed beyond that scan. Keep the full decal
// buffer/halo and paint order; skip only material samples nobody can read.
const stampReach =
  1 +
  EDGE_IMAGES.reduce((reach: number, image: number[]) => {
    const [, , w, h, , , flags] = image;
    return Math.max(
      reach,
      flags & 2 ? h >> 1 : flags & 4 ? w >> 1 : Math.max(w >> 1, h >> 1),
    );
  }, 0);
const unusedHalo = Math.max(0, EDGE_DECAL_HALO - stampReach - 4);
export const TERRAIN_MATERIAL_HALO = EDGE_DECAL_HALO - unusedHalo;

/** Paint the existing render-perf EdgeGraphics pass into final leaf pixels,
 * not a zoom-gated overlay. The deterministic world-space pass includes a halo
 * so independent tile requests have the same neighborhood and stamp order.
 * The fork uses position-seeded decoration randomness, not a recovered capture
 * RNG stream; this restores the missing pass, not a claim of pixel-exact stamps. */
export async function createTerrainEdges(
  gen: GLTerrainGeneration,
  config: Record<string, any>,
  width: number,
  materialAt?: TerrainMaterialAt,
  readMaterials?: ReadMaterialRect,
) {
  warmNativeEdges();
  await initEdgeDecalAtlas();
  const nativeEdges = await readyNativeEdges();
  const field = materialAt
    ? null
    : createMaterialField(
        gen.tileLayers,
        gen.biomeData,
        config,
        width,
        gen.seed,
      );
  const sample = materialAt ?? ((x, y) => field!.materialAt(x, y));
  const scenes = gen.sceneData?.scenes ?? [];
  const index = scenes.length ? new Flatbush(scenes.length) : null;
  for (const scene of scenes)
    index!.add(scene.x, scene.y, scene.x + scene.width, scene.y + scene.height);
  index?.finish();
  const grids = new Map<number, ReturnType<typeof sceneMaterialGrid>>();
  const stats = { tiles: 0, stampedPixels: 0 };
  return {
    stats,
    sample,
    lattice: field?.lattice,
    paint(
      pixels: Uint8ClampedArray,
      x: number,
      y: number,
      w: number,
      h: number,
      canPaint: (x: number, y: number) => boolean,
    ) {
      const pad = EDGE_DECAL_HALO,
        pw = w + pad * 2,
        ph = h + pad * 2;
      const left = x - pad,
        top = y - pad;
      const materials = new Int16Array(pw * ph);
      if (readMaterials) {
        readMaterials(
          left + unusedHalo,
          top + unusedHalo,
          pw - unusedHalo * 2,
          ph - unusedHalo * 2,
          { data: materials, stride: pw, offset: unusedHalo * pw + unusedHalo },
        );
      } else
        for (let py = unusedHalo; py < ph - unusedHalo; py++)
          for (let px = unusedHalo; px < pw - unusedHalo; px++)
            materials[py * pw + px] = sample(left + px, top + py);
      const sceneGrids = (index?.search(left, top, left + pw, top + ph) ?? [])
        .sort((a, b) => a - b)
        .map((id) => {
          let grid = grids.get(id);
          if (!grid) {
            grid = sceneMaterialGrid(
              scenes[id],
              gen.sceneData!.sources[scenes[id].key],
            );
            grids.set(id, grid);
            while (grids.size > 128) grids.delete(grids.keys().next().value!);
          }
          return grid;
        });
      const stamp =
        (nativeEdges?.enabled ? nativeEdges : currentNativeEdges())?.stamp ??
        stampEdgeDecals;
      const decals = stamp(materials, pw, ph, left, top, gen.seed, {
        chunkShiftX: (width * 256) % 512,
        chunkShiftY: 0,
        scenes: sceneGrids,
        biomeData: gen.biomeData,
        mapWidth: width,
        inset: pad,
      });
      stats.tiles++;
      for (let py = 0; py < h; py++)
        for (let px = 0; px < w; px++) {
          const s = ((py + pad) * pw + px + pad) * 4,
            d = (py * w + px) * 4;
          if (!decals[s + 3] || !canPaint(x + px, y + py)) continue;
          writeRGBA(
            pixels,
            d,
            compositeTerrain(readRGBA(decals, s), readRGBA(pixels, d)),
          );
          stats.stampedPixels++;
        }
    },
  };
}
