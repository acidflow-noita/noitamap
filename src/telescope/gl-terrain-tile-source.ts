import { terrainWorkerLimit } from "./terrain-worker-pool";
import { createTerrainFootprint } from "./terrain-footprint";
import type { TerrainSceneData } from "./terrain-scenes";
import {
  terrainTileKey,
  readTerrainTile,
  writeTerrainTile,
} from "./terrain-tile-store";
import { WORLD_HEIGHT, type VerticalPlane } from "./terrain-policy";
import { createTerrainRenderer } from "./terrain-context";
import { isGLTerrainEnabled } from "../renderer_settings";
import { PixelPyramid, type PyramidTile } from "./pixel-pyramid";
import { scheduleTerrainWork } from "./terrain-work-queue";

// Keep OSD's drawer independent: this renderer produces ordinary Canvas tiles.
declare const OpenSeadragon: any;
const TILE_SIZE = 512;
const WORLD_CENTER_Y = 14 * 512;

export interface GLTerrainDeps {
  GLTerrainRenderer: any;
  initMaterialAtlas: () => Promise<unknown>;
  getWorldCenter: (isNGP: boolean, gameMode?: string) => number;
  getWorldSize: (isNGP: boolean, gameMode?: string) => number;
  GENERATOR_CONFIG: any;
}
export interface GLTerrainGeneration {
  plane?: VerticalPlane;
  ngPlus?: number;
  elevatorShafts?: any[];
  sceneData?: TerrainSceneData;
  tileLayers: any[];
  biomeData: {
    pixels: Uint32Array;
    heavenPixels?: Uint32Array;
    hellPixels?: Uint32Array;
  };
  /** Original world map that owns the source buffers; differs from the material
   * lookup map in heaven/hell. Must survive worker/bake serialization. */
  sourceBiomeData?: {
    pixels: Uint32Array;
    heavenPixels?: Uint32Array;
    hellPixels?: Uint32Array;
  };
  isNGP: boolean;
  gameMode?: string;
  seed: number;
}
export interface GLTerrainSourceOpts {
  deps: GLTerrainDeps;
  gen: GLTerrainGeneration;
  pw: number;
  worldX: number;
  worldY: number;
  worldW: number;
  worldH: number;
  /** Temporary preview while exact pixels are generated, never cached as final. */
  preview?: HTMLCanvasElement | OffscreenCanvas;
  getFocus?: () => { x: number; y: number };
  onTileUpdate?: (tile: any) => void;
}

let renderer: any = null;
const planeRenderers = new Map<number, any>();
const presentations = new Map<number, any>();
let diagnosticSeed: number | undefined;
let diagnosticStage = "idle";
function sendLocalDiagnostic(
  event: string,
  extra: Record<string, unknown> = {},
): void {
  if (!import.meta.env.DEV || typeof location === "undefined") return;
  const capabilities: Record<string, unknown> = {};
  try {
    const gl = renderer?.gl;
    if (gl)
      for (const key of [
        "VERSION",
        "RENDERER",
        "MAX_TEXTURE_SIZE",
        "MAX_TEXTURE_IMAGE_UNITS",
      ]) {
        if (gl[key] !== undefined) capabilities[key] = gl.getParameter(gl[key]);
      }
  } catch {
    /* preserve the original failure */
  }
  void fetch("/__terrain-diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event,
      seed: diagnosticSeed,
      stage: diagnosticStage,
      pendingTiles,
      renderedLeaves,
      rendererReady: !!renderer?.ready,
      rendererFailure: renderer?.failed,
      contextLost: renderer?.contextLost,
      capabilities,
      userAgent: navigator.userAgent,
      ...extra,
    }),
  }).catch(() => {});
}
let generation = 0;
let sourceCounter = 0;
let failureReported = false;
let pendingTiles = 0;
let renderedLeaves = 0;
let lastProgressUpdate = 0;
function tileActivity(delta: number): void {
  pendingTiles += delta;
  window.dispatchEvent(
    new CustomEvent("fullPixelTerrainBusy", {
      detail: {
        busy: pendingTiles > 0,
        rendered: renderedLeaves,
        backend: renderer?.backend || "webgl",
      },
    }),
  );
}
const sources = new Set<AbortController>();

