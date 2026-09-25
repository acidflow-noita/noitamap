import type {
  GLTerrainDeps,
  GLTerrainGeneration,
} from "./gl-terrain-tile-source";
import type { VerticalPlane } from "./terrain-policy";
import { prepareTerrainPlane } from "./terrain-planes";
import { serializeTileLayer } from "./tile-layer-cache";
import { scheduleTerrainWork } from "./terrain-work-queue";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  cancelled: boolean;
};

export const INSTANT_RENDER_TIMEOUT_MS = 10_000;

/** The worker owns its context across seeds. It transfers only finished tiles,
 * leaving 50+ MB lattices, uploads, compilation and GPU waits off the UI thread. */
export class InstantTerrainWorkerClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private id = 0;
  failed: unknown = null;
  constructor(
    worker = new Worker(
      new URL("./instant-terrain-worker.ts", import.meta.url),
      { type: "module" },
    ),
    private timeoutMs = 30_000,
    private renderTimeoutMs = Math.min(timeoutMs, INSTANT_RENDER_TIMEOUT_MS),
  ) {
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) {
        data.bitmap?.close();
        return;
      }
      this.pending.delete(data.id);
      entry.cleanup();
      if (entry.cancelled) data.bitmap?.close();
      else if (data.error)
        entry.reject(
          data.errorName === "AbortError"
            ? new DOMException(data.error, "AbortError")
            : new Error(data.error),
        );
      else entry.resolve(data);
    };
    worker.onerror = (event) =>
      this.dispose(new Error(event.message || "Terrain worker failed"));
    worker.onmessageerror = () =>
      this.dispose(new Error("Terrain worker response could not be read"));
  }
  request(
    type: string,
    payload: any = {},
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const entry = this.pending.get(id);
        if (!entry || entry.cancelled) return;
        entry.cancelled = true;
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new Error("Terrain request cancelled"));
        // Cancelling the caller cannot cancel a synchronous GPU draw already
        // running in the worker. Keep its watchdog until the worker responds:
        // otherwise repeated camera/OSD aborts hide a hung context forever.
        try { this.worker.postMessage({ type: "cancel", id }); }
        catch (error) { this.dispose(error); }
      };
      const timeout = setTimeout(
        () => this.dispose(new Error(`Terrain worker ${type} timed out`)),
        type === "render" ? this.renderTimeoutMs : this.timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup, cancelled: false });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  dispose(error: unknown = new Error("Terrain worker stopped")) {
    if (this.failed) return;
    this.failed = error;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
  }
}

interface Slot {
  released?: boolean;
  worker?: InstantTerrainWorkerClient;
  main?: any;
  warm?: Promise<void>;
  token: number;
  layers?: any[];
  biomes?: object;
  seed?: number;
  key?: string;
  prepared?: Promise<any>;
}
const slots = new Map<VerticalPlane, Slot>();
let nextToken = 0;
const fallbackSignal = new AbortController().signal;

function getSlot(plane: VerticalPlane): Slot {
  let slot = slots.get(plane);
  if (!slot) {
    slot = { token: 0 };
    slots.set(plane, slot);
  }
  return slot;
}

async function warmSlot(slot: Slot, deps?: GLTerrainDeps): Promise<void> {
  if (slot.warm) return slot.warm;
  return (slot.warm = (async () => {
    if (
      !slot.main &&
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined"
    ) {
      try {
        slot.worker = new InstantTerrainWorkerClient();
        await slot.worker.request("prewarm");
        return;
      } catch (error) {
        slot.worker?.dispose(error);
        slot.worker = undefined;
        if (slot.released)
          throw new DOMException("Terrain backend released", "AbortError");
        console.warn(
          "[Instant terrain] Worker unavailable; using the main WebGL context:",
          error,
        );
      }
    }
    if (!deps) {
      const [
        { getDataZip },
        { installTelescopeShim },
        { installFetchInterceptor },
      ] = await Promise.all([
        import("../data-archive"),
        import("./telescope-dom-shim"),
        import("./telescope-data-bridge"),
      ]);
      if (slot.released)
        throw new DOMException("Terrain backend released", "AbortError");
      installTelescopeShim();
      installFetchInterceptor(true);
      if (!(await getDataZip()))
        throw new Error("Terrain archive unavailable for main-context prewarm");
    }
    const [
      { GLTerrainRenderer },
      { initMaterialAtlas },
      { prewarmTerrainShader },
    ] = await Promise.all([
      deps
        ? Promise.resolve(deps)
        : import("noita-telescope-full-pixels/gl/terrain_renderer.js"),
      deps
        ? Promise.resolve(deps)
        : import("noita-telescope-full-pixels/gl/material_atlas.js"),
      import("./terrain-shader-prewarm"),
    ]);
    if (slot.released)
      throw new DOMException("Terrain backend released", "AbortError");
    slot.main ??= new GLTerrainRenderer();
    await Promise.all([initMaterialAtlas(), prewarmTerrainShader(slot.main)]);
  })().catch((error) => {
    slot.warm = undefined;
    throw error;
  }));
}

/** Called as soon as instant generation is selected, before seed assets load. */
export function prewarmInstantTerrain(): void {
  void warmSlot(getSlot(0)).catch((error) => {
    if (error?.name !== "AbortError")
      console.warn("[Instant terrain] Prewarm unavailable:", error);
  });
}

