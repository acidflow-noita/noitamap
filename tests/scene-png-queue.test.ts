import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishSceneBitmap,
  ScenePngEncodingQueue,
} from "../src/telescope/scene-png-queue";

function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function canvasFixture(width = 2, height = 2) {
  const encoding = barrier<Blob>();
  const writes = { width: [] as number[], height: [] as number[] };
  const convertToBlob = vi.fn(
    (_options?: ImageEncodeOptions) => encoding.promise,
  );
  const canvas = {
    get width() {
      return width;
    },
    set width(value: number) {
      writes.width.push(value);
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      writes.height.push(value);
      height = value;
    },
    convertToBlob,
  };
  return { canvas, encoding, convertToBlob, writes };
}

function expectReleased(fixture: ReturnType<typeof canvasFixture>) {
  expect([fixture.canvas.width, fixture.canvas.height]).toEqual([0, 0]);
  for (const writes of Object.values(fixture.writes)) {
    expect(writes.length).toBeLessThanOrEqual(1);
    expect(writes.every((value) => value === 0)).toBe(true);
  }
}

const blob = () => new Blob(["png"], { type: "image/png" });
const asOffscreen = (canvas: ReturnType<typeof canvasFixture>["canvas"]) =>
  canvas as unknown as OffscreenCanvas;
const bitmapFixture = () =>
  ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap;

// Drain promise continuations without granting either a frame or a task.
async function microtasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

