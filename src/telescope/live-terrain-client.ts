import type { GLTerrainGeneration } from './gl-terrain-tile-source';
import type { TerrainRect } from './terrain-viewport';
import { LiveTerrainUnavailable } from './live-terrain-error';

/** The viewer only copies completed screen-sized images. Shader compilation,
 * scene uploads, decal scheduling and background composition stay off its thread. */
export class LiveTerrainClient {
  private worker = new Worker(new URL('./live-terrain-render-worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private failed?: Error;
  private requests = new Map<number, {
    resolve: (frame: HTMLCanvasElement) => void; reject: (error: unknown) => void;
    publish?: (frame: HTMLCanvasElement) => void; cleanup: () => void;
  }>();
  private ready: Promise<void>;
  constructor(gen: GLTerrainGeneration & { parallelWorlds?: number[] }) {
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Terrain renderer worker failed to start')), 60_000);
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          this.requests.delete(0);
          try {
            // Only the renderer's input, not the adapter's UI/POI result.
            const { seed, isNGP, ngPlus, gameMode, tileLayers, biomeData, sceneData, parallelWorlds } = gen;
            this.worker.postMessage({ type: 'init', generation: { seed, isNGP, ngPlus, gameMode, tileLayers, biomeData, sceneData, parallelWorlds } });
            resolve();
          } catch (error) { this.fail(error as Error); reject(error); }
          return;
        }
        if (data.type === 'fatal') {
          clearTimeout(timer);
          const error = data.unavailable ? new LiveTerrainUnavailable(data.error) : new Error(data.error);
          this.fail(error); reject(error); return;
        }
        const request = this.requests.get(data.id);
        if (!request) { data.bitmap?.close(); return; }
        if (data.type === 'error') {
          request.cleanup(); this.requests.delete(data.id);
          const error = data.unavailable ? new LiveTerrainUnavailable(data.error) : new Error(data.error);
          if (data.unavailable) this.failed = error;
          request.reject(error); return;
        }
        if (data.type !== 'frame') return;
        const image = document.createElement('canvas'); image.width = data.width; image.height = data.height;
        try {
          const ctx = image.getContext('2d')!;
          if (data.bitmap) ctx.drawImage(data.bitmap, 0, 0);
          else ctx.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height), 0, 0);
          if (data.done) {
            request.cleanup(); this.requests.delete(data.id); request.resolve(image);
          } else request.publish?.(image);
        } catch (error) {
          request.cleanup(); this.requests.delete(data.id); request.reject(error);
        } finally { data.bitmap?.close(); }
      };
      this.worker.onerror = event => {
        clearTimeout(timer); const error = new Error(event.message || 'Terrain renderer worker crashed');
        this.fail(error); reject(error);
      };
      this.worker.onmessageerror = () => {
        clearTimeout(timer); const error = new Error('Could not decode terrain renderer response');
        this.fail(error); reject(error);
      };
      // Disposal before the worker is ready must clear its startup timer too.
      this.requests.set(0, { resolve: () => {}, reject, cleanup: () => clearTimeout(timer) });
    });
    void this.ready.catch(() => {});
  }
  async render(bounds: TerrainRect, scale: number, signal: AbortSignal, publish?: (frame: HTMLCanvasElement) => void) {
    signal.throwIfAborted();
    await this.ready;
    signal.throwIfAborted();
    if (this.failed) throw this.failed;
    const id = ++this.nextId;
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({ type: 'cancel', id });
        signal.removeEventListener('abort', abort); this.requests.delete(id); reject(signal.reason);
      };
      this.requests.set(id, { resolve, reject, publish, cleanup: () => signal.removeEventListener('abort', abort) });
      signal.addEventListener('abort', abort, { once: true });
      try { this.worker.postMessage({ type: 'render', id, bounds, scale, progressive: !!publish }); }
      catch (error) { signal.removeEventListener('abort', abort); this.requests.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    this.failed = error;
    for (const request of this.requests.values()) { request.cleanup(); request.reject(error); }
    this.requests.clear(); this.worker.terminate();
  }
  dispose() { this.fail(new DOMException('Terrain disposed', 'AbortError')); }
}
