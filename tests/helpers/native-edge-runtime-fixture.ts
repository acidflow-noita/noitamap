import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { createCpuTerrain } from "../../src/telescope/cpu-terrain-core";
// @ts-expect-error Test-only Vite query selects the independent JS stamper.
import { createCpuTerrain as createReference } from "../../src/telescope/cpu-terrain-core?edge-reference";
import {
  currentNativeEdges,
  readyNativeEdges,
} from "../../src/native-map/edges";
import type { GLTerrainGeneration } from "../../src/telescope/gl-terrain-tile-source";

export async function verifyNativeEdges(failModule: boolean) {
  setFullPixelTerrainForBake(true);
  if (!failModule) {
    let ready = null;
    for (let i = 0; i < 20 && !ready; i++) ready = await readyNativeEdges();
    if (!ready) throw new Error("Native edge module did not initialize");
  }
  const generation = await generateDynamicMap({
    seed: 11033,
    ngPlus: 0,
    parallelWorlds: [-1, 0, 1],
    unlocks: null,
  });
  (globalThis as any).OpenSeadragon = (await import("openseadragon")).default;
  const { prepareTerrainSceneData } =
    await import("../../src/telescope/telescope-osd-bridge");
  const sceneData = await prepareTerrainSceneData(generation);
  const samples = [];
  for (const plane of [0, -1, 1] as const) {
    const input: GLTerrainGeneration = {
      ...(await prepareTerrainPlane(generation, plane)),
      sceneData,
    };
    const reference: Awaited<ReturnType<typeof createCpuTerrain>> =
      await createReference(input);
    const native = await createCpuTerrain(input);
    const areas = [-1, 0, 1].map((pw) => ({
      x: (plane === 0 ? -32 : -4032) + pw * 35840,
      y: plane === 0 ? 480 : plane * 24576 + 64,
      width: 512,
      height: 512,
      pw,
    }));
    if (plane === 0) {
      for (const scene of sceneData.scenes
        .filter((s) => s.x < 0 && s.y > 0 && s.y < 15000)
        .slice(0, 2))
        areas.push({
          x: Math.floor(scene.x) - 32,
          y: Math.floor(scene.y) - 32,
          width: 131,
          height: 129,
          pw: -1,
        });
    }
    for (const area of areas) {
      const { x, y, width, height } = area;
      if (!native.contains(x, y, width, height))
        throw new Error("Empty test rectangle");
      const output = [];
      for (const terrain of [reference, native]) {
        const pixels = new Uint8ClampedArray(width * height * 4);
        terrain.prefillMaterials(x, y, width, height);
        // Exercise the worker's partial-row convention as well as full tiles.
        for (let row = 0; row < height; row += 16)
          terrain.renderRows(
            x,
            y,
            width,
            row,
            Math.min(row + 16, height),
            pixels,
          );
        terrain.finish(pixels, x, y, width, height);
        output.push(pixels);
      }
      let mismatchedBytes = 0;
      for (let i = 0; i < output[0].length; i++)
        mismatchedBytes += Number(output[0][i] !== output[1][i]);
      samples.push({
        plane,
        ...area,
        comparedBytes: output[0].byteLength,
        mismatchedBytes,
      });
    }
  }
  const edge = currentNativeEdges();
  return {
    samples,
    edge: edge
      ? {
          enabled: edge.enabled,
          stats: edge.stats,
          timing: edge.timing,
          memoryBytes: edge.memoryBytes,
        }
      : null,
  };
}
