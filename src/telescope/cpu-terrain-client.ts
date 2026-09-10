import { serializeTileLayer } from "./tile-layer-cache";
import {
  TerrainWorkerPool,
  terrainWorkerLimit,
  type TerrainWorkerContext,
} from "./terrain-worker-pool";

let pool: TerrainWorkerPool | undefined;
function sharedPool() {
  return (pool ??= new TerrainWorkerPool(
    terrainWorkerLimit(),
    () =>
      new Worker(new URL("./cpu-terrain-worker.ts", import.meta.url), {
        type: "module",
      }),
  ));
}
/** Diagnostic counts for native tests and local profiling; no UI/browser state. */
export function liveTerrainWorkerStats() {
  return pool?.stats;
}

/** A lightweight plane handle into the page-wide worker pool. Main-plane GPU
 * finishing and vertical CPU renderers share the same hardware/memory budget. */
export class CpuTerrainRenderer {
  readonly backend = "cpu";
  ready = false;
  failed: string | null = null;
  stats: any;
  private context: TerrainWorkerContext | null = null;
  private lifetime: AbortController | null = null;
  private sourceLayers: any[] | null = null;
  private sourceBiome: any;
  private sourceSeed: number | undefined;
  private initialization: Promise<boolean> | null = null;
  private mapWidth = 70;
  private centerPx = 17920;

  rendersWorld(plane: number) {
    return plane >= -1 && plane <= 1;
  }
  async ensureResources(
    layers: any[],
    biomeData: any,
    options: any,
  ): Promise<boolean> {
    if (
      this.sourceLayers === layers &&
      this.sourceBiome === biomeData &&
      this.sourceSeed === options.seed &&
      this.initialization
    )
      return this.initialization;
    this.invalidate();
    this.failed = null;
    this.sourceLayers = layers;
    this.sourceBiome = biomeData;
    this.sourceSeed = options.seed;
    const lifetime = (this.lifetime = new AbortController());
    const context = (this.context = sharedPool().context({
      tileLayers: layers.map(serializeTileLayer),
      plane: options.plane ?? 0,
      biomeData,
      sourceBiomeData: options.sourceBiomeData,
      sceneData: options.sceneData,
      elevatorShafts: options.elevatorShafts?.map(serializeTileLayer),
      seed: options.seed,
      isNGP: options.isNGP,
      gameMode: options.gameMode,
    }));
    this.initialization = sharedPool()
      .ready(context, lifetime.signal)
      .then((data) => {
        lifetime.signal.throwIfAborted();
        this.mapWidth = data.mapWidth;
        this.centerPx = data.centerPx;
        this.stats = { ...data.stats, workerLimit: sharedPool().limit };
        this.ready = true;
        return true;
      })
      .catch((error) => {
        if (this.context === context && !lifetime.signal.aborted) {
          this.failed = String(error);
          this.invalidate(error);
        }
        throw error;
      });
    return this.initialization;
  }
  async render(
    view: any,
    signal: AbortSignal,
    priority: () => number,
    pixels?: Uint8ClampedArray,
  ): Promise<HTMLCanvasElement> {
    if (!this.ready || !this.context)
      throw new Error("CPU terrain is not ready");
    signal.throwIfAborted();
    const data = await sharedPool().render(
      this.context,
      {
        x: Math.floor(
          view.camX -
            view.width / 2 -
            this.centerPx +
            view.pw * this.mapWidth * 512,
        ),
        y: Math.floor(view.camY - view.height / 2 - 7168),
        width: view.width,
        height: view.height,
        pixels,
      },
      signal,
      priority,
    );
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = data.width;
    canvas.height = data.height;
    canvas
      .getContext("2d")!
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(data.pixels),
          data.width,
          data.height,
        ),
        0,
        0,
      );
    return canvas;
  }
  invalidate(
    error: unknown = new DOMException(
      "Terrain generation cancelled",
      "AbortError",
    ),
  ): void {
    this.ready = false;
    this.lifetime?.abort(error);
    this.lifetime = null;
    if (this.context) pool?.release(this.context, error);
    this.context = null;
    this.initialization = null;
    this.sourceLayers = null;
    this.sourceBiome = null;
  }
}
