import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import {
  prewarmInstantTerrain,
  prepareInstantTerrain,
} from "../../src/telescope/instant-terrain-backend";
import { setTerrainPlane } from "../../src/telescope/instant-terrain-plane";
import { WORLD_HEIGHT, WORLD_TOP } from '../../src/telescope/terrain-policy';
import type { TerrainViewportPlan } from '../../src/telescope/terrain-viewport-compositor';

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
  const viewport = await verifyViewportRPC(renderer, getWorldSize(gen.isNGP), getWorldCenter(gen.isNGP));
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
    viewport,
  };
}

async function verifyViewportRPC(renderer: any, width: number, center: number) {
  const worldWidth = width * 512;
  const inputs = {
    owners: Array.from({ length: 3 }, () => ({ width, owners: new Int16Array(width * 48) })),
    masks: [], center,
  };
  await renderer.configureViewport(inputs);
  const pixels = (canvas: any) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let comparedBytes = 0, mismatches = 0, visible = 0;
  const compare = (actual: Uint8ClampedArray, expected: Uint8ClampedArray) => {
    if (actual.length !== expected.length) throw new Error('Viewport reference dimensions differ');
    for (let p = 0; p < actual.length; p++) {
      comparedBytes++;
      if (actual[p] !== expected[p]) mismatches++;
    }
    for (let p = 3; p < actual.length; p += 4) if (actual[p]) visible++;
  };
  const tile = async (plan: TerrainViewportPlan, pw: number, plane: -1 | 0 | 1) => {
    renderer.setPlane(plane);
    // Independent reference uses Telescope's original PW-local camera plus
    // explicit pw, whereas the new frame path uses an absolute camera/pw=0.
    return renderer.render({ width: plan.pixelWidth, height: plan.pixelHeight,
      camX: plan.x - pw * worldWidth + plan.width / 2 + center * 512,
      camY: plan.y + plan.height / 2 + 7168, camZ: 1 / plan.scale,
      pw, pwVertical: 0, engineTerrain: true, edgeNoise: true, materialTextures: true });
  };
  for (const plane of [-1, 0, 1] as const) for (const pw of [-1, 0, 1]) {
    // Native cooking now uses this compositor RPC too. Verify whole 512px
    // chunk samples in every plane/PW against the explicit-plane shader path.
    const plan = { x: -4096 + pw * worldWidth, y: plane * WORLD_HEIGHT,
      width: 512, height: 512, scale: 1, pixelWidth: 512, pixelHeight: 512 };
    const actual = await renderer.renderViewport(plan), expected = await tile(plan, pw, plane);
    compare(pixels(actual), pixels(expected));
    actual.close(); expected.close();
  }

  // One frame simultaneously covers all nine regions. The independent
  // reference stitches nine explicit PW/plane renders at exact screen edges.
  const plan = { x: -1.5 * worldWidth, y: WORLD_TOP - WORLD_HEIGHT,
    width: 3 * worldWidth, height: 3 * WORLD_HEIGHT, scale: 256,
    pixelWidth: 3 * worldWidth / 256, pixelHeight: 3 * WORLD_HEIGHT / 256 };
  const reference = document.createElement('canvas');
  reference.width = plan.pixelWidth; reference.height = plan.pixelHeight;
  const context = reference.getContext('2d')!;
  for (const plane of [-1, 0, 1] as const) for (const pw of [-1, 0, 1]) {
    const cell = { x: (pw - 0.5) * worldWidth, y: WORLD_TOP + plane * WORLD_HEIGHT,
      width: worldWidth, height: WORLD_HEIGHT, scale: 256,
      pixelWidth: worldWidth / 256, pixelHeight: WORLD_HEIGHT / 256 };
    const bitmap = await tile(cell, pw, plane);
    context.drawImage(bitmap, (pw + 1) * cell.pixelWidth, (plane + 1) * cell.pixelHeight);
    bitmap.close();
  }
  const actual = await renderer.renderViewport(plan);
  compare(pixels(actual), pixels(reference)); actual.close();
  reference.width = reference.height = 0;

  // Reconfiguration must reach the real worker and preserve explicit force-air
  // ownership even when material bits are empty.
  const maskPlan = { x: -4032 - worldWidth, y: 64, width: 128, height: 128,
    scale: 1, pixelWidth: 128, pixelHeight: 128 };
  const mask = { x: maskPlan.x + 16, y: maskPlan.y + 16, width: 32, height: 32,
    bits: new Uint8Array(128), airBits: new Uint8Array(128).fill(255) };
  await renderer.configureViewport({ ...inputs, masks: [mask] });
  const masked = await renderer.renderViewport(maskPlan), unmasked = await tile(maskPlan, -1, 0);
  const cleared = unmasked.getContext('2d').getImageData(16, 16, 32, 32).data;
  let forceAirOpaquePixelsCleared = 0;
  for (let p = 3; p < cleared.length; p += 4) if (cleared[p]) forceAirOpaquePixelsCleared++;
  unmasked.getContext('2d').clearRect(16, 16, 32, 32);
  compare(pixels(masked), pixels(unmasked)); masked.close(); unmasked.close();
  await renderer.configureViewport(inputs);

  // Include synchronous draw, readback, transfer and the receiving canvas.
  // This harness deliberately uses llvmpipe, not physical GPU/browser timings.
  const hd = { x: -6000, y: 0, width: 1920, height: 1080, scale: 1, pixelWidth: 1920, pixelHeight: 1080 };
  const warm = await renderer.renderViewport(hd); warm.close();
  const frameMs: number[] = [], tilesMs: number[] = [];
  const count = () => ({ ...(globalThis as any).__terrainWorkerMessages });
  const before = count();
  for (let repeat = 0; repeat < 2; repeat++) {
    let started = performance.now();
    const frame = await renderer.renderViewport(hd); frame.close();
    frameMs.push(performance.now() - started);
    started = performance.now();
    for (let y = 0; y < hd.pixelHeight; y += 512) for (let x = 0; x < hd.pixelWidth; x += 512) {
      const w = Math.min(512, hd.pixelWidth - x), h = Math.min(512, hd.pixelHeight - y);
      const bitmap = await tile({ ...hd, x: hd.x + x, y: hd.y + y, width: w, height: h, pixelWidth: w, pixelHeight: h }, 0, 0);
      bitmap.close();
    }
    tilesMs.push(performance.now() - started);
  }
  const after = count();
  return { comparedBytes, mismatches, visible, regions: 9, nativeBlockPixels: 9 * 512 * 512, fullWorldFrames: 1,
    forceAirMaskVerified: true, forceAirOpaquePixelsCleared, measuredFrameRequests: after.frame - before.frame,
    measuredTileRequests: after.render - before.render, warm1080pFrameTransferMs: frameMs,
    warm1080pTwelveTileTransfersMs: tilesMs,
    timingScope: 'Native llvmpipe software GLES, includes readback/transfer; excludes generation and does not measure browser or physical GPU speed' };
}
