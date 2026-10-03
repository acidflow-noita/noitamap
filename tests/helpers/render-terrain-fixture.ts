import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import {
  loadTerrainBackgrounds,
  textureColor,
} from "../../src/telescope/terrain-backgrounds";
import OpenSeadragon from "openseadragon";
import {
  serializeTileLayer,
  restoreTileLayer,
} from "../../src/telescope/tile-layer-cache";
import { generateFixture } from "./generate-worker-fixture";
import {
  ensureGLTerrain,
  createGLTerrainTileSource,
  clearGLTerrain,
} from "../../src/telescope/gl-terrain-tile-source";

/** Real shader + real OSD ImageJob: assert pixels, not just successful imports. */
export async function renderTerrainFixture(seed: number, cached = false) {
  setFullPixelTerrainForBake(true);
  (globalThis as any).OpenSeadragon = OpenSeadragon;
  const generated = await generateFixture(true, seed, true);
  const { terrain, materialAtlas, utils, images } =
    await import("./full-pixel-terrain-exports");
  const layers = cached
    ? generated.tileLayers!.map((layer: any) =>
        restoreTileLayer(serializeTileLayer(layer)),
      )
    : generated.tileLayers!;
  const originalFills = generated.tileLayers!.filter(
    (layer: any) => layer.isFill,
  ).length;
  if (layers.filter((layer: any) => layer.isFill).length !== originalFills)
    throw new Error("Cached generation lost fill-biome metadata");
  const probeLayer = layers.find(
    (l: any) => l.biomeName.startsWith("coalmine") && l.validChunks?.size,
  );
  const probeChunks = [...probeLayer.validChunks] as string[];
  const [probeCX, probeCY] = probeChunks[Math.floor(probeChunks.length / 2)]
    .split(",")
    .map(Number);
  const probeX = (probeCX - 35) * 512 + 128,
    probeY = (probeCY - 14) * 512 + 128;
  const probeBackground = (
    await loadTerrainBackgrounds([probeLayer.biomeName])
  ).get(probeLayer.biomeName)!;
  const air = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < air.length; i += 4) {
    air[i + 2] = 66;
    air[i + 3] = 255;
  }
  const gen = {
    tileLayers: layers,
    biomeData: cached
      ? { ...generated.biomeData, w: 70, h: 48 }
      : generated.biomeData,
    seed,
    isNGP: false,
    gameMode: "normal",
    sceneData: {
      sources: { "general/the_end_shop": { data: air, width: 4, height: 4 } },
      scenes: [
        {
          key: "general/the_end_shop",
          name: "the_end_shop",
          variantKey: "biome=the_sky",
          x: probeX,
          y: probeY,
          width: 4,
          height: 4,
        },
      ],
    },
  };
  let shaderDraws = 0;
  const deps = {
    GLTerrainRenderer: class extends terrain.GLTerrainRenderer {
      render(view: any) {
        shaderDraws++;
        return super.render(view);
      }
    },
    initMaterialAtlas: materialAtlas.initMaterialAtlas,
    GENERATOR_CONFIG: generated.generatorConfig,
    getWorldCenter: utils.getWorldCenter,
    getWorldSize: utils.getWorldSize,
  };
  let error = "";
  window.addEventListener("fullPixelTerrainError", ((e: CustomEvent) => {
    error = e.detail?.message || "unknown terrain failure";
  }) as EventListener);
  if (!(await ensureGLTerrain(deps, gen)))
    throw new Error(`Actual terrain initialization failed: ${error}`);

  const result = [];
  let firstPaint:
    { previewMs: number; refinedMs: number; shaderDraws: number } | undefined;
  if (!cached) {
    const overlays = images.createTileOverlaysCheap(
      gen.biomeData,
      gen.tileLayers,
      0,
      0,
      false,
      "normal",
    );
    const preview = document.createElement("canvas");
    preview.width = Math.ceil(35840 / 10);
    preview.height = Math.ceil(24576 / 10);
    const previewCtx = preview.getContext("2d")!;
    for (let i = 0; i < overlays.length; i++)
      if (overlays[i]) {
        previewCtx.drawImage(
          overlays[i],
          gen.tileLayers[i].correctedX / 10,
          gen.tileLayers[i].correctedY / 10,
        );
      }
    const layer = gen.tileLayers.find(
      (l: any) => l.biomeName.startsWith("coalmine") && l.validChunks?.size,
    );
    const chunks = [...layer.validChunks] as string[];
    const [cx, cy] = chunks[Math.floor(chunks.length / 2)]
      .split(",")
      .map(Number);
    const focus = { x: (cx - 35) * 512 + 256, y: (cy - 14) * 512 + 256 };
    let updates = 0;
    const world = createGLTerrainTileSource({
      deps,
      gen,
      pw: 0,
      worldX: -17920,
      worldY: -7168,
      worldW: 35840,
      worldH: 24576,
      preview,
      getFocus: () => focus,
      onTileUpdate: () => updates++,
    });
    const request = (level: number, x: number, y: number): Promise<any> =>
      new Promise((resolve, reject) => {
        const Job = OpenSeadragon.ImageJob as any;
        new Job({
          source: world,
          tile: { level, x, y },
          src: world.getTileUrl(level, x, y),
          callback: (job: any) =>
            job.errorMsg ? reject(new Error(job.errorMsg)) : resolve(job.data),
        }).start();
      });
    const coarseLevel = world.maxLevel - 6; // realistic overview tile: 32768 x 24576 game pixels
    const start = performance.now();
    const context = await request(coarseLevel, 0, 0);
    if (!context.canvas)
      throw new Error(
        "OSD must receive live context2d data, not a frozen image conversion",
      );
    const hash = () => {
      const bytes = context.getImageData(
        0,
        0,
        context.canvas.width,
        context.canvas.height,
      ).data;
      let h = 2166136261,
        visible = 0;
      for (let i = 0; i < bytes.length; i++) {
        h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
        if (i % 4 === 3 && bytes[i]) visible++;
      }
      return { hash: h, visible };
    };
    const initial = hash();
    const previewMs = performance.now() - start;
    if (initial.visible < 1000)
      throw new Error("Whole-world overview first paint is blank");
    if (shaderDraws !== 0)
      throw new Error("Overview first paint waited for GPU world generation");
    let completedWholeWorld = false;
    void world.waitForTile(coarseLevel, 0, 0).then(
      () => {
        completedWholeWorld = true;
      },
      () => {},
    );
    const detail = await request(world.maxLevel, cx, cy);
    await world.waitForTile(world.maxLevel, cx, cy);
    const detailData = detail.getImageData(
      0,
      0,
      detail.canvas.width,
      detail.canvas.height,
    ).data;
    if (!detailData.some((v: number, i: number) => i % 4 === 3 && v > 0))
      throw new Error("Close-up was starved behind world generation");
    await new Promise((resolve) => setTimeout(resolve, 70));
    if (hash().hash === initial.hash)
      throw new Error(
        "Published OSD overview did not receive refined GPU pixels",
      );
    if (!updates)
      throw new Error("Visible OSD tiles were not notified of updated pixels");
    if (completedWholeWorld || shaderDraws >= 50)
      throw new Error("First terrain waited for bulk whole-world work");
    console.log(
      `[World-sized first paint] seed=${seed}: visible immediately; GPU-refined and close-up ready after ${shaderDraws} draws, ${Math.round(performance.now() - start)}ms`,
    );
    firstPaint = {
      previewMs,
      refinedMs: performance.now() - start,
      shaderDraws,
    };
    clearGLTerrain();
    // Let cancellation drain before rebuilding the shared renderer for snapshots.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!(await ensureGLTerrain(deps, gen)))
      throw new Error("Could not restart terrain after cancelled overview");
    shaderDraws = 0;
  }

  try {
    for (const biomeName of ["coalmine", "snowcave"]) {
      const layer = gen.tileLayers.find(
        (l: any) => l.biomeName.startsWith(biomeName) && l.validChunks?.size,
      );
      if (!layer) throw new Error(`No generated ${biomeName} layer`);
      const chunks = [...layer.validChunks] as string[];
      const [cx, cy] = chunks[Math.floor(chunks.length / 2)]
        .split(",")
        .map(Number);
      // A conspicuous preview must disappear completely, including fractional
      // right/bottom mip pixels. Cached/no-preview output is our comparison.
      const testPreview = document.createElement("canvas");
      testPreview.width = 103;
      testPreview.height = 103;
      testPreview.getContext("2d")!.fillStyle = "#ff00ff";
      testPreview.getContext("2d")!.fillRect(0, 0, 103, 103);
      for (const pw of [0, -1, 1]) {
        const source = createGLTerrainTileSource({
          deps,
          gen,
          pw,
          worldX:
            (cx -
              utils.getWorldCenter(false) +
              pw * utils.getWorldSize(false)) *
            512,
          worldY: (cy - 14) * 512,
          worldW: 1023,
          worldH: 1021,
          preview: cached ? undefined : testPreview,
        });
        for (const level of [source.maxLevel, source.maxLevel - 1]) {
          const canvas: any = await new Promise((resolve, reject) => {
            // OSD's published types omit this runtime/internal start() API
            // and the job argument passed to its completion callback.
            const ImageJob = OpenSeadragon.ImageJob as unknown as new (
              options: Record<string, unknown>,
            ) => { start(): void };
            const job = new ImageJob({
              tile: { level, x: 0, y: 0 },
              source,
              src: source.getTileUrl(level, 0, 0),
              callback: (done: any) =>
                done.errorMsg
                  ? reject(new Error(done.errorMsg))
                  : resolve(done.data.canvas || done.data),
            });
            job.start();
          });
          await source.waitForTile(level, 0, 0);
          const rgba = canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data;
          if (
            biomeName === "coalmine" &&
            pw === 0 &&
            level === source.maxLevel
          ) {
            const p = (128 * canvas.width + 128) * 4;
            const expected = textureColor(
              probeBackground,
              probeX + 17920,
              probeY + 7168,
            );
            const actual =
              ((rgba[p + 3] << 24) |
                (rgba[p] << 16) |
                (rgba[p + 1] << 8) |
                rgba[p + 2]) >>>
              0;
            if (actual !== expected)
              throw new Error(
                `Scene FORCE AIR did not reveal the native background: ${actual.toString(16)} != ${expected.toString(16)}`,
              );
          }
          let visible = 0;
          const colors = new Set<number>();
          for (let i = 0; i < rgba.length; i += 4)
            if (rgba[i + 3]) {
              visible++;
              colors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
            }
          if (!visible)
            throw new Error(
              `BLANK terrain: seed=${seed}, ${biomeName}, PW=${pw}, level=${level}, biomeData.w=${gen.biomeData.w}`,
            );
          let hash = 2166136261;
          for (const value of rgba)
            hash = Math.imul(hash ^ value, 16777619) >>> 0;
          result.push({
            seed,
            cached,
            firstPaint,
            biomeName,
            pw,
            level,
            visible,
            colors: colors.size,
            width: canvas.width,
            height: canvas.height,
            hash,
            png:
              pw === 0 && level === source.maxLevel
                ? new Uint8Array(canvas.toBuffer("image/png"))
                : undefined,
          });
          if (pw === 0 && level === source.maxLevel) {
            // OSD destroys context2d cache canvases this way on unload. Its
            // ownership must not erase the pyramid's retained final pixels.
            canvas.width = 0;
            const again: any = await new Promise((resolve, reject) => {
              const Job = OpenSeadragon.ImageJob as any;
              new Job({
                source,
                tile: { level, x: 0, y: 0 },
                src: source.getTileUrl(level, 0, 0),
                callback: (job: any) =>
                  job.errorMsg
                    ? reject(new Error(job.errorMsg))
                    : resolve(job.data.canvas),
              }).start();
            });
            await source.waitForTile(level, 0, 0);
            const restored = again
              .getContext("2d")
              .getImageData(0, 0, again.width, again.height).data;
            let restoredHash = 2166136261;
            for (const value of restored)
              restoredHash = Math.imul(restoredHash ^ value, 16777619) >>> 0;
            if (restoredHash !== hash)
              throw new Error(
                "OSD cache unload destroyed final terrain pixels",
              );
          }
        }
      }
    }
    // The elevator is a lower-plane exception: exercise the actual CPU worker
    // serialization and OSD tiles, even when the main-plane backend was GPU.
    const lower = await prepareTerrainPlane(gen, 1);
    if (lower.elevatorShafts?.length !== 1)
      throw new Error("NG0 elevator continuation was not prepared");
    if (!(await ensureGLTerrain(deps, lower)))
      throw new Error("Elevator worker initialization failed");
    const shaftBackground = (await loadTerrainBackgrounds(["robobase"])).get(
      "robobase",
    )!;
    for (const row of [0, 23, 47]) {
      const x = lower.elevatorShafts[0].minX * 512 - 17920,
        y = 17408 + row * 512;
      const source = createGLTerrainTileSource({
        deps,
        gen: lower,
        pw: 0,
        worldX: x,
        worldY: y,
        worldW: 512,
        worldH: 512,
      });
      const canvas: any = await new Promise((resolve, reject) => {
        const Job = OpenSeadragon.ImageJob as any;
        new Job({
          source,
          tile: { level: source.maxLevel, x: 0, y: 0 },
          src: source.getTileUrl(source.maxLevel, 0, 0),
          callback: (job: any) =>
            job.errorMsg
              ? reject(new Error(job.errorMsg))
              : resolve(job.data.canvas || job.data),
        }).start();
      });
      await source.waitForTile(source.maxLevel, 0, 0);
      const pixels = canvas.getContext("2d").getImageData(0, 0, 512, 512).data;
      let terrainPixels = 0;
      for (let py = 0; py < 512; py++)
        for (let px = 0; px < 512; px++) {
          const i = (py * 512 + px) * 4;
          const rgba =
            ((pixels[i + 3] << 24) |
              (pixels[i] << 16) |
              (pixels[i + 1] << 8) |
              pixels[i + 2]) >>>
            0;
          const bg = textureColor(
            shaftBackground,
            x + px + 17920,
            y + py - 17408,
          );
          if (rgba !== bg && pixels[i + 3]) terrainPixels++;
        }
      if (terrainPixels < 1024)
        throw new Error(
          `Elevator row ${row} is background-only: ${terrainPixels} terrain pixels`,
        );
    }
  } finally {
    clearGLTerrain();
  }
  return result;
}

