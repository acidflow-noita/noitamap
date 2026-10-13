import WorldWorker from "./world-worker?worker";
import type { NativeWorldDescription, WorldRequest } from "./world";

interface Pending {
  resolve(value: NativeWorldDescription | undefined): void;
  reject(reason: unknown): void;
  cleanup(): void;
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

  async generate(request: WorldRequest, signal?: AbortSignal): Promise<NativeWorldDescription> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    return await this.call("generate", request, signal) as NativeWorldDescription;
  }

  private call(type: "prepare" | "generate", request?: WorldRequest, signal?: AbortSignal) {
    if (!this.worker) {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id); entry.cleanup();
        if (data.ok) entry.resolve(data.world);
        else entry.reject(new Error(data.error));
      };
      worker.onerror = event => { if (this.worker === worker) this.fail(new Error(event.message || "Native worker failed")); };
      worker.onmessageerror = () => { if (this.worker === worker) this.fail(new Error("Invalid native worker response")); };
    }
    const id = this.nextId++, worker = this.worker;
    return new Promise<NativeWorldDescription | undefined>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); signal?.removeEventListener("abort", abort);
        worker.postMessage({ type: "cancel", id });
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      try { worker.postMessage({ id, type, request }); }
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
