import type { NativeSceneEncoded, NativeSceneRenderInput } from './native-scene-worker-core';
import type { ScenePixels } from './terrain-scenes';

interface SceneWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}
export interface NativeSceneBitmap { blob: Blob; width: number; height: number }
type Job = {
  id: number;
  input: NativeSceneRenderInput;
  signal?: AbortSignal;
  resolve: (value: NativeSceneBitmap) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
const activeRenderers = new Set<NativeSceneRenderer>();
export function clearNativeSceneRenderers(): void {
  for (const renderer of activeRenderers) renderer.dispose();
}

/** Serial admission bounds both message copies and worker intermediates. Input
 * records remain caller-owned; only an admitted job receives transferred copies.
 * Retiring a generation stops its synchronous CPU work by terminating the worker. */
export class NativeSceneRenderer {
  private worker?: SceneWorker;
  private unavailable = false;
  private disposed = false;
  private nextId = 0;
  private queue: Job[] = [];
  private active?: Job;
  private cpu?: (input: NativeSceneRenderInput) => Promise<NativeSceneEncoded>;
  private workersStarted = 0;
  private fallbackJobs = 0;

  constructor(private readonly factory: () => SceneWorker = () => new Worker(
    new URL('./native-scene-worker.ts', import.meta.url), { type: 'module', name: 'native-scenes' }),
    private readonly fallback?: (input: NativeSceneRenderInput) => Promise<NativeSceneEncoded>) {
    activeRenderers.add(this);
  }
  get stats() { return { queued: this.queue.length, active: !!this.active, workersStarted: this.workersStarted, fallbackJobs: this.fallbackJobs }; }

  render(input: NativeSceneRenderInput, signal?: AbortSignal): Promise<NativeSceneBitmap> {
    if (this.disposed || signal?.aborted) return Promise.reject(signal?.reason ?? new DOMException('Scene renderer disposed', 'AbortError'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, input, signal, resolve, reject, abort: () => {
        if (this.active === job) {
          this.stopWorker(); this.active = undefined;
        } else {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
        }
        signal?.removeEventListener('abort', job.abort);
        reject(signal?.reason ?? new DOMException('Scene rendering cancelled', 'AbortError'));
        this.pump();
      } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  private stopWorker() {
    if (this.worker) { this.worker.onmessage = this.worker.onerror = null; this.worker.onmessageerror = null; this.worker.terminate(); this.worker = undefined; }
  }
  private finish(job: Job, result?: NativeSceneEncoded, error?: unknown) {
    if (this.active !== job) return;
    this.active = undefined;
    job.signal?.removeEventListener('abort', job.abort);
    if (error !== undefined) job.reject(error);
    else if (!result || !(result.png instanceof Uint8Array) || result.width !== job.input.scene.width || result.height !== job.input.scene.height)
      job.reject(new Error('Invalid native scene worker response'));
    else job.resolve({ blob: new Blob([result.png as unknown as BlobPart], { type: 'image/png' }), width: result.width, height: result.height });
    this.pump();
  }
  private async onMain(job: Job) {
    this.fallbackJobs++;
    try {
      // Yield an actual task between scenes when workers are denied. Correct
      // material pixels still render; raw material-code PNGs are never a fallback.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (this.active !== job || job.signal?.aborted) return;
      this.cpu ??= this.fallback ?? (await import('./native-scene-worker-core')).createNativeSceneWorkerRenderer();
      if (this.active !== job || job.signal?.aborted) return;
      this.finish(job, await this.cpu(job.input));
    } catch (error) { this.finish(job, undefined, error); }
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
        const worker = this.worker = this.factory(); this.workersStarted++;
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
      job.signal?.removeEventListener('abort', job.abort); job.reject(reason);
    }
    this.active = undefined; this.queue = []; this.cpu = undefined;
  }
}