/** Release persistent worker contexts when leaving dynamic maps, including a
 * prewarm which started before any seed finished. Normal reseeds keep them. */
export function releaseInstantTerrainBackend(): void {
  for (const slot of slots.values()) {
    slot.released = true;
    slot.token = ++nextToken;
    slot.worker?.dispose(
      new DOMException("Terrain backend released", "AbortError"),
    );
    slot.main?.invalidate();
    if (slot.main?.program) slot.main.gl.deleteProgram(slot.main.program);
    slot.main?.gl?.getExtension?.("WEBGL_lose_context")?.loseContext();
  }
  slots.clear();
}

/** Safe for the early terrain-only callback and the completed report object:
 * source buffer identity coalesces them, while stale handles cannot invalidate
 * a newer seed. Other vertical planes remain lazy. */
export async function prepareInstantTerrain(
  gen: GLTerrainGeneration,
  deps: GLTerrainDeps,
  plane: VerticalPlane = 0,
  signal?: AbortSignal,
): Promise<any> {
  signal?.throwIfAborted();
  const slot = getSlot(plane);
  const key = `${gen.isNGP}:${gen.gameMode ?? "normal"}`;
  if (
    slot.layers === gen.tileLayers &&
    slot.biomes === gen.biomeData &&
    slot.seed === gen.seed &&
    slot.key === key &&
    slot.prepared
  )
    return slot.prepared;
  const token = ++nextToken;
  slot.token = token;
  slot.layers = gen.tileLayers;
  slot.biomes = gen.biomeData;
  slot.seed = gen.seed;
  slot.key = key;
  const current = () => {
    signal?.throwIfAborted();
    if (slot.token !== token)
      throw new DOMException("Obsolete terrain generation", "AbortError");
  };
  const ready = (async () => {
    const [prepared] = await Promise.all([
      prepareTerrainPlane(gen, plane),
      warmSlot(slot, deps),
    ]);
    current();
    if (slot.worker) {
      const worker = slot.worker;
      const layers = prepared.tileLayers.map(serializeTileLayer);
      const transfer = layers
        .map((layer) => layer.buffer)
        .filter((buffer): buffer is ArrayBuffer => buffer !== null);
      try {
        const stats = await worker.request(
          "init",
          {
            token,
            generation: {
              seed: gen.seed,
              isNGP: gen.isNGP,
              gameMode: gen.gameMode,
              tileLayers: layers,
              biomeData: prepared.biomeData,
            },
          },
          undefined,
          transfer,
        );
        current();
        let selectedPlane = plane;
        return {
          backend: "worker",
          ...stats,
          setPlane(value: VerticalPlane) {
            selectedPlane = value;
          },
          async render(view: any, signal?: AbortSignal) {
            current();
            const result = await worker.request(
              "render",
              { token, plane: selectedPlane, view },
              signal,
            );
            if (slot.token !== token) {
              result.bitmap.close();
              current();
            }
            return result.bitmap;
          },
          invalidate() {
            if (slot.token !== token) return;
            slot.token = ++nextToken;
            slot.prepared = undefined;
            void worker.request("invalidate", { token }).catch(() => {});
          },
        };
      } catch (error) {
        current();
        worker.dispose(error);
        slot.worker = undefined;
        slot.warm = undefined;
        // A worker may expose OffscreenCanvas without a working WebGL2 backend.
        // Retry once on the regular canvas, which retains existing fallback behavior.
        const [{ prewarmTerrainShader }] = await Promise.all([
          import("./terrain-shader-prewarm"),
          deps.initMaterialAtlas(),
        ]);
        slot.main ??= new deps.GLTerrainRenderer();
        await prewarmTerrainShader(slot.main);
        slot.warm = Promise.resolve();
        console.warn(
          "[Instant terrain] Worker initialization failed; using the main WebGL context:",
          error,
        );
      }
    }
    current();
    const renderer = slot.main;
    return scheduleTerrainWork(
      () => {
        current();
        const started = performance.now();
        const ok = renderer.ensureResources(
          prepared.tileLayers,
          prepared.biomeData,
          {
            isNGP: gen.isNGP,
            gameMode: gen.gameMode ?? "normal",
            seed: gen.seed,
            lut: { recolorMaterials: true, clearSpawnPixels: true },
            engineTerrain: true,
            generatorConfig: deps.GENERATOR_CONFIG,
          },
        );
        if (!ok || !renderer.engineReady || renderer.gl?.getError?.())
          throw new Error(
            renderer.failed || "WebGL2 terrain resources unavailable",
          );
        // The proxy belongs to this generation; disposing an old map must never
        // delete the same context's newly prepared resources.
        return {
          backend: "main",
          gl: renderer.gl,
          program: renderer.program,
          resourceMs: performance.now() - started,
          shaderWarmupMs: renderer.shaderWarmupMs,
          render(view: any) {
            current();
            return renderer.render(view);
          },
          invalidate() {
            if (slot.token !== token) return;
            slot.token = ++nextToken;
            slot.prepared = undefined;
            renderer.invalidate();
          },
        };
      },
      fallbackSignal,
      () => 0,
    );
  })();
  slot.prepared = ready;
  try {
    return await ready;
  } catch (error) {
    if (slot.token === token) slot.prepared = undefined;
    throw error;
  }
}
