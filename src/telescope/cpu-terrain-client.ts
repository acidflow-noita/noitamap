import { serializeTileLayer } from "./tile-layer-cache";

type TileRequest = {
  id: number;
  view: any;
  signal: AbortSignal;
  priority: () => number;
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

/** One worker and one in-flight CPU tile. Queued work is re-prioritized whenever
 * a tile completes, so zoomed-out requests can't monopolize the worker. */
export class CpuTerrainRenderer {
  readonly backend = "cpu";
  ready = false;
  failed: string | null = null;
  stats: any;
  private worker: Worker | null = null;
  private serial = 0;
  private queue: TileRequest[] = [];
  private current: TileRequest | null = null;
  private sourceLayers: any[] | null = null;
  private sourceBiome: any;
  private sourceSeed: number | undefined;
  private initialization: Promise<boolean> | null = null;
  private failInitialization: ((error: unknown) => void) | null = null;
  private mapWidth = 70;
  private centerPx = 17920;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  rendersWorld(plane: number) { return plane >= -1 && plane <= 1; }

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
    this.sourceLayers = layers;
    this.sourceBiome = biomeData;
    this.sourceSeed = options.seed;
    const worker = (this.worker = new Worker(
      new URL("./cpu-terrain-worker.ts", import.meta.url),
      { type: "module" },
    ));
    this.initialization = new Promise<boolean>((resolve, reject) => {
      this.failInitialization = reject;
      this.startupTimer = setTimeout(
        () =>
          this.fail(new Error("CPU terrain worker initialization timed out")),
        60000,
      );
      worker.onerror = (event) =>
        this.fail(new Error(event.message || "CPU terrain worker failed"));
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          clearTimeout(this.startupTimer);
          this.failInitialization = null;
          this.mapWidth = data.mapWidth;
          this.centerPx = data.centerPx;
          this.stats = data.stats;
          this.ready = true;
          resolve(true);
          this.pump();
          return;
        }
        if (!this.ready) {
          this.fail(
            new Error(data.message || "CPU terrain initialization failed"),
          );
          return;
        }
        const task = this.current;
        if (!task || task.id !== data.id) return;
        this.current = null;
        task.cleanup();
        try {
          task.signal.throwIfAborted();
          if (data.type === "error") throw new Error(data.message);
          if (data.type !== "tile")
            throw new DOMException("Terrain tile cancelled", "AbortError");
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
          task.resolve(canvas);
        } catch (error) {
          task.reject(error);
        }
        this.pump();
      };
      // Serialize/copy only generator data. Never detach the map's layer buffers.
      const tileLayers = layers.map(serializeTileLayer);
      const elevatorShafts = options.elevatorShafts?.map(serializeTileLayer);
      worker.postMessage(
        {
          id: ++this.serial,
          type: "init",
          generation: {
            tileLayers,
            plane: options.plane ?? 0,
            biomeData,
            sourceBiomeData: options.sourceBiomeData,
            sceneData: options.sceneData,
            elevatorShafts,
            seed: options.seed,
            isNGP: options.isNGP,
            gameMode: options.gameMode,
          },
        },
        tileLayers.flatMap((layer) => (layer.buffer ? [layer.buffer] : [])),
      );
    });
    return this.initialization;
  }

  render(
    view: any,
    signal: AbortSignal,
    priority: () => number,
  ): Promise<HTMLCanvasElement> {
    if (!this.ready)
      return Promise.reject(new Error("CPU terrain is not ready"));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const abort = () => {
        if (this.current?.id === id)
          this.worker?.postMessage({ type: "cancel", id });
        else {
          this.queue = this.queue.filter((t) => t.id !== id);
          task.cleanup();
        }
        reject(
          signal.reason ??
            new DOMException("Terrain tile cancelled", "AbortError"),
        );
      };
      const task: TileRequest = {
        id,
        view,
        signal,
        priority,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }

  private pump(): void {
    if (!this.ready || this.current || !this.worker) return;
    this.queue.sort((a, b) => a.priority() - b.priority());
    const task = this.queue.shift();
    if (!task) return;
    if (task.signal.aborted) {
      task.cleanup();
      task.reject(task.signal.reason);
      this.pump();
      return;
    }
    this.current = task;
    const v = task.view;
    const x = Math.floor(
      v.camX - v.width / 2 - this.centerPx + v.pw * this.mapWidth * 512,
    );
    const y = Math.floor(v.camY - v.height / 2 - 7168);
    this.worker.postMessage({
      id: task.id,
      type: "render",
      x,
      y,
      width: v.width,
      height: v.height,
    });
  }

  private fail(error: unknown): void {
    this.failed = String(error);
    this.invalidate(error);
  }

  invalidate(
    error: unknown = new DOMException(
      "Terrain generation cancelled",
      "AbortError",
    ),
  ): void {
    this.ready = false;
    clearTimeout(this.startupTimer);
    this.failInitialization?.(error);
    this.failInitialization = null;
    this.worker?.terminate();
    this.worker = null;
    for (const task of [this.current, ...this.queue])
      if (task) {
        task.cleanup();
        task.reject(error);
      }
    this.current = null;
    this.queue = [];
    this.initialization = null;
    this.sourceLayers = null;
    this.sourceBiome = null;
  }
}
