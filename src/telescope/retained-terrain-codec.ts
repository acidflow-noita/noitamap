import type { StoredTerrain } from "./retained-terrain";

export type EncodedTerrain = Omit<StoredTerrain, "pixels"> & {
  encoding: "png-rgba-v1" | "constant-rgba-v1";
  data: Uint8Array;
};
export interface RetentionCodec {
  encode(pages: StoredTerrain[]): Promise<EncodedTerrain[]>;
  decode(page: EncodedTerrain): Promise<StoredTerrain>;
  dispose?(): void;
}

interface CodecWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** Persistence snapshots already have a 4 MiB bound. Submit one operation at
 * a time, copying/transferring only after it reaches the worker; live display
 * canvases and their pixels never depend on this codec. */
export class WorkerRetentionCodec implements RetentionCodec {
  private worker?: CodecWorker;
  private serial: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private stopped?: Error;
  private active?: {
    id: number;
    resolve(value: any): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private readonly factory: () => CodecWorker = () =>
      new Worker(
        new URL("./retained-terrain-codec-worker.ts", import.meta.url),
        { type: "module", name: "retained-terrain-codec" },
      ),
  ) {}
  encode(pages: StoredTerrain[]): Promise<EncodedTerrain[]> {
    if (
      pages.reduce((sum, page) => sum + page.pixels.byteLength, 0) >
      4 * 1024 * 1024
    )
      return Promise.reject(
        new Error("Retained terrain codec batch exceeds 4 MiB"),
      );
    return this.request("encode", pages);
  }
  decode(page: EncodedTerrain): Promise<StoredTerrain> {
    return this.request("decode", [page]).then((result) => result[0]);
  }
  dispose(): void {
    this.stop(new Error("Retained terrain codec disposed"));
  }
  private request(
    type: "encode" | "decode",
    pages: (StoredTerrain | EncodedTerrain)[],
  ): Promise<any[]> {
    const operation = this.serial.then(() => {
      if (this.stopped) throw this.stopped;
      if (!this.worker) {
        this.worker = this.factory();
        this.worker.onmessage = ({ data }) => {
          const active = this.active;
          if (!active || data.id !== active.id) return;
          clearTimeout(active.timer);
          this.active = undefined;
          if (data.error) active.reject(new Error(data.error));
          else active.resolve(data.pages);
        };
        this.worker.onerror = (event) =>
          this.stop(
            new Error(event.message || "Retained terrain codec failed"),
          );
      }
      return new Promise<any[]>((resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(
          () => this.stop(new Error("Retained terrain codec timed out")),
          30_000,
        );
        this.active = { id, resolve, reject, timer };
        // The store API does not take ownership of caller buffers.
        const owned = pages.map((page) =>
          "pixels" in page
            ? {
                ...page,
                pixels: new Uint8ClampedArray(page.pixels),
                coverage: page.coverage.slice(),
              }
            : {
                ...page,
                data: page.data.slice(),
                coverage: page.coverage.slice(),
              },
        );
        const transfer = owned.map((page) =>
          "pixels" in page ? page.pixels.buffer : page.data.buffer,
        );
        try {
          this.worker!.postMessage({ id, type, pages: owned }, transfer);
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private stop(error: Error) {
    this.stopped = error;
    this.worker?.terminate();
    this.worker = undefined;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = undefined;
    }
  }
}
