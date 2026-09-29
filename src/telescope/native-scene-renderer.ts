import type { NativeSceneEncoded, NativeSceneRenderInput } from './native-scene-worker-core';
import type { ScenePixels } from './terrain-scenes';

interface NativeSceneBitmap { blob: Blob; width: number; height: number }
type Job = {
  id: number;
  input: NativeSceneRenderInput;
  resolve: (value: NativeSceneBitmap) => void;
  reject: (error: unknown) => void;
};
const activeRenderers = new Set<NativeSceneRenderer>();
let mainSceneQueue: Promise<void> = Promise.resolve();
export function clearNativeSceneRenderers(): void {
  for (const renderer of activeRenderers) renderer.dispose();
}

/** Serial admission bounds both message copies and worker intermediates. Input
 * records remain caller-owned; only an admitted job receives transferred copies.
 * Retiring a generation stops its synchronous CPU work by terminating the worker. */
export class NativeSceneRenderer {
  private worker?: Worker;
  private unavailable = false;
  private disposed = false;
  private nextId = 0;
  private queue: Job[] = [];
  private active?: Job;
  private cpu?: (input: NativeSceneRenderInput) => Promise<NativeSceneEncoded>;
  constructor() {
    activeRenderers.add(this);
  }

  render(input: NativeSceneRenderInput): Promise<NativeSceneBitmap> {
    if (this.disposed) return Promise.reject(new DOMException('Scene renderer disposed', 'AbortError'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, input, resolve, reject };
      this.queue.push(job); this.pump();
    });
  }
  private stopWorker() {
    if (this.worker) { this.worker.onmessage = this.worker.onerror = null; this.worker.onmessageerror = null; this.worker.terminate(); this.worker = undefined; }
  }
  private finish(job: Job, result?: NativeSceneEncoded, error?: unknown) {
    if (this.active !== job) return;
    this.active = undefined;
    if (error !== undefined) job.reject(error);
    else if (!result || !(result.png instanceof Uint8Array) || result.width !== job.input.scene.width || result.height !== job.input.scene.height)
      job.reject(new Error('Invalid native scene worker response'));
    else job.resolve({ blob: new Blob([result.png as unknown as BlobPart], { type: 'image/png' }), width: result.width, height: result.height });
    this.pump();
  }
  private onMain(job: Job): Promise<void> {
    // Worker fallback is shared across the pool: only one main-thread scene
    // runs at a time, with a task boundary before each CPU composition.
    const work = mainSceneQueue.then(async () => {
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (this.active !== job) return;
        this.cpu ??= (await import('./native-scene-worker-core')).createNativeSceneWorkerRenderer();
        if (this.active !== job) return;
        this.finish(job, await this.cpu(job.input));
      } catch (error) { this.finish(job, undefined, error); }
    });
    mainSceneQueue = work.catch(() => {});
    return work;
  }
  private workerFailed(job: Job, error: unknown) {
    if (this.active !== job) return;
    this.stopWorker();
    this.unavailable = true;
    console.warn('[Native scenes] Worker unavailable; compositing on the main thread:', error);
    void this.onMain(job);
  }
  private pump() {
    if (this.active || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    if (this.unavailable) { void this.onMain(job); return; }
    try {
      if (!this.worker) {
        const worker = this.worker = new Worker(new URL('./native-scene-worker.ts', import.meta.url),
          { type: 'module', name: 'native-scenes' });
        worker.onmessage = ({ data }) => {
          const active = this.active;
          if (this.worker !== worker || !active || data.id !== active.id) return;
          this.finish(active, data.error ? undefined : data, data.error ? new Error(data.error) : undefined);
        };
        worker.onmessageerror = () => {
          if (this.worker === worker && this.active)
            this.workerFailed(this.active, new Error('Native scene worker response could not be decoded'));
        };
        worker.onerror = event => {
          event.preventDefault?.();
          if (this.worker === worker && this.active) this.workerFailed(this.active, new Error(event.message || 'Native scene worker failed'));
        };
      }
      const transfer: Transferable[] = [];
      const copy = <T extends ScenePixels>(image: T): T => {
        const data = new Uint8ClampedArray(image.data);
        transfer.push(data.buffer);
        return { ...image, data };
      };
      const { source, backdrop } = job.input;
      this.worker.postMessage({ id: job.id, input: { ...job.input, source: {
        ...copy(source), visualArt: source.visualArt ? copy(source.visualArt) : source.visualArt,
        backgroundArt: source.backgroundArt ? copy(source.backgroundArt) : source.backgroundArt,
      }, backdrop: backdrop ? copy(backdrop) : undefined } }, transfer);
    } catch (error) { this.workerFailed(job, error); }
  }
  dispose(reason: unknown = new DOMException('Scene renderer disposed', 'AbortError')): void {
    if (this.disposed) return;
    this.disposed = true; activeRenderers.delete(this);
    this.stopWorker();
    for (const job of [...(this.active ? [this.active] : []), ...this.queue]) {
      job.reject(reason);
    }
    this.active = undefined; this.queue = []; this.cpu = undefined;
  }
}
