import { createCpuTerrain } from "./cpu-terrain-core";
import { restoreTileLayer } from "./tile-layer-cache";
import { WORLD_TOP, WORLD_HEIGHT } from "./terrain-policy";
import { GLTerrainRenderer } from "noita-telescope-full-pixels/gl/terrain_renderer.js";
import { initMaterialAtlas } from "noita-telescope-full-pixels/gl/material_atlas.js";
import { GENERATOR_CONFIG } from "noita-telescope-full-pixels/generator_config.js";
import { getWorldCenter, getWorldSize } from "noita-telescope-full-pixels/utils.js";

/** GPU cell resolution, with the identical complete scene/liquid/decal/static
 * composition used by the CPU bake. Every source pixel is rendered at 1:1;
 * the existing lossless pyramid/publication path is shared, not approximated.
 * CPU finishing remains explicit so benchmarks include its real cost. */
export async function openGpuBakeRenderer(snapshot: any) {
  await initMaterialAtlas();
  const main = snapshot.planes["0"];
  const renderer = new GLTerrainRenderer();
  const layers = main.tileLayers.map(restoreTileLayer);
  const ready = await renderer.ensureResources(layers, main.biomeData, {
    isNGP: main.isNGP, gameMode: main.gameMode, seed: snapshot.seed,
    generatorConfig: GENERATOR_CONFIG, engineTerrain: true,
    lut: { recolorMaterials: true, clearSpawnPixels: true },
  });
  if (!ready) throw new Error(renderer.failed || "GPU terrain initialization failed");
  const finishers = new Map<number, Awaited<ReturnType<typeof createCpuTerrain>>>();
  for (const plane of [0, -1, 1]) {
    const data = snapshot.planes[String(plane)];
    finishers.set(plane, await createCpuTerrain({
      ...data, sceneData: snapshot.sceneData,
      tileLayers: data.tileLayers.map(restoreTileLayer),
      elevatorShafts: data.elevatorShafts?.map(restoreTileLayer),
    }));
  }
  const width = getWorldSize(main.isNGP, main.gameMode) * 512;
  const center = getWorldCenter(main.isNGP, main.gameMode) * 512;
  let gpuMs = 0, finishingMs = 0, renderedPixels = 0;
  return {
    stats: () => ({ gpuMs, finishingMs, renderedPixels }),
    probeMaterial(x: number, y: number, plane = 0) {
      const pw = Math.floor((x + center) / width);
      const canvas = renderer.render({width:1,height:1,camX:x+.5+center-pw*width,
        camY:y+.5+7168-plane*WORLD_HEIGHT,camZ:1,pw,pwVertical:plane,
        edgeNoise:true,materialTextures:true,engineTerrain:true});
      renderer.gl.uniform1i(renderer.uniforms.u_materialIdOut, 1);
      renderer.gl.drawArrays(renderer.gl.TRIANGLES,0,3);
      const p=(canvas as any).__nativeGlesPixels;
      return {x,y,gpuMaterial:p[0]+(p[1]<<8)-1,cpuMaterial:finishers.get(plane)!.materialAt(x,y)};
    },
    render(x: number, y: number, w: number, h: number) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (const [plane, finisher] of finishers) {
        const top = Math.max(y, WORLD_TOP + plane * WORLD_HEIGHT);
        const bottom = Math.min(y + h, WORLD_TOP + (plane + 1) * WORLD_HEIGHT);
        if (top >= bottom || !finisher.contains(x, top, w, bottom - top)) continue;
        const pw = Math.floor((x + center) / width);
        const start = performance.now();
        const canvas = renderer.render({
          width: w, height: bottom - top,
          camX: x + w / 2 + center - pw * width,
          camY: top + (bottom - top) / 2 + 7168 - plane * WORLD_HEIGHT,
          camZ: 1, pw, pwVertical: plane, edgeNoise: true,
          materialTextures: true, engineTerrain: true,
        });
        const error = renderer.gl.getError();
        if (error) throw new Error(`GPU terrain draw failed: GLES 0x${error.toString(16)}`);
        const pixels: Uint8ClampedArray | undefined = (canvas as any)?.__nativeGlesPixels;
        if (!pixels || pixels.length !== w * (bottom - top) * 4)
          throw new Error("Missing native GPU readback; refusing to publish an empty tile");
        gpuMs += performance.now() - start;
        const finishStart = performance.now();
        finisher.finish(pixels, x, top, w, bottom - top);
        finishingMs += performance.now() - finishStart;
        renderedPixels += w * (bottom - top);
        out.set(pixels, (top - y) * w * 4);
      }
      return out;
    },
  };
}
