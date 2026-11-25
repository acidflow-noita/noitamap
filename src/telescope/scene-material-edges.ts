import { compositeTerrain } from './terrain-backgrounds';
import { readRGBA, writeRGBA, type TerrainScene, type TerrainSceneSource } from './terrain-scenes';
import { EDGE_DECAL_HALO, initEdgeDecalAtlas, stampEdgeDecals } from 'noita-telescope-full-pixels/edge_decals.js';
import { sceneMaterialGrid } from './scene-material-grid';

export async function paintSceneEdges(pixels: Uint8ClampedArray, placed: TerrainScene, source: TerrainSceneSource, seed: number) {
  // EdgeGraphics dresses the scene's material cells before the backdrop is
  // composited. Use the scene-local pass, without resolving a world lattice.
  // As in the baker, stamps use deterministic seed/position randomness rather
  // than the game's runtime RNG, so individual flecks can differ from a capture.
  await initEdgeDecalAtlas();
  const pad = EDGE_DECAL_HALO, width = source.width + 2 * pad, height = source.height + 2 * pad;
  const decals = stampEdgeDecals(new Int16Array(width * height), width, height,
    placed.x - pad, placed.y - pad, seed, { scenes: [sceneMaterialGrid(placed, source)], inset: pad });
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4, s = ((y + pad) * width + x + pad) * 4;
      if (source.data[i + 3] && decals[s + 3])
        writeRGBA(pixels, i, compositeTerrain(readRGBA(decals, s), readRGBA(pixels, i)));
    }
  }
}
