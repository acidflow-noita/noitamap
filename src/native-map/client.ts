import WorldWorker from "./world-worker?worker";
import type { NativeRegionDescription, NativeTerrainDescription, NativeWorldDescription, WorldRequest } from "./world";

interface Pending {
  resolve(value: NativeWorldDescription | NativeRegionDescription | undefined): void;
  reject(reason: unknown): void;
  cleanup(): void;
  terrain?: NativeTerrainDescription;
  onTerrainReady?: (terrain: NativeTerrainDescription) => void;
  expectedSeed?: number;
}

/** Persistent worker; initialization and immutable assets survive reseeding. */
export class NativeWorldClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready?: Promise<void>;

  constructor(private readonly createWorker: () => Worker = () => new WorldWorker()) {}

  prepare(): Promise<void> {
    if (this.ready) return this.ready;
    const pending = this.call("prepare").then(() => {}).catch(error => {
      if (this.ready === pending) this.dispose();
      throw error;
    });
    this.ready = pending;
    return pending;
  }

  async generate(request: WorldRequest, signal?: AbortSignal,
    onTerrainReady?: (terrain: NativeTerrainDescription) => void): Promise<NativeWorldDescription> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    return await this.call("generate", request, signal, onTerrainReady) as NativeWorldDescription;
  }

  async generateRegions(request: WorldRequest, signal?: AbortSignal): Promise<NativeRegionDescription> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    return await this.call("generate-regions", request, signal) as NativeRegionDescription;
  }

  private call(type: "prepare" | "generate" | "generate-regions", request?: WorldRequest, signal?: AbortSignal,
    onTerrainReady?: (terrain: NativeTerrainDescription) => void) {
    if (!this.worker) {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        const entry = this.pending.get(data.id);
        if (!entry) return;
        if (data.type === "terrain") {
          try {
            if (!entry.onTerrainReady || entry.terrain || data.terrain?.seed !== entry.expectedSeed)
              throw new Error("Unexpected native terrain message");
            entry.terrain = data.terrain;
            entry.onTerrainReady(data.terrain);
          } catch (error) {
            this.pending.delete(data.id); entry.cleanup();
            worker.postMessage({ type: "cancel", id: data.id }); entry.reject(error);
          }
          return;
        }
        this.pending.delete(data.id); entry.cleanup();
        if (data.ok && data.terrainTransferred) {
          const terrain = entry.terrain, world = data.world;
          if (!terrain || !world || terrain.seed !== world.seed || terrain.ngPlus !== world.ngPlus
            || terrain.gameMode !== world.gameMode || terrain.worldSize !== world.worldSize || terrain.worldCenter !== world.worldCenter)
            entry.reject(new Error("Native terrain completion mismatch"));
          else entry.resolve({ ...world, ...terrain });
        } else if (data.ok) entry.resolve(data.world);
        else entry.reject(new Error(data.error));
      };
      worker.onerror = event => { if (this.worker === worker) this.fail(new Error(event.message || "Native worker failed")); };
      worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error("Invalid native worker response")); };
    }
    const id = this.nextId++, worker = this.worker;
    return new Promise<NativeWorldDescription | NativeRegionDescription | undefined>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); signal?.removeEventListener("abort", abort);
        worker.postMessage({ type: "cancel", id });
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      this.pending.set(id, { resolve, reject, onTerrainReady, expectedSeed: request?.seed,
        cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      try { worker.postMessage({ id, type, request, ...(onTerrainReady ? { streamTerrain: true } : {}) }); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener("abort", abort); reject(error); }
    });
  }

  private fail(error: Error) {
    this.worker?.terminate(); this.worker = null; this.ready = undefined;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear();
  }

  dispose(): void { this.fail(new Error("Native generator disposed")); }
}
