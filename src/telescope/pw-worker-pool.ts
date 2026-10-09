import type { WorkerScenes } from './worker-scenes';

export type ParallelWorldWorker = Pick<Worker, 'onmessage' | 'onerror' | 'terminate'> & {
  postMessage(data: any): void;
};
export interface ParallelWorldRequest {
  pw: number;
  fullPixels: boolean;
  [key: string]: unknown;
}
export interface ParallelWorldResult { pw: number; pois: any[]; pixelScenes: any[] }
type Job = { id: number; input: ParallelWorldRequest; scenes?: () => WorkerScenes;
  resolve: (result: ParallelWorldResult) => void; reject: (error: Error) => void };
type Slot = { worker: ParallelWorldWorker; fork: boolean; initialized: boolean; job?: Job; timer?: ReturnType<typeof setTimeout> };

/** Two persistent PW workers, each with one immutable scene snapshot. Jobs on
 * a worker stay serial because Telescope's RNG/unlock/settings state is global.
 * Changing fork retires an idle slot rather than retaining both large tables. */
export class ParallelWorldWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private serial = 0;
  private disposed = false;
  private sceneSnapshots = 0;
  private completed = 0;
  private prewarming = new Map<boolean, Promise<void>>();

  constructor(private readonly createWorker: () => ParallelWorldWorker, private readonly limit = 2) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2) throw new Error('PW worker limit must be 1 or 2');
  }

  get stats() { return { workers: this.slots.length, busy: this.slots.filter(slot => slot.job).length,
    queued: this.queue.length, sceneSnapshots: this.sceneSnapshots, completed: this.completed }; }

  run(input: ParallelWorldRequest, scenes?: () => WorkerScenes): Promise<ParallelWorldResult> {
    if (this.disposed) return Promise.reject(new Error('PW worker pool disposed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.serial, input, scenes, resolve, reject });
      this.pump();
    });
  }

  /** Start fork tables and the immutable packed scenes during main-thread asset
   * loading. Decode directly on these workers: no giant RGBA snapshot clone. */
  prewarm(fullPixels: boolean): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('PW worker pool disposed'));
    const prior = this.prewarming.get(fullPixels);
    if (prior) return prior;
    if (this.slots.length === this.limit && this.slots.every(slot => slot.fork === fullPixels && slot.initialized)) return Promise.resolve();
    const pending = Promise.all(Array.from({ length: this.limit }, () =>
      this.run({ pw: 0, fullPixels, prepareOnly: true, gameMode: 'normal' }))).then(() => undefined);
    this.prewarming.set(fullPixels, pending);
    void pending.finally(() => { if (this.prewarming.get(fullPixels) === pending) this.prewarming.delete(fullPixels); }).catch(() => {});
    return pending;
  }

  private pump(): void {
    while (this.queue.length && !this.disposed) {
      const next = this.queue[0];
      let slot = this.slots.find(slot => !slot.job && slot.fork === next.input.fullPixels);
      if (!slot) {
        const obsolete = this.slots.find(slot => !slot.job);
        if (obsolete) this.retire(obsolete);
        else if (this.slots.length >= this.limit) return;
        try {
          slot = { worker: this.createWorker(), fork: next.input.fullPixels, initialized: false };
        } catch (error) {
          this.queue.shift()!.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        const created = slot;
        slot.worker.onmessage = event => this.receive(created, event.data);
        slot.worker.onerror = event => { event.preventDefault?.(); this.fail(created, new Error(event.message || 'PW worker failed')); };
        this.slots.push(slot);
      }
      slot.job = this.queue.shift()!;
      const active = slot;
      slot.timer = setTimeout(() => this.fail(active, new Error(`PW ${active.job?.input.pw} timed out`)), 60000);
      try {
        const workerScenes = slot.initialized ? undefined : slot.job.scenes?.();
        slot.worker.postMessage({ ...slot.job.input, requestId: slot.job.id, workerScenes });
        if (workerScenes) this.sceneSnapshots++;
      } catch (error) {
        this.fail(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private receive(slot: Slot, data: any): void {
    const job = slot.job;
    if (!job) return;
    if (!data || data.requestId !== job.id || data.pw !== job.input.pw) {
      this.fail(slot, new Error('Mismatched PW worker response')); return;
    }
    if (!data.success) {
      const error = new Error(`PW ${job.input.pw}, ${data.phase || 'worker'}: ${data.error || 'Worker failed'}`);
      if (data.stack) error.stack += `\nWorker stack:\n${data.stack}`;
      this.fail(slot, error); return;
    }
    if (!Array.isArray(data.pois) || !Array.isArray(data.pixelScenes)) {
      this.fail(slot, new Error('Invalid PW worker result')); return;
    }
    clearTimeout(slot.timer); slot.timer = undefined; slot.job = undefined; slot.initialized = true;
    if (!job.input.prepareOnly) this.completed++;
    job.resolve(data); this.pump();
  }

  private retire(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker.terminate();
    const i = this.slots.indexOf(slot); if (i >= 0) this.slots.splice(i, 1);
  }

  private fail(slot: Slot, error: Error): void {
    const job = slot.job; slot.job = undefined;
    this.retire(slot); job?.reject(error); this.pump();
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error('PW worker pool disposed');
    for (const slot of [...this.slots]) { slot.job?.reject(error); this.retire(slot); }
    for (const job of this.queue.splice(0)) job.reject(error);
  }
}
