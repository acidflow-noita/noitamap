import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { serializeTileLayer } from "../../src/telescope/tile-layer-cache";

/** Real generation + real shader. No browser and no game executable required. */
export async function verifyGpuMaterials() {
  setFullPixelTerrainForBake(true);
  const gen = await generateDynamicMap({ seed: 786433191, ngPlus: 0, parallelWorlds: [0], unlocks: null });
  const planes: Record<string, any> = {};
  for (const plane of [0, -1, 1] as const) {
    const p = await prepareTerrainPlane(gen, plane);
    planes[String(plane)] = { ...p, seed:gen.seed,
      tileLayers:p.tileLayers.map(serializeTileLayer),
      elevatorShafts:p.elevatorShafts?.map(serializeTileLayer) };
  }
  const { openGpuBakeRenderer } = await import("../../src/telescope/gpu-bake-renderer");
  const renderer = await openGpuBakeRenderer({ seed:gen.seed, planes });
  // These coordinates selected gold/copper/air with the wrong GLSL constants.
  return [[24,526],[78,515],[52,516],[36247,1000]].map(([x,y])=>renderer.probeMaterial(x,y));
}