/** A/B same actual CPU renderer with one vs multiple workers. Runs in separate
 * native worker environments, so navigator supplies the test's hardware limit.
 * Generation is outside the measured batches; cold includes extra-worker setup,
 * warm measures steady-state tiles. Hashes must agree at both parallelisms. */
export async function renderTerrainPoolFixture(seed: number) {
  setFullPixelTerrainForBake(true);
  const { CpuTerrainRenderer, liveTerrainWorkerStats } =
    await import("../../src/telescope/cpu-terrain-client");
  const generated = await generateFixture(true, seed, true);
  const renderer = new CpuTerrainRenderer();
  await renderer.ensureResources(generated.tileLayers!, generated.biomeData, {
    seed,
    isNGP: false,
    gameMode: "normal",
    plane: 0,
  });
  const samples: { x: number; y: number }[] = [];
  for (const name of ["coalmine", "excavationsite", "snowcave", "rainforest"]) {
    const layer = generated.tileLayers!.find(
      (l: any) => l.biomeName === name && l.validChunks?.size >= 3,
    );
    if (!layer) throw new Error(`Missing benchmark biome ${name}`);
    for (const key of [...layer.validChunks].slice(0, 3)) {
      const [cx, cy] = String(key).split(",").map(Number);
      samples.push({ x: cx * 512 - 17920, y: cy * 512 - 7168 });
    }
  }
  const batch = async () => {
    const start = performance.now();
    const hashes = await Promise.all(
      samples.map(async ({ x, y }) => {
        const canvas = await renderer.render(
          {
            camX: x + 17920 + 256,
            camY: y + 7168 + 256,
            pw: 0,
            width: 512,
            height: 512,
          },
          new AbortController().signal,
          () => 0,
        );
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, 512, 512).data;
        let hash = 2166136261;
        for (const byte of pixels)
          hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        return hash;
      }),
    );
    return { ms: performance.now() - start, hashes };
  };
  try {
    const cold = await batch(),
      warm = await batch();
    return {
      cold,
      warm,
      pool: liveTerrainWorkerStats(),
      tiles: samples.length,
    };
  } finally {
    renderer.invalidate();
  }
}
