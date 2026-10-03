import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerrainWorkerPool,
  terrainWorkerLimit,
  type TerrainWorkerPort,
} from "../src/telescope/terrain-worker-pool";

class WorkerDouble implements TerrainWorkerPort {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  messages: { data: any; transfer: Transferable[] }[] = [];
  terminated = false;
  postMessage(data: any, transfer: Transferable[] = []) {
    this.messages.push({ data, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  respond(data: any) {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent);
  }
  ready() {
    const { data } = this.messages.at(-1)!;
    expect(data.type).toBe("init");
    this.respond({
      id: data.id,
      type: "ready",
      mapWidth: 70,
      centerPx: 17920,
      stats: {},
    });
  }
  tile() {
    const { data } = this.messages.at(-1)!;
    expect(["render", "present"]).toContain(data.type);
    this.respond({
      id: data.id,
      type: "tile",
      width: data.width,
      height: data.height,
      pixels: new ArrayBuffer(data.width * data.height * 4),
    });
  }
}
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(limit = 4) {
  const workers: WorkerDouble[] = [];
  const pool = new TerrainWorkerPool(limit, () => {
    const w = new WorkerDouble();
    workers.push(w);
    return w;
  });
  const contexts = [0, -1, 1].map((plane) =>
    pool.context({
      plane,
      tileLayers: [{ buffer: new Uint8Array([1, 2, 3]).buffer }],
    }),
  );
  releases.push(() => contexts.forEach((c) => pool.release(c)));
  const render = (
    context = contexts[0],
    x = 0,
    priority = () => 0,
    signal = new AbortController().signal,
    pixels?: Uint8ClampedArray,
  ) =>
    pool.render(
      context,
      { x, y: 512, width: 2, height: 2, pixels },
      signal,
      priority,
    );
  return { workers, pool, contexts, render };
}
describe("page-wide terrain worker pool", () => {
  it("runs multiple tiles simultaneously without multiplying the cap per plane", async () => {
    const { pool, contexts, workers, render } = fixture(4);
    const jobs = Array.from({ length: 7 }, (_, i) =>
      render(contexts[i % 3], i),
    );
    expect(workers).toHaveLength(4);
    workers.forEach((w) => w.ready());
    expect(pool.stats).toMatchObject({ busy: 4, queued: 3, peakRendering: 4 });
    // No tile has completed, yet four real render requests have been sent.
    expect(workers.map((w) => w.messages.at(-1)!.data.type)).toEqual([
      "render",
      "render",
      "render",
      "render",
    ]);
    while (pool.stats.busy) {
      for (const w of workers.filter((w) => !w.terminated)) {
        const message = w.messages.at(-1)?.data;
        if (message?.type === "init") w.ready();
        else if (["render", "present"].includes(message?.type)) {
          w.tile();
          // Mark a completed idle slot so this test doesn't replay its response.
          if (w.messages.at(-1)?.data === message)
            w.messages.push({ data: { type: "test-idle" }, transfer: [] });
        }
      }
    }
    expect(await Promise.all(jobs)).toHaveLength(7);
    expect(pool.stats).toMatchObject({ workers: 4, completed: 7, queued: 0 });
  });
  it("reuses initialized resources and reprioritizes queued tiles as the viewport moves", async () => {
    const { pool, contexts, workers, render } = fixture(1);
    const first = render(contexts[0], 0);
    workers[0].ready();
    let near = 100,
      far = 200;
    const a = render(contexts[0], 1, () => near),
      b = render(contexts[0], 2, () => far);
    far = -10;
    workers[0].tile();
    await first;
    expect(workers[0].messages.at(-1)!.data.x).toBe(2);
    workers[0].tile();
    await b;
    expect(workers[0].messages.at(-1)!.data.x).toBe(1);
    workers[0].tile();
    await a;
    expect(
      workers[0].messages.filter((m) => m.data.type === "init"),
    ).toHaveLength(1);
    expect(pool.stats.completed).toBe(3);
  });
  it("clones source buffers for every worker and transfers only disposable tile pixels", async () => {
    const { contexts, workers, render } = fixture(2);
    const a = render(),
      pixels = new Uint8ClampedArray(16),
      b = render(contexts[0], 1, () => 0, new AbortController().signal, pixels);
    expect(workers).toHaveLength(2);
    for (const w of workers) {
      expect(w.messages[0].transfer).toEqual([]);
      w.ready();
    }
    expect(contexts[0].generation.tileLayers[0].buffer.byteLength).toBe(3);
    expect(workers[1].messages.at(-1)!.data.type).toBe("present");
    expect(workers[1].messages.at(-1)!.transfer).toEqual([pixels.buffer]);
    workers.forEach((w) => w.tile());
    await Promise.all([a, b]);
  });
  it("does not let an aborted tile cancel independent work on another worker", async () => {
    const { pool, contexts, workers, render } = fixture(2),
      controller = new AbortController();
    const a = render(contexts[0], 0, () => 0, controller.signal),
      b = render(contexts[0], 1);
    workers.forEach((w) => w.ready());
    controller.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].messages.at(-1)!.data.type).toBe("cancel");
    workers[0].respond({
      id: workers[0].messages.at(-1)!.data.id,
      type: "cancelled",
    });
    workers[1].tile();
    await b;
    expect(pool.stats.busy).toBe(0);
  });
  it("cancels queued work and terminates all workers on a seed change", async () => {
    const { pool, contexts, workers, render } = fixture(2);
    const jobs = [render(), render(), render()];
    const results = Promise.allSettled(jobs);
    pool.release(contexts[0]);
    expect((await results).every((r) => r.status === "rejected")).toBe(true);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(pool.stats).toMatchObject({ busy: 0, workers: 0, queued: 0 });
    workers[0].respond({ id: 1, type: "ready" }); // stale replies cannot restart old work
    expect(pool.stats.workers).toBe(0);
  });
  it("rejects worker startup failures rather than leaving initialization hanging", async () => {
    vi.useFakeTimers();
    const { pool, contexts, workers } = fixture(1);
    const pending = pool.ready(contexts[0], new AbortController().signal);
    const check = expect(pending).rejects.toThrow("initialization timed out");
    await vi.advanceTimersByTimeAsync(60001);
    await check;
    expect(workers[0].terminated).toBe(true);
    expect(pool.stats.busy).toBe(0);
  });
});
describe("hardware/memory worker budget", () => {
  beforeEach(() => vi.stubGlobal("navigator", {}));
  it.each([
    [1, 8, 1],
    [2, 8, 1],
    [4, 8, 3],
    [8, 8, 6],
    [16, 8, 6],
    [32, 8, 6],
    [16, 4, 2],
    [16, 2, 1],
    [8, undefined, 4],
    [undefined, undefined, 3],
    [NaN, NaN, 3],
  ])(
    "uses a bounded total pool for cores=%s, memory=%s",
    (cores, memory, wanted) =>
      expect(terrainWorkerLimit(cores, memory)).toBe(wanted),
  );
});
