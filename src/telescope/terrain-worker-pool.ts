/** A page-wide pool: main-plane GPU finishing and heaven/hell CPU rendering
 * share this budget rather than each multiplying it by the number of planes. */
export function terrainWorkerLimit(
  hardwareConcurrency = typeof navigator === "undefined"
    ? undefined
    : navigator.hardwareConcurrency,
  deviceMemory = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
): number {
  const cores = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency!))
    : 4;
  const memoryCap =
    deviceMemory === undefined || !Number.isFinite(deviceMemory)
      ? 4
      : deviceMemory <= 2
        ? 1
        : deviceMemory <= 4
          ? 2
          : 6;
  return Math.max(1, Math.min(6, cores - 1, memoryCap));
}

export type TerrainWorkerPort = Pick<
  Worker,
  "onmessage" | "onerror" | "terminate"
> & {
  postMessage(data: any, transfer?: Transferable[]): void;
};
export interface TerrainWorkerContext {
  id: number;
  generation: any;
  released: boolean;
  ready?: any;
}
export interface TerrainWorkerRequest {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels?: Uint8ClampedArray;
}
type Job = {
  id: number;
  context: TerrainWorkerContext;
  request?: TerrainWorkerRequest;
  signal: AbortSignal;
  priority: () => number;
  resolve: (data: any) => void;
  reject: (error: unknown) => void;
  removeAbort: () => void;
};
type Slot = {
  worker: TerrainWorkerPort;
  contextId?: number;
  job?: Job;
  phase?: "init" | "render";
  timer?: ReturnType<typeof setTimeout>;
};
const cancelled = () =>
  new DOMException("Terrain generation cancelled", "AbortError");

/** One task per worker, but independent tiles run concurrently. Workers keep
 * one initialized plane each; idle workers can be reassigned when the viewport
 * moves. All queues use absolute viewport priority, not FIFO per plane. */
export class TerrainWorkerPool {
  readonly limit: number;
  private createWorker: () => TerrainWorkerPort;
  private contexts = new Set<TerrainWorkerContext>();
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private serial = 0;
  private pumping = false;
  private peakBusy = 0;
  private peakRendering = 0;
  private completed = 0;

