import type { MaskAsset } from './mask-worker';
import type { MaskBounds } from './mask-index';
export interface ViewLiquidMask extends MaskBounds {
  pixels: Uint8Array;
  /** Queried area, including empty pixels. Reuse only when complete is true. */
  coverage?: MaskBounds;
  complete?: boolean;
}

export class LiquidMaskWorkerClient {
  private worker: Worker;
  private sequence = 0;
  private stopped = false;
  private stopReason: unknown;
  private pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; cleanup(): void }>();
  constructor(worker = new Worker(new URL('./mask-worker.ts', import.meta.url), { type: 'module', name: 'liquid-masks' })) {
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id); pending.cleanup();
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
    };
    worker.onerror = event => this.destroy(new Error(event.message || 'Liquid mask worker failed'));
    worker.onmessageerror = () => this.destroy(new Error('Invalid liquid mask response'));
  }
  private request(type: string, data: any, signal: AbortSignal, transfer: Transferable[] = []): Promise<any> {
    if (this.stopped) return Promise.reject(this.stopReason);
    signal.throwIfAborted(); const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => { try { this.worker.postMessage({ type: 'cancel', id }); } catch { /* Already terminated. */ } };
      const abort = () => { this.pending.delete(id); cancel(); cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => {
        this.pending.delete(id); cancel(); cleanup(); reject(new Error('Liquid mask request timed out'));
      }, 35000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      try { this.worker.postMessage({ id, type, ...data }, transfer); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  async paint(bounds: MaskBounds, sources: readonly MaskAsset[], signal: AbortSignal): Promise<Uint8Array> {
    return (await this.request('paint', { bounds, sources }, signal)).pixels;
  }
  async crop(bounds: MaskBounds, pixels: Uint8Array, exclusions: readonly MaskBounds[], signal: AbortSignal): Promise<ViewLiquidMask | null> {
    return (await this.request('crop', { bounds, pixels, exclusions }, signal, [pixels.buffer as ArrayBuffer])).mask;
  }
  destroy(error: unknown = new DOMException('Liquid masks disposed', 'AbortError')) {
    if (this.stopped) return;
    this.stopped = true; this.stopReason = error;
    this.worker.terminate();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
}
