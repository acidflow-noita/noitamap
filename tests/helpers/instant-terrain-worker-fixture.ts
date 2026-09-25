import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import {
  prewarmInstantTerrain,
  prepareInstantTerrain,
} from "../../src/telescope/instant-terrain-backend";
import { setTerrainPlane } from "../../src/telescope/instant-terrain-plane";

/** Run the actual shipped worker in native threads. The harness translates only
 * ImageBitmap transport to a transferred RGBA buffer; shader/resources are real. */
export async function verifyInstantTerrainWorker() {
  setFullPixelTerrainForBake(true);
  const started = performance.now();
  prewarmInstantTerrain();
  const gen = await generateDynamicMap({
    seed: 786433191,
    ngPlus: 0,
    parallelWorlds: [0],
    unlocks: null,
  });
  const generatedMs = performance.now() - started;
  const [
    { GLTerrainRenderer },
    { initMaterialAtlas },
    { GENERATOR_CONFIG },
    { getWorldSize, getWorldCenter },
  ] = await Promise.all([
    import("noita-telescope-full-pixels/gl/terrain_renderer.js"),
    import("noita-telescope-full-pixels/gl/material_atlas.js"),
    import("noita-telescope-full-pixels/generator_config.js"),
    import("noita-telescope-full-pixels/utils.js"),
  ]);
  const deps = {
    GLTerrainRenderer,
    initMaterialAtlas,
    GENERATOR_CONFIG,
    getWorldSize,
    getWorldCenter,
  };
  const [standalone, original] = await Promise.all([
    import("virtual:instant-terrain-shaders"),
    import("noita-telescope-full-pixels/gl/shaders.js"),
  ]);
  if (
    standalone.TERRAIN_FS !== original.TERRAIN_FS ||
    standalone.TERRAIN_VS !== original.TERRAIN_VS
  )
    throw new Error(
      "Standalone prewarm shader differs from the actual renderer shader",
    );
  const gaps: number[] = [];
  let previous = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - previous);
    previous = now;
  }, 5);
  const renderer = await prepareInstantTerrain(gen, deps);
  if (renderer.backend !== "worker")
    throw new Error("Native worker path fell back to main context");
  const resourceReadyMs = performance.now() - started;
  const cases = [
    { x: -64, y: 512, scale: 1, pw: 0 },
    { x: -1024, y: 4096, scale: 8, pw: 0 },
    { x: 35840, y: 512, scale: 1, pw: 1 },
  ];
  const images: Uint8ClampedArray[] = [];
  let firstTileMs = 0;
  const views = cases.map(({ x, y, scale, pw }) => ({
    width: 128,
    height: 128,
    camX: x + 64 * scale + 17920 - pw * 35840,
    camY: y + 64 * scale + 7168,
    camZ: 1 / scale,
    pw,
    pwVertical: 0,
    engineTerrain: true,
    edgeNoise: true,
    materialTextures: true,
  }));
  for (const view of views) {
    setTerrainPlane(renderer, 0);
    const bitmap = await renderer.render(view);
    if (!firstTileMs) firstTileMs = performance.now() - started;
    images.push(bitmap.getContext("2d").getImageData(0, 0, 128, 128).data);
    bitmap.close();
  }
  clearInterval(heartbeat);
  const firstTilesMs = performance.now() - started;
  await initMaterialAtlas();
  const reference = new GLTerrainRenderer();
  if (
    !reference.ensureResources(gen.tileLayers, gen.biomeData, {
      isNGP: false,
      seed: gen.seed,
      engineTerrain: true,
      generatorConfig: GENERATOR_CONFIG,
      lut: { recolorMaterials: true, clearSpawnPixels: true },
    })
  )
    throw new Error(reference.failed);
  let comparedBytes = 0,
    mismatches = 0,
    visible = 0;
  for (let i = 0; i < views.length; i++) {
    setTerrainPlane(reference, 0);
    const canvas = reference.render(views[i]);
    const pixels = canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
    for (let p = 0; p < pixels.length; p++) {
      comparedBytes++;
      if (pixels[p] !== images[i][p]) mismatches++;
    }
    for (let p = 3; p < pixels.length; p += 4) if (pixels[p]) visible++;
  }
  renderer.invalidate();
  reference.invalidate();
  return {
    backend: renderer.backend,
    standaloneShaderIdentical: true,
    generatedMs,
    resourceReadyMs,
    firstTileMs,
    firstTilesMs,
    shaderWarmupMs: renderer.shaderWarmupMs,
    resourceMs: renderer.resourceMs,
    mainThreadHeartbeats: gaps.length,
    mainThreadMaxGapMs: Math.max(0, ...gaps),
    comparedBytes,
    mismatches,
    visible,
  };
}
