import { prepareElevatorShafts } from "./terrain-elevator";
import type { GLTerrainGeneration } from "./gl-terrain-tile-source";
import { WORLD_HEIGHT, WORLD_TOP, type VerticalPlane } from "./terrain-policy";

const planes = new WeakMap<any[], Map<number, GLTerrainGeneration>>();
/** The captured game repeats the MAIN wang geometry in vertical worlds. Only
 * the biome/material lookup broadcasts the top/bottom row. Regenerating wang
 * tiles from that broadcast creates a continuous strip and fills the gaps
 * between mines, holy mountains, etc. that are empty in the engine capture. */
export async function prepareTerrainPlane(
  gen: GLTerrainGeneration,
  plane: VerticalPlane,
): Promise<GLTerrainGeneration> {
  if (plane === 0) return { ...gen, plane: 0 };
  let cache = planes.get(gen.tileLayers);
  if (!cache) {
    cache = new Map();
    planes.set(gen.tileLayers, cache);
  }
  let result = cache.get(plane);
  if (!result) {
    const sourceBiomeData = gen.sourceBiomeData ?? gen.biomeData;
    const w = sourceBiomeData.pixels.length / 48;
    if (!Number.isInteger(w) || w < 1)
      throw new Error("Invalid source biome map dimensions");
    const pixels = new Uint32Array(w * 48);
    const row = plane < 0 ? 0 : 47;
    for (let y = 0; y < 48; y++)
      pixels.set(
        sourceBiomeData.pixels.subarray(row * w, (row + 1) * w),
        y * w,
      );
    result = {
      ...gen,
      elevatorShafts:
        plane === 1 ? await prepareElevatorShafts(gen) : undefined,
      plane,
      sourceBiomeData,
      // Read-only: same generated buffers/claims, not newly generated strips.
      tileLayers: gen.tileLayers,
      biomeData: { pixels, heavenPixels: pixels, hellPixels: pixels },
    };
    cache.set(plane, result);
  }
  return result;
}

export function planeAtWorldY(y: number): VerticalPlane | null {
  const plane = Math.floor((y - WORLD_TOP) / WORLD_HEIGHT);
  return plane >= -1 && plane <= 1 ? (plane as VerticalPlane) : null;
}