function reportFailure(error: unknown): void {
  console.warn("[Full-pixel terrain]", error);
  if (!failureReported) {
    failureReported = true;
    sendLocalDiagnostic("error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    window.dispatchEvent(
      new CustomEvent("fullPixelTerrainError", {
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
}

export async function ensureGLTerrain(
  deps: GLTerrainDeps,
  gen: GLTerrainGeneration,
): Promise<boolean> {
  if (!isGLTerrainEnabled() || !gen.tileLayers?.length || !gen.biomeData)
    return false;
  const current = generation;
  const plane = gen.plane ?? 0;
  renderer = planeRenderers.get(plane) ?? null;
  diagnosticSeed = gen.seed;
  diagnosticStage = "loading material atlas";
  sendLocalDiagnostic("initializing", { layers: gen.tileLayers.length });
  try {
    // Upstream starts this fetch without awaiting it. Tiles are cached, unlike
    // upstream's continuously redrawn viewport: the very first tile MUST have it.
    await deps.initMaterialAtlas();
    if (current !== generation) return false;
    diagnosticStage = "building GPU resources";
    if (!renderer && plane !== 0) {
      const { CpuTerrainRenderer } = await import("./cpu-terrain-client");
      renderer = new CpuTerrainRenderer();
    }
    renderer ??= createTerrainRenderer(deps.GLTerrainRenderer, (details) =>
      sendLocalDiagnostic(String(details.event), details),
    );
    const options = {
      plane,
      sourceBiomeData: gen.sourceBiomeData,
      sceneData: gen.sceneData,
      elevatorShafts: gen.elevatorShafts,
      isNGP: gen.isNGP,
      gameMode: gen.gameMode ?? "normal",
      lut: { recolorMaterials: true, clearSpawnPixels: true },
      engineTerrain: true,
      seed: gen.seed,
      generatorConfig: deps.GENERATOR_CONFIG,
    };
    let gpuFailure: unknown;
    try {
      const ok = await renderer.ensureResources(
        gen.tileLayers,
        gen.biomeData,
        options,
      );
      if (!ok)
        throw new Error(renderer.failed || "WebGL2 terrain is unavailable");
      const uploadError = renderer.gl?.getError?.();
      if (uploadError)
        throw new Error(
          `Terrain texture upload failed (WebGL 0x${uploadError.toString(16)})`,
        );
    } catch (error) {
      if (current !== generation) return false;
      if (renderer.backend === "cpu") throw error;
      gpuFailure = error;
    }
    if (gpuFailure) {
      const reason =
        gpuFailure instanceof Error ? gpuFailure.message : String(gpuFailure);
      console.warn(
        "[Full-pixel terrain] WebGL failed; switching to CPU worker:",
        reason,
      );
      sendLocalDiagnostic("cpu-fallback", { reason });
      renderer.invalidate();
      const { CpuTerrainRenderer } = await import("./cpu-terrain-client");
      if (current !== generation) return false;
      renderer = new CpuTerrainRenderer();
      diagnosticStage = "building CPU resources";
      await renderer.ensureResources(gen.tileLayers, gen.biomeData, options);
    }
    if (current !== generation) return false;
    window.dispatchEvent(
      new CustomEvent("fullPixelTerrainBackend", {
        detail: { backend: renderer.backend || "webgl" },
      }),
    );
    planeRenderers.set(plane, renderer);
    if (renderer.backend !== "cpu") {
      const { createTerrainPresentation } =
        await import("./terrain-presentation");
      if (!presentations.has(plane))
        presentations.set(plane, await createTerrainPresentation(gen, deps));
    }
    diagnosticStage = "ready";
    sendLocalDiagnostic("ready", {
      stats: renderer.stats,
      backend: renderer.backend || "webgl",
    });
    return true;
  } catch (error) {
    if (current === generation) reportFailure(error);
    return false;
  }
}

export function clearGLTerrain(): void {
  generation++;
  for (const controller of sources) controller.abort();
  sources.clear();
  for (const value of planeRenderers.values()) value.invalidate();
  if (renderer && ![...planeRenderers.values()].includes(renderer))
    renderer.invalidate();
  planeRenderers.clear();
  for (const present of presentations.values()) present.dispose?.();
  presentations.clear();
  renderer = null;
  failureReported = false;
  renderedLeaves = 0;
  window.dispatchEvent(new Event("fullPixelTerrainReset"));
}

export function glCoversVerticalPlane(plane: number): boolean {
  return !!planeRenderers.get(plane)?.rendersWorld(plane);
}

/** Camera inverse of upstream render(). Avoid adding the parallel-world offset
 * twice: noitamap's worldX already includes it; upstream adds view.pw itself.
 * Sample actual game coordinates; upstream handles legacy raster offsets itself.
 */
export function terrainCamera(opts: GLTerrainSourceOpts, tile: PyramidTile) {
  const wx = opts.worldX + tile.x * TILE_SIZE;
  const wy = opts.worldY + tile.y * TILE_SIZE;
  // generateBiomeData() returns pixels/planes, NOT w/h. Cached generations
  // happen to add w, which hid this bug on warm loads. Use the same world
  // size function as GLTerrainRenderer.render(), on both cold and warm paths.
  const mapWidth = opts.deps.getWorldSize(opts.gen.isNGP, opts.gen.gameMode);
  if (![wx, wy, mapWidth, opts.pw].every(Number.isFinite) || mapWidth <= 0) {
    throw new Error("Invalid world coordinates for full-pixel terrain");
  }
  return {
    width: tile.width,
    height: tile.height,
    camX:
      wx +
      tile.width / 2 +
      512 * opts.deps.getWorldCenter(opts.gen.isNGP, opts.gen.gameMode) -
      opts.pw * 512 * mapWidth,
    camY: wy + tile.height / 2 + WORLD_CENTER_Y,
    camZ: 1,
    pw: opts.pw,
    pwVertical: 0,
    edgeNoise: true,
    materialTextures: true,
    engineTerrain: true,
  };
}

/** Progressive, mutable context2d tiles. OSD gets a usable preview immediately;
 * real 1:1 leaves replace it and propagate through the pyramid as they arrive. */
export function createGLTerrainTileSource(opts: GLTerrainSourceOpts): any {
  const lifetime = new AbortController();
  sources.add(lifetime);
  const activeRenderer = planeRenderers.get(opts.gen.plane ?? 0) ?? renderer;
  const present = presentations.get(opts.gen.plane ?? 0);
  const active = new Map<
    string,
    {
      canvas: HTMLCanvasElement;
      promise: Promise<HTMLCanvasElement>;
      controller: AbortController;
      publishPreview?: () => void;
    }
  >();
  const leafJobs = new Map<string, Promise<HTMLCanvasElement>>();
  const keyOf = (t: { level: number; x: number; y: number }) =>
    `${t.level}/${t.x}/${t.y}`;
  const maxLevel = Math.ceil(Math.log2(Math.max(opts.worldW, opts.worldH)));
  const reducedCache = new WeakMap<
    HTMLCanvasElement,
    Map<number, HTMLCanvasElement>
  >();
  const reduceCached = (
    image: HTMLCanvasElement,
    levels: number,
  ): HTMLCanvasElement => {
    if (levels <= 0 || (image.width === 1 && image.height === 1)) return image;
    let variants = reducedCache.get(image);
    if (!variants) {
      variants = new Map();
      reducedCache.set(image, variants);
    }
    const existing = variants.get(levels);
    if (existing) return existing;
    const previous = reduceCached(image, levels - 1);
    if (previous.width === 1 && previous.height === 1) return previous;
    const out = document.createElement("canvas");
    out.width = Math.ceil(previous.width / 2);
    out.height = Math.ceil(previous.height / 2);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(previous, 0, 0, previous.width / 2, previous.height / 2);
    variants.set(levels, out);
    return out;
  };
  const create = (tile: PyramidTile) => {
    const existing = active.get(keyOf(tile));
    if (existing) return existing.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = tile.width;
    canvas.height = tile.height;
    if (opts.preview) {
      const scale = 2 ** (maxLevel - tile.level);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        opts.preview,
        (tile.x * TILE_SIZE * scale) / 10,
        (tile.y * TILE_SIZE * scale) / 10,
        (tile.width * scale) / 10,
        (tile.height * scale) / 10,
        0,
        0,
        tile.width,
        tile.height,
      );
    }
    // A zoom change must not replace already-computed detail with the preview.
    // Seed the new level with exact cached descendants, reduced in 2:1 steps.
    const scale = 2 ** (maxLevel - tile.level);
    const left = tile.x * TILE_SIZE * scale,
      top = tile.y * TILE_SIZE * scale;
    for (const cached of pyramid.cachedTiles()) {
      if (cached.tile.level < tile.level) continue;
      const childScale = 2 ** (maxLevel - cached.tile.level);
      const dx = (cached.tile.x * TILE_SIZE * childScale - left) / scale;
      const dy = (cached.tile.y * TILE_SIZE * childScale - top) / scale;
      const w = (cached.image.width * childScale) / scale,
        h = (cached.image.height * childScale) / scale;
      if (
        dx >= canvas.width ||
        dy >= canvas.height ||
        dx + w <= 0 ||
        dy + h <= 0
      )
        continue;
      const ctx = canvas.getContext("2d")!;
      const reduced = reduceCached(
        cached.image,
        cached.tile.level - tile.level,
      );
      ctx.clearRect(dx, dy, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(reduced, 0, 0, reduced.width, reduced.height, dx, dy, w, h);
    }
    return canvas;
  };
  const persistentKey = (tile: PyramidTile) =>
    terrainTileKey(
      opts.gen.seed,
      `${opts.gen.isNGP}/${opts.gen.gameMode || "normal"}`,
      opts.gen.plane ?? 0,
      opts.pw,
      `${opts.worldX},${opts.worldY},${opts.worldW},${opts.worldH}`,
      tile.level,
      tile.x,
      tile.y,
    );
  const hasContent = createTerrainFootprint(
    opts.gen,
    opts.deps.GENERATOR_CONFIG,
    opts.deps.getWorldSize(opts.gen.isNGP, opts.gen.gameMode),
  );
  const pyramid = new PixelPyramid<HTMLCanvasElement>({
    leafConcurrency: terrainWorkerLimit(),
    createEmpty: (tile) => {
      const canvas = document.createElement("canvas");
      canvas.width = tile.width;
      canvas.height = tile.height;
      return canvas;
    },
    isEmpty: (tile) => {
      const scale = 2 ** (maxLevel - tile.level);
      return !hasContent(
        opts.worldX + tile.x * TILE_SIZE * scale,
        opts.worldY + tile.y * TILE_SIZE * scale,
        tile.width * scale,
        tile.height * scale,
      );
    },
    readTile: (tile) => readTerrainTile(persistentKey(tile)),
    onMissing: (tile) => active.get(keyOf(tile))?.publishPreview?.(),
    writeTile: (tile, image) => writeTerrainTile(persistentKey(tile), image),
    width: Math.ceil(opts.worldW),
    height: Math.ceil(opts.worldH),
    tileSize: TILE_SIZE,
    focus: () => {
      const focus = opts.getFocus?.() ?? {
        x: opts.worldX + opts.worldW / 2,
        y: opts.worldY + opts.worldH / 2,
      };
      return { x: focus.x - opts.worldX, y: focus.y - opts.worldY };
    },
    create,
    async renderLeaf(tile, signal) {
      const key = keyOf(tile);
      let pending = leafJobs.get(key);
      if (!pending) {
        const priority = () => {
          const focus = opts.getFocus?.();
          if (!focus) return 0;
          const dx = opts.worldX + (tile.x + 0.5) * TILE_SIZE - focus.x;
          const dy = opts.worldY + (tile.y + 0.5) * TILE_SIZE - focus.y;
          return dx * dx + dy * dy;
        };
        const finishPixels = async (image: HTMLCanvasElement) => {
          lifetime.signal.throwIfAborted();
          if (!image) throw new Error("Full-pixel terrain context was lost");
          const out = create(tile),
            ctx = out.getContext("2d")!;
          ctx.clearRect(0, 0, out.width, out.height);
          ctx.imageSmoothingEnabled = false;
          if (present)
            await present(
              ctx,
              image,
              opts.worldX + tile.x * TILE_SIZE,
              opts.worldY + tile.y * TILE_SIZE,
              tile.width,
              tile.height,
              lifetime.signal,
              priority,
            );
          else ctx.drawImage(image, 0, 0);
          lifetime.signal.throwIfAborted();
          renderedLeaves++;
          if (performance.now() - lastProgressUpdate > 100) {
            lastProgressUpdate = performance.now();
            tileActivity(0);
          }
          return out;
        };
        pending = scheduleTerrainWork(
          () => {
            diagnosticStage = `rendering tile ${tile.level}/${tile.x}/${tile.y}`;
            const view = terrainCamera(opts, tile);
            if (activeRenderer.backend === "cpu") {
              return activeRenderer
                .render(view, lifetime.signal, priority)
                .then(finishPixels);
            }
            // Copy synchronous GL output before any other job reuses its canvas.
            const image = activeRenderer.render(view);
            const drawError = activeRenderer.gl?.getError?.();
            if (drawError)
              throw new Error(
                `Terrain draw failed (WebGL 0x${drawError.toString(16)})`,
              );
            return finishPixels(image);
          },
          lifetime.signal,
          priority,
        );

        leafJobs.set(key, pending);
        void pending.finally(() => leafJobs.delete(key)).catch(() => {});
      }
      const image = await pending;
      signal.throwIfAborted();
      return image;
    },
    reduceChild(parent, child, x, y) {
      const ctx = parent.getContext("2d")!;
      const dx = (x * TILE_SIZE) / 2,
        dy = (y * TILE_SIZE) / 2;
      ctx.clearRect(
        dx,
        dy,
        Math.ceil(child.width / 2),
        Math.ceil(child.height / 2),
      );
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(child, dx, dy, child.width / 2, child.height / 2);
    },
  });
  lifetime.signal.addEventListener("abort", () => pyramid.clear(), {
    once: true,
  });
  const source = new OpenSeadragon.TileSource({
    width: Math.ceil(opts.worldW),
    height: Math.ceil(opts.worldH),
    tileSize: TILE_SIZE,
    minLevel: 0,
    maxLevel: pyramid.maxLevel,
  });
  const id = ++sourceCounter;
  source.__glTerrain = true;
  source.getTileUrl = (level: number, x: number, y: number) =>
    `gl-terrain://${id}/${level}/${x}/${y}`;
  source.hasTransparency = () => true;
  // Also useful for verification: first paint and completed full-pixel data are
  // intentionally different milestones, no preview is presented as completed.
  source.waitForTile = (level: number, x: number, y: number) =>
    active.get(`${level}/${x}/${y}`)?.promise ??
    pyramid.get(level, x, y, lifetime.signal);

  source.downloadTileStart = (context: any) => {
    const tile = context.tile,
      key = keyOf(tile);
    const shape = pyramid.tile(tile.level, tile.x, tile.y);
    if (!shape) {
      context.fail("Invalid terrain tile");
      return;
    }
    const controller = new AbortController();
    let delivered = false,
      complete = false,
      countedWork = false;
    let redrawTimer: ReturnType<typeof setTimeout> | undefined;
    const canvas = create(shape);
    // OSD may destroy a context2d cache by resizing its canvas to zero. Keep
    // its mutable display separate from the pyramid's retained pixel data.
    const display = document.createElement("canvas");
    display.width = shape.width;
    display.height = shape.height;
    const displayContext = display.getContext("2d")!;
    displayContext.drawImage(canvas, 0, 0);
    const redraw = () => {
      if (redrawTimer !== undefined || lifetime.signal.aborted) return;
      redrawTimer = setTimeout(() => {
        redrawTimer = undefined;
        if (!lifetime.signal.aborted) opts.onTileUpdate?.(tile);
      }, 50);
    };
    const deliver = () => {
      if (delivered || controller.signal.aborted) return;
      delivered = true;
      // A context2d cache stays live in OSD's CanvasDrawer. Finishing an "image"
      // would let it cache a frozen conversion of the unfinished canvas.
      context.finish(displayContext, null, "context2d");
    };
    const settle = () => {
      if (complete) return;
      complete = true;
      lifetime.signal.removeEventListener("abort", cancel);
      if (active.get(key)?.controller === controller) active.delete(key);
      if (countedWork) tileActivity(-1);
    };
    const cancel = () => {
      controller.abort();
      if (!delivered) {
        delivered = true;
        context.fail("Terrain generation cancelled");
      }
      if (redrawTimer !== undefined) clearTimeout(redrawTimer);
      settle();
    };
    context.userData = {
      abort() {
        delivered = true;
        cancel();
      },
    };
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    clearTimeout(context.jobId);
    context.jobId = -1;
    if (lifetime.signal.aborted) {
      cancel();
      return;
    }
    const record = {
      canvas,
      controller,
      promise: null as unknown as Promise<HTMLCanvasElement>,
      publishPreview: () => {
        if (!countedWork) {
          countedWork = true;
          tileActivity(1);
        }
        if (opts.preview) queueMicrotask(deliver);
      },
    };
    active.set(key, record);
    // Publish a preview only after a persistent cache miss, never over a
    // completed tile. Otherwise zooming flashed old coarse cloud colors.
    record.promise = pyramid
      .get(tile.level, tile.x, tile.y, controller.signal, (image) => {
        if (controller.signal.aborted) return;
        if (image !== canvas) {
          const ctx = canvas.getContext("2d")!;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0);
        }
        if (!display.width || !display.height) {
          cancel();
          return;
        }
        displayContext.clearRect(0, 0, display.width, display.height);
        displayContext.drawImage(canvas, 0, 0);
        queueMicrotask(deliver);
        redraw();
      })
      .then(
        (image) => {
          settle();
          redraw();
          return image;
        },
        (error) => {
          if (!controller.signal.aborted) {
            reportFailure(error);
            if (!delivered) {
              delivered = true;
              context.fail(String(error));
            }
          }
          settle();
          throw error;
        },
      );
    // OSD already has its live tile; failures are reported through the status UI.
    void record.promise.catch(() => {});
  };
  source.downloadTileAbort = (context: any) => context.userData?.abort();
  return source;
}
