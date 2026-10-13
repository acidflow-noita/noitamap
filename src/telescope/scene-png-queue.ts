interface EncodingCanvas {
  width: number;
  height: number;
  convertToBlob(options: { type: string }): Promise<Blob>;
}

type Persist = (blob: Blob) => unknown | Promise<unknown>;
type Batch = {
  cancelled: boolean;
  ready: boolean;
  scheduled: boolean;
  frame?: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Job = {
  batch: Batch;
  canvas: EncodingCanvas;
  persist: Persist;
  bytes: number;
  released: boolean;
};

export interface ScenePngEncodingBatch {
  /** Always takes ownership, including when optional caching is declined. */
  enqueue(canvas: EncodingCanvas, persist: Persist): boolean;
  /** Call after both scene attachment and the first painted frame. */
  afterPaint(): void;
  cancel(): void;
}

function releaseCanvas(canvas: EncodingCanvas): void {
  if (canvas.width !== 0) canvas.width = 0;
  if (canvas.height !== 0) canvas.height = 0;
}

/** Serial optional persistence. The budget includes an active encoder, whose
 * native operation cannot be aborted even when its generation is cancelled. */
export class ScenePngEncodingQueue {
  private jobs: Job[] = [];
  private active?: Job;
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly maxBytes: number;
  private readonly onError?: (error: unknown) => void;

  constructor(
    options: { maxBytes?: number; onError?: (error: unknown) => void } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0)
      throw new RangeError("Invalid scene encoding budget");
    this.onError = options.onError;
  }

  get stats() {
    return {
      bytes: this.bytes,
      queued: this.jobs.length,
      active: this.active ? 1 : 0,
    };
  }

  batch(): ScenePngEncodingBatch {
    const batch: Batch = { cancelled: false, ready: false, scheduled: false };
    return {
      enqueue: (canvas, persist) => {
        const bytes = canvas.width * canvas.height * 4;
        if (
          batch.cancelled ||
          !Number.isSafeInteger(bytes) ||
          bytes <= 0 ||
          !Number.isSafeInteger(canvas.width) ||
          !Number.isSafeInteger(canvas.height) ||
          canvas.width <= 0 ||
          canvas.height <= 0 ||
          bytes > this.maxBytes - this.bytes
        ) {
          releaseCanvas(canvas);
          return false;
        }
        this.jobs.push({ batch, canvas, persist, bytes, released: false });
        this.bytes += bytes;
        this.schedule();
        return true;
      },
      afterPaint: () => {
        if (batch.cancelled || batch.scheduled) return;
        batch.scheduled = true;
        const afterFrame = () => {
          batch.frame = undefined;
          if (batch.cancelled) return;
          // OSD can notify inside an animation-frame callback. A subsequent
          // frame followed by a task gives the browser a paint opportunity;
          // a promise continuation in that callback would run before paint.
          batch.timer = setTimeout(() => {
            batch.timer = undefined;
            if (batch.cancelled) return;
            batch.ready = true;
            this.pump();
          }, 0);
        };
        if (typeof requestAnimationFrame === "function")
          batch.frame = requestAnimationFrame(afterFrame);
        else afterFrame();
      },
      cancel: () => {
        if (batch.cancelled) return;
        batch.cancelled = true;
        if (batch.frame !== undefined)
          globalThis.cancelAnimationFrame?.(batch.frame);
        clearTimeout(batch.timer);
        this.jobs = this.jobs.filter((job) => {
          if (job.batch !== batch) return true;
          this.release(job);
          this.bytes -= job.bytes;
          return false;
        });
        if (this.active?.batch === batch) {
          // Discard its eventual result and release our canvas now. Keep the
          // slot/budget until the uncancellable encoder settles, so repeatedly
          // replacing a seed cannot start unbounded native encoding work.
          this.release(this.active);
        }
      },
    };
  }

  private release(job: Job): void {
    if (job.released) return;
    job.released = true;
    releaseCanvas(job.canvas);
  }

  private schedule(): void {
    if (
      this.active ||
      this.timer !== undefined ||
      !this.jobs.some((job) => job.batch.ready)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 0);
  }

  private pump(): void {
    if (this.active) return;
    const index = this.jobs.findIndex(
      (job) => job.batch.ready && !job.batch.cancelled,
    );
    if (index < 0) return;
    const [job] = this.jobs.splice(index, 1);
    this.active = job;
    void (async () => {
      try {
        const blob = await job.canvas.convertToBlob({ type: "image/png" });
        this.release(job);
        if (!job.batch.cancelled) await job.persist(blob);
      } catch (error) {
        if (!job.batch.cancelled) {
          try {
            this.onError?.(error);
          } catch {
            /* Optional diagnostics cannot stall the queue. */
          }
        }
      } finally {
        this.release(job);
        this.bytes -= job.bytes;
        this.active = undefined;
        this.schedule();
      }
    })();
  }
}

/** Snapshot display pixels first. Live callers hand the original canvas to a
 * bounded queue; offline/background callers await inline persistence.
 * Encoding never round-trips the ImageBitmap back through another canvas. */
export async function finishSceneBitmap(
  canvas: OffscreenCanvas,
  defer?: (canvas: OffscreenCanvas) => void,
  onError?: (error: unknown) => void,
): Promise<{ bitmap: ImageBitmap; blob: Blob | null }> {
  let transferred = false;
  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      /* Persistence diagnostics cannot reject a ready bitmap. */
    }
  };
  try {
    const bitmap = await createImageBitmap(canvas);
    let blob: Blob | null = null;
    if (defer) {
      try {
        defer(canvas);
        transferred = true;
      } catch (error) {
        report(error);
      }
    } else {
      try {
        blob = await canvas.convertToBlob({ type: "image/png" });
      } catch (error) {
        report(error);
      }
    }
    return { bitmap, blob };
  } finally {
    if (!transferred) releaseCanvas(canvas);
  }
}