let frames: Map<number, FrameRequestCallback>;
function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}
async function task() {
  vi.runOnlyPendingTimers();
  await microtasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  let sequence = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ScenePngEncodingQueue", () => {
  it("waits for afterPaint, a frame, and a later task before encoding", async () => {
    const queue = new ScenePngEncodingQueue({ maxBytes: 16 });
    const batch = queue.batch(),
      image = canvasFixture(),
      persist = vi.fn();
    expect(batch.enqueue(image.canvas, persist)).toBe(true);
    expect(queue.stats).toMatchObject({ bytes: 16, queued: 1, active: 0 });
    await microtasks();
    await task();
    expect(image.convertToBlob).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);

    batch.afterPaint();
    await microtasks();
    expect(frames.size).toBe(1);
    expect(image.convertToBlob).not.toHaveBeenCalled();
    paint();
    await microtasks();
    expect(image.convertToBlob).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();

    await task();
    expect(image.convertToBlob).toHaveBeenCalledOnce();
    expect(image.convertToBlob).toHaveBeenCalledWith({ type: "image/png" });
    expect(queue.stats).toMatchObject({ bytes: 16, queued: 0, active: 1 });
    const encoded = blob();
    image.encoding.resolve(encoded);
    await microtasks();
    expect(persist).toHaveBeenCalledExactlyOnceWith(encoded);
    expectReleased(image);
    expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
  });

  it("does not encode an unpainted batch when another batch has passed its paint gate", async () => {
    const queue = new ScenePngEncodingQueue();
    const first = queue.batch(),
      second = queue.batch();
    const a = canvasFixture(),
      b = canvasFixture();
    first.enqueue(a.canvas, vi.fn());
    second.enqueue(b.canvas, vi.fn());
    first.afterPaint();
    paint();
    await task();
    a.encoding.resolve(blob());
    await microtasks();
    await task();
    expect(b.convertToBlob).not.toHaveBeenCalled();
    expect(queue.stats).toMatchObject({ bytes: 16, queued: 1, active: 0 });

    second.afterPaint();
    paint();
    await microtasks();
    expect(b.convertToBlob).not.toHaveBeenCalled();
    await task();
    expect(b.convertToBlob).toHaveBeenCalledOnce();
    b.encoding.resolve(blob());
    await microtasks();
    expectReleased(a);
    expectReleased(b);
  });

  it("serializes encoders and yields a task between jobs, including after failure", async () => {
    const onError = vi.fn(),
      queue = new ScenePngEncodingQueue({ onError });
    const batch = queue.batch(),
      images = [canvasFixture(), canvasFixture(), canvasFixture()];
    const persists = images.map(() => vi.fn());
    images.forEach((image, index) =>
      batch.enqueue(image.canvas, persists[index]),
    );
    batch.afterPaint();
    paint();
    await task();
    expect(
      images.map((image) => image.convertToBlob.mock.calls.length),
    ).toEqual([1, 0, 0]);
    await task();
    expect(
      images.map((image) => image.convertToBlob.mock.calls.length),
    ).toEqual([1, 0, 0]);

    images[0].encoding.resolve(blob());
    await microtasks();
    expect(images[1].convertToBlob).not.toHaveBeenCalled();
    await task();
    expect(
      images.map((image) => image.convertToBlob.mock.calls.length),
    ).toEqual([1, 1, 0]);
    const failure = new Error("PNG encoder failed");
    images[1].encoding.reject(failure);
    await microtasks();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(persists[1]).not.toHaveBeenCalled();
    expect(images[2].convertToBlob).not.toHaveBeenCalled();
    await task();
    expect(images[2].convertToBlob).toHaveBeenCalledOnce();
    images[2].encoding.resolve(blob());
    await microtasks();
    expect(persists[0]).toHaveBeenCalledOnce();
    expect(persists[2]).toHaveBeenCalledOnce();
    images.forEach(expectReleased);
    expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
  });

  it("charges queued and active RGBA bytes against one admission budget", async () => {
    const queue = new ScenePngEncodingQueue({ maxBytes: 32 }),
      batch = queue.batch();
    const active = canvasFixture(),
      pending = canvasFixture(),
      rejected = canvasFixture();
    expect(batch.enqueue(active.canvas, vi.fn())).toBe(true);
    expect(batch.enqueue(pending.canvas, vi.fn())).toBe(true);
    expect(batch.enqueue(rejected.canvas, vi.fn())).toBe(false);
    expectReleased(rejected);
    expect(rejected.convertToBlob).not.toHaveBeenCalled();
    batch.afterPaint();
    paint();
    await task();
    expect(queue.stats).toMatchObject({ bytes: 32, queued: 1, active: 1 });
    const whileActive = canvasFixture();
    expect(batch.enqueue(whileActive.canvas, vi.fn())).toBe(false);
    expectReleased(whileActive);
    active.encoding.resolve(blob());
    await microtasks();
    expect(queue.stats.bytes).toBe(16);
    const replacement = canvasFixture();
    expect(batch.enqueue(replacement.canvas, vi.fn())).toBe(true);
    batch.cancel();
    [active, pending, replacement].forEach(expectReleased);
    expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
  });

  it.each(["throws", "rejects"])(
    "continues with the next image when optional persistence %s",
    async (outcome) => {
      const onError = vi.fn(),
        queue = new ScenePngEncodingQueue({ onError }),
        batch = queue.batch();
      const first = canvasFixture(),
        next = canvasFixture(),
        failure = new Error("cache unavailable");
      const failedPersist = vi.fn(() => {
        if (outcome === "throws") throw failure;
        return Promise.reject(failure);
      });
      const nextPersist = vi.fn();
      batch.enqueue(first.canvas, failedPersist);
      batch.enqueue(next.canvas, nextPersist);
      batch.afterPaint();
      paint();
      await task();
      first.encoding.resolve(blob());
      await microtasks();
      expect(failedPersist).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expectReleased(first);
      expect(next.convertToBlob).not.toHaveBeenCalled();
      await task();
      expect(next.convertToBlob).toHaveBeenCalledOnce();
      next.encoding.resolve(blob());
      await microtasks();
      expect(nextPersist).toHaveBeenCalledOnce();
      expectReleased(next);
      expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
    },
  );

  it.each([
    ["zero width", 0, 2],
    ["negative height", 2, -1],
    ["nonfinite width", Infinity, 2],
    ["NaN height", 2, NaN],
    ["unsafe dimensions", Number.MAX_SAFE_INTEGER, 2],
    ["oversize image", 3, 2],
  ])("takes ownership and immediately releases %s", (_label, width, height) => {
    const queue = new ScenePngEncodingQueue({ maxBytes: 16 }),
      batch = queue.batch();
    const image = canvasFixture(width as number, height as number),
      persist = vi.fn();
    expect(batch.enqueue(image.canvas, persist)).toBe(false);
    expectReleased(image);
    expect(image.convertToBlob).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
  });

  it.each(["before frame", "after frame"])(
    "cancels pending canvases immediately %s and ignores stale callbacks",
    async (when) => {
      const queue = new ScenePngEncodingQueue(),
        batch = queue.batch();
      const images = [canvasFixture(), canvasFixture()],
        persist = vi.fn();
      images.forEach((image) => batch.enqueue(image.canvas, persist));
      batch.afterPaint();
      const staleFrames = [...frames.values()];
      if (when === "after frame") paint();
      batch.cancel();
      batch.cancel();
      images.forEach(expectReleased);
      expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
      staleFrames.forEach((callback) => callback(0));
      await task();
      images.forEach((image) =>
        expect(image.convertToBlob).not.toHaveBeenCalled(),
      );
      expect(persist).not.toHaveBeenCalled();
      const late = canvasFixture();
      expect(batch.enqueue(late.canvas, persist)).toBe(false);
      batch.afterPaint();
      paint();
      await task();
      expectReleased(late);
      expect(late.convertToBlob).not.toHaveBeenCalled();
    },
  );

  it("retains a cancelled encoder slot and budget until settlement and discards its blob", async () => {
    const queue = new ScenePngEncodingQueue({ maxBytes: 32 });
    const obsolete = queue.batch(),
      current = queue.batch();
    const active = canvasFixture(),
      pending = canvasFixture(),
      next = canvasFixture();
    const obsoletePersist = vi.fn(),
      currentPersist = vi.fn();
    obsolete.enqueue(active.canvas, obsoletePersist);
    obsolete.enqueue(pending.canvas, obsoletePersist);
    obsolete.afterPaint();
    paint();
    await task();
    obsolete.cancel();
    obsolete.cancel();
    expectReleased(active);
    expectReleased(pending);
    expect(queue.stats).toMatchObject({ bytes: 16, queued: 0, active: 1 });

    expect(current.enqueue(next.canvas, currentPersist)).toBe(true);
    const excess = canvasFixture();
    expect(current.enqueue(excess.canvas, currentPersist)).toBe(false);
    expectReleased(excess);
    current.afterPaint();
    paint();
    await task();
    expect(next.convertToBlob).not.toHaveBeenCalled();
    expect(queue.stats).toMatchObject({ bytes: 32, queued: 1, active: 1 });

    active.encoding.resolve(blob());
    await microtasks();
    expect(obsoletePersist).not.toHaveBeenCalled();
    expect(next.convertToBlob).not.toHaveBeenCalled();
    expect(queue.stats).toMatchObject({ bytes: 16, queued: 1, active: 0 });
    await task();
    expect(next.convertToBlob).toHaveBeenCalledOnce();
    next.encoding.resolve(blob());
    await microtasks();
    expect(currentPersist).toHaveBeenCalledOnce();
    [active, pending, next].forEach(expectReleased);
    expect(queue.stats).toMatchObject({ bytes: 0, queued: 0, active: 0 });
  });
});

