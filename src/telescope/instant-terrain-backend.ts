import type {
  GLTerrainDeps,
  GLTerrainGeneration,
} from "./gl-terrain-tile-source";
import type { VerticalPlane } from "./terrain-policy";
import { prepareTerrainPlane } from "./terrain-planes";
import { prepareElevatorShafts } from "./terrain-elevator";
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
        try {
          this.worker.postMessage({ type: "cancel", id });
        } catch (error) {
          this.dispose(error);
        }
      };
      const timeout = setTimeout(
        () => this.dispose(new Error(`Terrain worker ${type} timed out`)),
        type === "render" || type === "frame" ? this.renderTimeoutMs : this.timeoutMs,
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
  resources?: any;
  warm?: Promise<void>;
  workerWarm?: Promise<boolean>;
  token: number;
  layers?: any[];
  biomes?: object;
  seed?: number;
  key?: string;
  prepared?: Promise<any>;
  preparing?: Set<{ signal?: AbortSignal }>;
  handles: Map<VerticalPlane, Promise<any>>;
}
let sharedSlot: Slot | undefined;
let nextToken = 0;
const fallbackSignal = new AbortController().signal;

function getSlot(): Slot {
  return (sharedSlot ??= { token: 0, handles: new Map() });
}

/** This path never imports renderer assets or falls back to a UI-thread GL context. */
function warmWorker(slot: Slot): Promise<boolean> {
  if (slot.main || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
    return Promise.resolve(false);
  return slot.workerWarm ??= (async () => {
    slot.worker = new InstantTerrainWorkerClient();
    await slot.worker.request("prewarm");
    if (slot.released) throw new DOMException("Terrain backend released", "AbortError");
    return true;
  })().catch(error => {
    slot.worker?.dispose(error);
    slot.worker = undefined;
    slot.workerWarm = undefined;
    throw error;
  });
}

async function warmSlot(slot: Slot, deps?: GLTerrainDeps): Promise<void> {
  if (slot.warm) return slot.warm;
  return (slot.warm = (async () => {
    try {
      if (await warmWorker(slot)) return;
    } catch (error) {
      if (slot.released) throw new DOMException("Terrain backend released", "AbortError");
      console.warn("[Instant terrain] Worker unavailable; using the main WebGL context:", error);
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
export function prewarmInstantTerrain(options: { workerOnly?: boolean } = {}): Promise<boolean> {
  if (options.workerOnly) return warmWorker(getSlot()).catch(() => false);
  return warmSlot(getSlot()).then(() => true).catch((error) => {
    if (error?.name !== "AbortError")
      console.warn("[Instant terrain] Prewarm unavailable:", error);
    return false;
  });
}

/** Release persistent worker contexts when leaving dynamic maps, including a
 * prewarm which started before any seed finished. Normal reseeds keep them. */
export function releaseInstantTerrainBackend(): void {
  const slot = sharedSlot;
  if (slot) {
    slot.released = true;
    slot.token = ++nextToken;
    slot.worker?.dispose(
      new DOMException("Terrain backend released", "AbortError"),
    );
    if (slot.resources) slot.resources.invalidate();
    else slot.main?.invalidate();
    if (slot.main?.program) slot.main.gl.deleteProgram(slot.main.program);
    slot.main?.gl?.getExtension?.("WEBGL_lose_context")?.loseContext();
  }
  sharedSlot = undefined;
}

/** Early preparation and every plane share one source build. Facades retain
 * their own selected plane; render RPCs carry that value before any await. */
export async function prepareInstantTerrain(
  gen: GLTerrainGeneration,
  deps: GLTerrainDeps,
  plane: VerticalPlane = 0,
  signal?: AbortSignal,
): Promise<any> {
  signal?.throwIfAborted();
  if (plane !== -1 && plane !== 0 && plane !== 1)
    throw new Error("Invalid terrain plane");
  const slot = getSlot();
  const key = `${gen.isNGP}:${gen.gameMode ?? "normal"}`;
  if (
    slot.layers !== gen.tileLayers ||
    slot.biomes !== gen.biomeData ||
    slot.seed !== gen.seed ||
    slot.key !== key ||
    !slot.prepared
  ) {
    const token = ++nextToken;
    slot.token = token;
    slot.layers = gen.tileLayers;
    slot.biomes = gen.biomeData;
    slot.seed = gen.seed;
    slot.key = key;
    slot.handles.clear();
    const preparing = (slot.preparing = new Set<{ signal?: AbortSignal }>());
    const current = () => {
      if (slot.released || slot.token !== token)
        throw new DOMException("Obsolete terrain generation", "AbortError");
      // Preparation is shared, but its callers have independent lifetimes.
      // A cancelled map must not upload after an asset wait; one cancelled
      // caller must also not stop a sibling or signal-less early preparation.
      if (![...preparing].some((caller) => !caller.signal?.aborted))
        throw new DOMException("Terrain preparation cancelled", "AbortError");
    };
    slot.prepared = (async () => {
      const [prepared, elevatorShafts] = await Promise.all([
        prepareTerrainPlane(gen, 0),
        prepareElevatorShafts(gen),
        warmSlot(slot, deps),
      ]);
      current();
      if (slot.worker) {
        const worker = slot.worker;
        const layers = prepared.tileLayers.map(serializeTileLayer);
        const shafts = elevatorShafts.map(serializeTileLayer);
        const transfer = [...layers, ...shafts]
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
                elevatorShafts: shafts,
                biomeData: prepared.biomeData,
              },
            },
            undefined,
            transfer,
          );
          current();
          return { backend: "worker", worker, ...stats };
        } catch (error) {
          // A superseded init must never retire the shared worker now preparing
          // a newer seed, nor create a main context after navigation disposed it.
          current();
          worker.dispose(error);
          slot.worker = undefined;
          slot.workerWarm = undefined;
          slot.warm = undefined;
          const [{ prewarmTerrainShader }] = await Promise.all([
            import("./terrain-shader-prewarm"),
            deps.initMaterialAtlas(),
          ]);
          current();
          slot.main ??= new deps.GLTerrainRenderer();
          await prewarmTerrainShader(slot.main);
          current();
          slot.warm = Promise.resolve();
          console.warn(
            "[Instant terrain] Worker initialization failed; using the main WebGL context:",
            error,
          );
        }
      }
      current();
      // Load only after archives/module inputs are available. Shader prewarm
      // intentionally does not import the archive-dependent resource builders.
      const { SharedInstantTerrainResources } =
        await import("./shared-instant-terrain");
      current();
      slot.resources ??= new SharedInstantTerrainResources(slot.main);
      return scheduleTerrainWork(
        async () => {
          current();
          const started = performance.now();
          const ok = await slot.resources.ensureResources(
            prepared.tileLayers,
            prepared.biomeData,
            {
              isNGP: gen.isNGP,
              gameMode: gen.gameMode ?? "normal",
              seed: gen.seed,
              lut: { recolorMaterials: true, clearSpawnPixels: true },
              engineTerrain: true,
              generatorConfig: deps.GENERATOR_CONFIG,
              elevatorShafts,
              checkCurrent: current,
            },
          );
          current();
          if (!ok || !slot.main.engineReady || slot.main.gl?.getError?.())
            throw new Error(
              slot.main.failed || "WebGL2 terrain resources unavailable",
            );
          return {
            backend: "main",
            resources: slot.resources,
            renderer: slot.main,
            resourceMs: performance.now() - started,
            shaderWarmupMs: slot.main.shaderWarmupMs,
          };
        },
        fallbackSignal,
        () => 0,
      );
    })().catch((error) => {
      if (slot.token === token) {
        slot.prepared = undefined;
        slot.handles.clear();
      }
      throw error;
    });
  }
  const preparing = slot.preparing!;
  const caller = { signal };
  preparing.add(caller);
  const token = slot.token;
  const current = () => {
    if (slot.released || slot.token !== token)
      throw new DOMException("Obsolete terrain generation", "AbortError");
  };
  let handle = slot.handles.get(plane);
  if (!handle) {
    handle = slot.prepared!.then((base) => {
      current();
      let selectedPlane = plane;
      return {
        backend: base.backend,
        // All small plane tables are included in the one shared source build.
        resourceMs: plane === 0 ? base.resourceMs : 0,
        shaderWarmupMs: base.shaderWarmupMs,
        gl: base.renderer?.gl,
        program: base.renderer?.program,
        setPlane(value: VerticalPlane) {
          if (value !== -1 && value !== 0 && value !== 1)
            throw new Error("Invalid terrain plane");
          selectedPlane = value;
        },
        render(view: any, renderSignal?: AbortSignal) {
          const drawPlane = selectedPlane;
          if (base.worker)
            return (async () => {
              current();
              renderSignal?.throwIfAborted();
              const result = await base.worker.request(
                "render",
                { token, plane: drawPlane, view },
                renderSignal,
              );
              if (slot.token !== token || slot.released) {
                result.bitmap.close();
                current();
              }
              return result.bitmap;
            })();
          current();
          renderSignal?.throwIfAborted();
          base.resources.setPlane(drawPlane);
          return base.resources.render(view);
        },
        async configureViewport(inputs: import('./terrain-viewport-compositor').TerrainViewportInputs) {
          current();
          // TerrainOwnership also exposes an at() helper. Only its compact
          // typed arrays cross the worker boundary, never executable methods.
          inputs = { ...inputs, owners: inputs.owners.map(({ width, owners }) => ({ width, owners })) };
          if (base.worker) {
            await base.worker.request('presentation', { token, inputs });
          } else {
            const { createTerrainViewportCompositor } = await import('./terrain-viewport-compositor');
            current();
            base.presentation?.dispose();
            base.presentation = createTerrainViewportCompositor(inputs);
          }
          current();
        },
        async renderViewport(plan: import('./terrain-viewport-compositor').TerrainViewportPlan, renderSignal?: AbortSignal) {
          current();
          renderSignal?.throwIfAborted();
          if (base.worker) {
            const result = await base.worker.request('frame', { token, plan }, renderSignal);
            if (slot.token !== token || slot.released) { result.bitmap.close(); current(); }
            return result.bitmap;
          }
          if (!base.presentation) throw new Error('Viewport masks are not ready');
          return base.presentation.render(base.resources, plan);
        },
        invalidate() {
          base.presentation?.dispose();
          if (slot.token !== token) return;
          slot.token = ++nextToken;
          slot.prepared = undefined;
          slot.handles.clear();
          if (base.worker)
            void base.worker.request("invalidate", { token }).catch(() => {});
          else base.resources.invalidate();
        },
      };
    });
    slot.handles.set(plane, handle);
  }
  try {
    const result = await handle;
    signal?.throwIfAborted();
    current();
    return result;
  } finally {
    preparing.delete(caller);
  }
}
