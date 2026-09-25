interface EncoderWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

const activeEncoders = new Set<TerrainPngEncoder>();
export function clearTerrainPngEncoders(): void {
  for (const encoder of activeEncoders) encoder.dispose();
}

/** One short-lived worker for the map's large PNGs. The pure encoder preserves
 * the fingerprint-protection path; canvas/browser PNG encoding is not used. */
export class TerrainPngEncoder {
  private worker: EncoderWorker | undefined;
  private nextId = 0;
  private disposed = false;
  private pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly factory: () => EncoderWorker = () =>
    new Worker(new URL('./terrain-png-worker.ts', import.meta.url), { type: 'module', name: 'terrain-png' })) {
    activeEncoders.add(this);
  }

  encode(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Blob> {
    if (this.disposed) return Promise.reject(new Error('Terrain PNG encoder disposed'));
    if (!this.worker) {
      try { this.worker = this.factory(); } catch (error) { return Promise.reject(error); }
      this.worker.onmessage = ({ data: result }) => {
        const job = this.pending.get(result.id);
        if (!job) return;
        clearTimeout(job.timeout); this.pending.delete(result.id);
        if (result.png instanceof Uint8Array) job.resolve(new Blob([result.png as unknown as BlobPart], { type: 'image/png' }));
        else job.reject(new Error(result.error || 'Invalid terrain PNG response'));
      };
      this.worker.onerror = event => { event.preventDefault?.(); this.dispose(new Error(event.message || 'Terrain PNG worker failed')); };
    }
    const id = ++this.nextId;
    // Canvas shims may retain the source pixels. Transfer an owned copy so
    // cancellation/fallback never detaches that shared source buffer.
    const pixels = new Uint8Array(data);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.dispose(new Error('Terrain PNG worker timed out')), 30000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.worker!.postMessage({ id, pixels, width, height }, [pixels.buffer]); }
      catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  dispose(error = new Error('Terrain PNG encoder disposed')): void {
    this.disposed = true;
    activeEncoders.delete(this);
    this.worker?.terminate(); this.worker = undefined;
    for (const job of this.pending.values()) { clearTimeout(job.timeout); job.reject(error); }
    this.pending.clear();
  }
}