describe("finishSceneBitmap", () => {
  it("creates the bitmap before handing canvas ownership to deferred work", async () => {
    const image = canvasFixture(),
      bitmap = bitmapFixture(),
      creation = barrier<ImageBitmap>();
    const create = vi.fn((_canvas: ImageBitmapSource) => creation.promise),
      defer = vi.fn();
    vi.stubGlobal("createImageBitmap", create);
    const result = finishSceneBitmap(asOffscreen(image.canvas), defer);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBe(image.canvas);
    expect(defer).not.toHaveBeenCalled();
    expect(image.convertToBlob).not.toHaveBeenCalled();
    creation.resolve(bitmap);
    await expect(result).resolves.toEqual({ bitmap, blob: null });
    expect(defer).toHaveBeenCalledExactlyOnceWith(image.canvas);
    expect(image.convertToBlob).not.toHaveBeenCalled();
    expect(image.writes).toEqual({ width: [], height: [] });
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it.each(["stalled", "rejected"])(
    "delivers the bitmap independently of a %s deferred encoder",
    async (outcome) => {
      const image = canvasFixture(),
        bitmap = bitmapFixture(),
        onError = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => bitmap),
      );
      const queue = new ScenePngEncodingQueue({ onError }),
        batch = queue.batch();
      const delivered = vi.fn(),
        persist = vi.fn();
      const result = finishSceneBitmap(asOffscreen(image.canvas), (canvas) => {
        batch.enqueue(canvas, persist);
      }).then(delivered);
      await microtasks();
      expect(delivered).toHaveBeenCalledExactlyOnceWith({ bitmap, blob: null });
      await result;
      expect(image.convertToBlob).not.toHaveBeenCalled();
      batch.afterPaint();
      paint();
      await task();
      expect(image.convertToBlob).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();

      if (outcome === "rejected") {
        const failure = new Error("deferred PNG failed");
        image.encoding.reject(failure);
        await microtasks();
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      } else {
        batch.cancel();
        image.encoding.resolve(blob());
        await microtasks();
      }
      expectReleased(image);
      expect(delivered).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();
      expect(bitmap.close).not.toHaveBeenCalled();
    },
  );

  it("preserves inline encoding when no deferred owner is supplied", async () => {
    const image = canvasFixture(),
      bitmap = bitmapFixture(),
      delivered = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    const result = finishSceneBitmap(asOffscreen(image.canvas)).then(delivered);
    await microtasks();
    expect(image.convertToBlob).toHaveBeenCalledExactlyOnceWith({
      type: "image/png",
    });
    expect(delivered).not.toHaveBeenCalled();
    const encoded = blob();
    image.encoding.resolve(encoded);
    await result;
    expect(delivered).toHaveBeenCalledExactlyOnceWith({
      bitmap,
      blob: encoded,
    });
    expectReleased(image);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("keeps the bitmap usable when inline encoding rejects and reports the failure", async () => {
    const image = canvasFixture(),
      bitmap = bitmapFixture(),
      onError = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    const result = finishSceneBitmap(
      asOffscreen(image.canvas),
      undefined,
      onError,
    );
    await microtasks();
    const failure = new Error("inline PNG failed");
    image.encoding.reject(failure);
    await expect(result).resolves.toEqual({ bitmap, blob: null });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expectReleased(image);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("releases the canvas and propagates bitmap creation failure without encoding", async () => {
    const image = canvasFixture(),
      failure = new Error("bitmap creation failed"),
      defer = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(
      finishSceneBitmap(asOffscreen(image.canvas), defer),
    ).rejects.toBe(failure);
    expectReleased(image);
    expect(defer).not.toHaveBeenCalled();
    expect(image.convertToBlob).not.toHaveBeenCalled();
  });
});
