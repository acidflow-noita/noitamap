import { setFullPixelTerrainForBake } from "../src/renderer_settings";
import { generateDynamicMap } from "../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../src/telescope/terrain-planes";
import { serializeTileLayer } from "../src/telescope/tile-layer-cache";

interface NativeHarness {
  seed: number;
  iterations: number;
  worlds?: number[];
  finish(): void;
  mode(value: "viewport" | "tiles"): void;
  draws(): number;
  fingerprint(value: unknown): string;
  progress(value: string): void;
  read(width: number, height: number): Uint8Array;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values,
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
  };
}
function imageStats(pixels: Uint8Array | Uint8ClampedArray) {
  let visible = 0,
    hash = 2166136261;
  const colors = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]) visible++;
    colors.add(
      pixels[i] |
        (pixels[i + 1] << 8) |
        (pixels[i + 2] << 16) |
        (pixels[i + 3] << 24),
    );
    for (let c = 0; c < 4; c++)
      hash = Math.imul(hash ^ pixels[i + c], 16777619);
  }
  return { visible, colors: colors.size, hash: hash >>> 0 };
}

export async function benchmarkInstantTerrain(native: NativeHarness) {
  const started = performance.now();
  setFullPixelTerrainForBake(true);
  native.progress("Generating the real seed and loading source assets");
  const gen = await generateDynamicMap({
    seed: native.seed,
    ngPlus: 0,
    parallelWorlds: native.worlds ?? [0],
    unlocks: null,
  });
  const generated = performance.now();
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
  await initMaterialAtlas();
  const atlasReady = performance.now();
  const renderer = new GLTerrainRenderer();
  const ready = renderer.ensureResources(gen.tileLayers, gen.biomeData, {
    isNGP: gen.isNGP,
    gameMode: gen.gameMode,
    seed: gen.seed,
    generatorConfig: GENERATOR_CONFIG,
    engineTerrain: true,
    lut: { recolorMaterials: true, clearSpawnPixels: true },
  });
  if (!ready) throw new Error(renderer.failed || "GPU resources failed");
  native.finish();
  const resourcesReady = performance.now();
  const center = getWorldCenter(gen.isNGP, gen.gameMode) * 512;
  const worldWidth = getWorldSize(gen.isNGP, gen.gameMode) * 512;
  const cases = [
    {
      name: "lod-overview-tile",
      width: 512,
      height: 512,
      x: 0,
      y: 5120,
      zoom: 1 / 64,
    },
    {
      name: "lod-mines-detail-tile",
      width: 512,
      height: 512,
      x: 0,
      y: 896,
      zoom: 1,
    },
    {
      name: "main-world-overview",
      width: 1024,
      height: 768,
      x: 0,
      y: 5120,
      zoom: 1024 / worldWidth,
    },
    { name: "mines-detail", width: 1024, height: 768, x: 0, y: 896, zoom: 1 },
    { name: "mines-close-up", width: 1024, height: 768, x: 0, y: 896, zoom: 4 },
    {
      name: "main-world-overview-1080p",
      width: 1920,
      height: 1080,
      x: 0,
      y: 5120,
      zoom: 1920 / worldWidth,
    },
  ];
  const viewports = [];
  let firstDrawMs = 0;
  for (const sample of cases) {
    native.progress(`Measuring ${sample.name}`);
    const view = {
      width: sample.width,
      height: sample.height,
      camX: sample.x + center,
      camY: sample.y + 7168,
      camZ: sample.zoom,
      pw: 0,
      pwVertical: 0,
      edgeNoise: true,
      materialTextures: true,
      engineTerrain: true,
    };
    let before = performance.now();
    renderer.render(view);
    native.finish();
    const coldDrawMs = performance.now() - before;
    if (!viewports.length) firstDrawMs = coldDrawMs;
    const values = [],
      drawStart = native.draws();
    for (let i = 0; i < native.iterations; i++) {
      before = performance.now();
      // Pan each frame to prevent a cached image from masquerading as a draw.
      renderer.render({ ...view, camX: view.camX + i * 7 });
      native.finish();
      values.push(performance.now() - before);
    }
    const pixels = native.read(sample.width, sample.height);
    const image = imageStats(pixels);
    if (image.visible < 1000 || image.colors < 2)
      throw new Error(`Blank or flat shader output: ${sample.name}`);
    if (native.draws() - drawStart !== native.iterations)
      throw new Error("Viewport is not one draw per frame");
    const sourceWidth = sample.width / sample.zoom,
      sourceHeight = sample.height / sample.zoom;
    // Power-of-two LOD camera validation: independently draw chosen world
    // pixels at 1:1 and compare them with the corresponding overview texels.
    // This catches camera scale/origin mistakes without claiming game parity.
    let coordinateProbes = 0;
    if (sample.name.startsWith("lod-")) {
      for (const [px, py] of [
        [0, 0],
        [127, 191],
        [255, 255],
        [384, 383],
        [511, 511],
      ]) {
        const worldX =
          sample.x +
          (native.iterations - 1) * 7 -
          sourceWidth / 2 +
          (px + 0.5) / sample.zoom;
        const worldY = sample.y - sourceHeight / 2 + (py + 0.5) / sample.zoom;
        renderer.render({
          ...view,
          width: 1,
          height: 1,
          camX: worldX + center,
          camY: worldY + 7168,
          camZ: 1,
        });
        native.finish();
        const probe = native.read(1, 1);
        const index = ((sample.height - 1 - py) * sample.width + px) * 4;
        if (probe.some((value, channel) => value !== pixels[index + channel]))
          throw new Error(
            `LOD coordinate mismatch at ${sample.name} pixel ${px},${py}`,
          );
        coordinateProbes++;
      }
    }
    viewports.push({
      ...sample,
      sourceWidth,
      sourceHeight,
      screenPixels: sample.width * sample.height,
      sourcePixels: sourceWidth * sourceHeight,
      fullResolutionTileGrid:
        Math.ceil(sourceWidth / 512) * Math.ceil(sourceHeight / 512),
      note: "Tile grid is geometric coverage, not measured bake work; transparent-footprint pruning can reduce it.",
      coldDrawMs,
      completedDraw: distribution(values),
      draws: native.iterations,
      coordinateProbes,
      image,
    });
  }
  native.progress(
    "Preparing the existing GPU tile bake and CPU finishing workload",
  );
  const legacyStarted = performance.now();
  const planes: Record<string, any> = {};
  for (const plane of [0, -1, 1] as const) {
    const data = await prepareTerrainPlane(gen, plane);
    planes[String(plane)] = {
      ...data,
      tileLayers: data.tileLayers.map(serializeTileLayer),
      elevatorShafts: data.elevatorShafts?.map(serializeTileLayer),
    };
  }
  (globalThis as any).OpenSeadragon = (await import("openseadragon")).default;
  const { prepareTerrainSceneData } =
    await import("../src/telescope/telescope-osd-bridge");
  const sceneData = await prepareTerrainSceneData(gen);
  const { openGpuBakeRenderer } =
    await import("../src/telescope/gpu-bake-renderer");
  native.mode("tiles");
  const legacy = await openGpuBakeRenderer({
    seed: gen.seed,
    planes,
    sceneData,
  });
  native.finish();
  const legacyPrepared = performance.now();
  const tileSamples = [];
  for (const [name, x, y] of [
    ["mines-left", -512, 512],
    ["mines-center", 0, 512],
    ["mines-far-left", -1024, 512],
    ["mines-right", 512, 512],
  ] as const) {
    const before = performance.now(),
      stats = legacy.stats();
    const pixels = legacy.render(x, y, 512, 512);
    native.finish();
    const elapsedMs = performance.now() - before,
      after = legacy.stats();
    const image = imageStats(pixels);
    if (after.renderedPixels === stats.renderedPixels)
      throw new Error(`Legacy tile was skipped: ${name}`);
    tileSamples.push({
      name,
      x,
      y,
      width: 512,
      height: 512,
      elapsedMs,
      gpuReadbackMs: after.gpuMs - stats.gpuMs,
      cpuFinishingMs: after.finishingMs - stats.finishingMs,
      image,
    });
  }
  native.progress("Measuring another seed with source assets already loaded");
  const nextSeed = (native.seed + 1) >>> 0,
    warmGenerationStarted = performance.now();
  const warmGen = await generateDynamicMap({
    seed: nextSeed,
    ngPlus: 0,
    parallelWorlds: native.worlds ?? [0],
    unlocks: null,
  });
  const warmGenerationMs = performance.now() - warmGenerationStarted;
  if (warmGen.seed !== nextSeed)
    throw new Error("Warm seed generation returned stale data");
  const fingerprint = (generation: typeof gen) =>
    native.fingerprint({
      seed: generation.seed,
      biomeData: generation.biomeData,
      layers: generation.tileLayers.map(serializeTileLayer),
      elevatorShafts: generation.elevatorShafts?.map(serializeTileLayer),
      pois: generation.poisByPW,
      scenes: Object.fromEntries(
        Object.entries(generation.pixelScenesByPW).map(([world, scenes]) => [
          world,
          scenes.map(({ key, name, variantKey, x, y, width, height }) => ({
            key,
            name,
            variantKey,
            x,
            y,
            width,
            height,
          })),
        ]),
      ),
    });
  return {
    seed: native.seed,
    worlds: native.worlds ?? [0],
    generationFingerprints: {
      cold: fingerprint(gen),
      subsequent: fingerprint(warmGen),
    },
    scope:
      "Seed generation includes the requested worlds; terrain shader samples the main world. Viewport excludes scenes/decals, UI composition, network download, browser, and display latency. Legacy includes existing scene/liquid/edge/static CPU finishing. No claim of pixel parity or full-map bake speedup.",
    timingPolicy:
      "Viewport uses real GLSL draw plus glFinish; no readPixels in measured frames. Legacy includes native readback/flip/canvas transfer plus CPU finish. Validation readback is outside viewport timings.",
    startup: {
      initialization: performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("noitamap.telescope.init."))
        .map((entry) => ({
          name: entry.name.slice("noitamap.telescope.init.".length),
          durationMs: entry.duration,
        })),
      generationAndSourceAssetsMs: generated - started,
      rendererModuleAndMaterialAtlasMs: atlasReady - generated,
      resourceBuildUploadAndCompileMs: resourcesReady - atlasReady,
      firstCompletedDrawMs: firstDrawMs,
      firstTerrainMs: resourcesReady - started + firstDrawMs,
      subsequentSeedGeneration: { seed: nextSeed, elapsedMs: warmGenerationMs },
    },
    resources: renderer.stats,
    viewports,
    legacy: {
      preparationMs: legacyPrepared - legacyStarted,
      samples: tileSamples,
      totalMeasuredTileMs: tileSamples.reduce(
        (sum, tile) => sum + tile.elapsedMs,
        0,
      ),
    },
  };
}