  constructor(limit: number, createWorker: () => TerrainWorkerPort) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid terrain worker limit");
    this.limit = limit;
    this.createWorker = createWorker;
  }
  context(generation: any): TerrainWorkerContext {
    const context = { id: ++this.serial, generation, released: false };
    this.contexts.add(context);
    return context;
  }
  get stats() {
    return {
      limit: this.limit,
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queue.length,
      peakBusy: this.peakBusy,
      peakRendering: this.peakRendering,
      completed: this.completed,
    };
  }
  ready(context: TerrainWorkerContext, signal: AbortSignal): Promise<any> {
    return this.enqueue(context, undefined, signal, () => -1);
  }
  render(
    context: TerrainWorkerContext,
    request: TerrainWorkerRequest,
    signal: AbortSignal,
    priority: () => number,
  ): Promise<any> {
    return this.enqueue(context, request, signal, priority);
  }
  private enqueue(
    context: TerrainWorkerContext,
    request: TerrainWorkerRequest | undefined,
    signal: AbortSignal,
    priority: () => number,
  ): Promise<any> {
    if (context.released || signal.aborted)
      return Promise.reject(signal.reason ?? cancelled());
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.serial,
        context,
        request,
        signal,
        priority,
        resolve,
        reject,
        removeAbort: () => signal.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        else {
          const slot = this.slots.find((s) => s.job === job);
          if (slot?.phase === "render")
            slot.worker.postMessage({ type: "cancel", id: job.id });
        }
        job.removeAbort();
        reject(signal.reason ?? cancelled());
        this.pump();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  private spawn(): Slot {
    const slot: Slot = { worker: this.createWorker() };
    slot.worker.onmessage = ({ data }) => this.message(slot, data);
    slot.worker.onerror = (event) =>
      this.breakWorker(
        slot,
        new Error(event.message || "Terrain worker failed"),
      );
    this.slots.push(slot);
    return slot;
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const ranked: { job: Job; priority: number }[] = [];
      for (const job of this.queue.splice(0)) {
        try {
          job.signal.throwIfAborted();
          if (job.context.released) throw cancelled();
          const priority = job.priority();
          ranked.push({
            job,
            priority: Number.isFinite(priority) ? priority : 0,
          });
        } catch (error) {
          job.removeAbort();
          job.reject(error);
        }
      }
      ranked.sort((a, b) => a.priority - b.priority);
      this.queue.push(...ranked.map((r) => r.job));
      while (this.queue.length) {
        const job = this.queue[0];
        let slot = this.slots.find(
          (s) => !s.job && s.contextId === job.context.id,
        );
        // Keep existing planes warm if the total pool still has headroom.
        if (!slot && this.slots.length < this.limit) {
          try {
            slot = this.spawn();
          } catch (error) {
            this.queue.shift();
            job.removeAbort();
            job.reject(error);
            continue;
          }
        }
        slot ??= this.slots.find((s) => !s.job);
        if (!slot) break;
        this.queue.shift();
        slot.job = job;
        this.peakBusy = Math.max(
          this.peakBusy,
          this.slots.filter((s) => s.job).length,
        );
        if (slot.contextId === job.context.id) this.startRender(slot);
        else {
          slot.contextId = undefined;
          slot.phase = "init";
          slot.timer = setTimeout(
            () =>
              this.breakWorker(
                slot!,
                new Error("Terrain worker initialization timed out"),
              ),
            60000,
          );
          try {
            // Clone per worker. Never transfer/detach the context's source
            // buffers: another worker may need the SAME generation later.
            slot.worker.postMessage({
              id: job.id,
              type: "init",
              generation: job.context.generation,
            });
          } catch (error) {
            this.breakWorker(slot, error);
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private startRender(slot: Slot): void {
    const job = slot.job!;
    if (job.signal.aborted || job.context.released) {
      this.finish(slot, job.signal.reason ?? cancelled());
      return;
    }
    if (!job.request) {
      this.finish(slot, undefined, job.context.ready);
      return;
    }
    const { pixels, ...request } = job.request;
    slot.phase = "render";
    this.peakRendering = Math.max(
      this.peakRendering,
      this.slots.filter((s) => s.phase === "render").length,
    );
    try {
      slot.worker.postMessage(
        {
          id: job.id,
          type: pixels ? "present" : "render",
          ...request,
          pixels: pixels?.buffer,
        },
        pixels ? [pixels.buffer as ArrayBuffer] : [],
      );
    } catch (error) {
      this.breakWorker(slot, error);
    }
  }
  private message(slot: Slot, data: any): void {
    if (!this.slots.includes(slot)) return; // terminated generation
    const job = slot.job;
    if (!job || data.id !== job.id) return;
    if (data.type === "error") {
      this.finish(slot, new Error(data.message || "Terrain worker failed"));
      return;
    }
    if (slot.phase === "init") {
      if (data.type !== "ready") {
        this.breakWorker(
          slot,
          new Error("Invalid terrain worker initialization response"),
        );
        return;
      }
      clearTimeout(slot.timer);
      slot.timer = undefined;
      job.context.ready = data;
      slot.contextId = job.context.id;
      this.startRender(slot);
    } else if (data.type === "tile") {
      this.completed++;
      this.finish(
        slot,
        job.signal.aborted ? job.signal.reason : undefined,
        data,
      );
    } else if (data.type === "cancelled")
      this.finish(slot, job.signal.reason ?? cancelled());
    else this.breakWorker(slot, new Error("Invalid terrain tile response"));
  }
  private finish(slot: Slot, error?: unknown, result?: any): void {
    const job = slot.job;
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = undefined;
    slot.phase = undefined;
    if (job) {
      job.removeAbort();
      if (error !== undefined) job.reject(error);
      else job.resolve(result);
    }
    this.pump();
  }
  private breakWorker(slot: Slot, error: unknown): void {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    this.finish(slot, error);
  }
  release(context: TerrainWorkerContext, error: unknown = cancelled()): void {
    if (context.released) return;
    context.released = true;
    this.contexts.delete(context);
    const jobs = this.queue.filter((j) => j.context === context);
    this.queue = this.queue.filter((j) => j.context !== context);
    for (const job of jobs) {
      job.removeAbort();
      job.reject(error);
    }
    for (const slot of [...this.slots]) {
      if (
        slot.job?.context === context ||
        (!slot.job && slot.contextId === context.id)
      )
        this.breakWorker(slot, error);
    }
    // No orphan workers are allowed to outlive the last map renderer.
    if (!this.contexts.size)
      for (const slot of [...this.slots]) this.breakWorker(slot, error);
    this.pump();
  }
}
