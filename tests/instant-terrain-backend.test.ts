import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../src/telescope/terrain-shader-prewarm", () => ({
  prewarmTerrainShader: async () => {},
}));

class TestWorker {
  static instances: TestWorker[] = [];
  static initError = false;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(data: any) {
    this.sent.push(data);
    if (
      data.type === "prewarm" ||
      data.type === "init" ||
      data.type === "invalidate"
    )
      queueMicrotask(() =>
        this.reply({
          id: data.id,
          resourceMs: 10,
          ...(data.type === "init" && TestWorker.initError
            ? { error: "WebGL2 unavailable in worker" }
            : {}),
        }),
      );
  }
  reply(data: any) {
    this.onmessage?.({ data });
  }
}
beforeEach(() => {
  vi.resetModules();
  TestWorker.instances = [];
  TestWorker.initError = false;
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
});
afterEach(() => vi.unstubAllGlobals());

function generation(seed = 1) {
  return {
    seed,
    isNGP: false,
    tileLayers: [
      {
        buffer: new Uint8Array([1, 2, 3]),
        biomeName: "mine",
        validChunks: new Set(["1,2"]),
      },
    ],
    biomeData: { pixels: new Uint32Array(70 * 48) },
  };
}
const deps = () => {
  const invalidate = vi.fn(),
    render = vi.fn(() => "canvas"),
    build = vi.fn(() => true);
  class Renderer {
    engineReady = true;
    gl = { getError: () => 0 };
    program = {};
    invalidate = invalidate;
    render = render;
    ensureResources = build;
  }
  return {
    GLTerrainRenderer: Renderer,
    initMaterialAtlas: async () => {},
    getWorldSize: () => 70,
    getWorldCenter: () => 35,
    GENERATOR_CONFIG: {},
    invalidate,
    render,
    build,
  };
};

it("prewarms once before generation, coalesces early/final objects, and cannot invalidate a newer seed", async () => {
  const { prewarmInstantTerrain, prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  prewarmInstantTerrain();
  prewarmInstantTerrain();
  const d = deps(),
    gen = generation();
  const [early, final] = await Promise.all([
    prepareInstantTerrain(gen, d),
    prepareInstantTerrain({ ...gen }, d),
  ]);
  expect(early).toBe(final);
  const worker = TestWorker.instances[0];
  expect(worker.sent.map((x) => x.type)).toEqual(["prewarm", "init"]);
  expect(worker.sent[1].generation.tileLayers[0].buffer).not.toBe(
    gen.tileLayers[0].buffer.buffer,
  );
  const next = await prepareInstantTerrain(generation(2), d);
  early.invalidate();
  expect(worker.sent.map((x) => x.type)).toEqual(["prewarm", "init", "init"]);
  await expect(early.render({})).rejects.toThrow("Obsolete");
  const bitmap = { close: vi.fn() };
  const drawing = next.render({ width: 256 });
  worker.reply({ id: worker.sent.at(-1).id, bitmap });
  expect(await drawing).toBe(bitmap);
  next.invalidate();
  expect(worker.sent.at(-1).type).toBe("invalidate");
});

it("cancels obsolete tile RPCs and closes transferred bitmaps which arrive afterward", async () => {
  const { InstantTerrainWorkerClient } =
    await import("../src/telescope/instant-terrain-backend");
  const worker = new TestWorker();
  const client = new InstantTerrainWorkerClient(worker as any);
  const abort = new AbortController();
  const result = client.request("render", {}, abort.signal);
  const rejected = expect(result).rejects.toThrow("cancelled");
  abort.abort(new Error("cancelled"));
  await rejected;
  expect(worker.sent.at(-1).type).toBe("cancel");
  const bitmap = { close: vi.fn() };
  worker.reply({ id: worker.sent[0].id, bitmap });
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it("rejects pending tile work when the worker fails", async () => {
  const { InstantTerrainWorkerClient } =
    await import("../src/telescope/instant-terrain-backend");
  const worker = new TestWorker();
  const client = new InstantTerrainWorkerClient(worker as any);
  const result = client.request("render");
  const rejected = expect(result).rejects.toThrow("context died");
  worker.onerror?.({ message: "context died" });
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(client.request("render")).rejects.toThrow("context died");
});

it("terminates a hung worker and rejects every pending request at its deadline", async () => {
  const { InstantTerrainWorkerClient } =
    await import("../src/telescope/instant-terrain-backend");
  const worker = new TestWorker();
  const client = new InstantTerrainWorkerClient(worker as any, 10);
  const first = expect(client.request("render")).rejects.toThrow("timed out");
  const second = expect(client.request("render")).rejects.toThrow("timed out");
  await Promise.all([first, second]);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("gives admitted renders a shorter deadline than OSD's thirty-second ImageJob", async () => {
  vi.useFakeTimers();
  try {
    const { InstantTerrainWorkerClient } = await import("../src/telescope/instant-terrain-backend");
    const worker = new TestWorker(), client = new InstantTerrainWorkerClient(worker as any);
    const rendering = expect(client.request("render")).rejects.toThrow("render timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await rendering;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("does not let cancelled requests hide an unresponsive worker from its watchdog", async () => {
  vi.useFakeTimers();
  try {
    const { InstantTerrainWorkerClient } = await import("../src/telescope/instant-terrain-backend");
    const worker = new TestWorker(), client = new InstantTerrainWorkerClient(worker as any, 100);
    const abort = new AbortController();
    const rendering = expect(client.request("render", {}, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await rendering;
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(String(client.failed)).toContain("render timed out");
    const bitmap = { close: vi.fn() };
    worker.reply({ id: worker.sent[0].id, bitmap });
    expect(bitmap.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("clears a cancelled render's watchdog when the healthy worker acknowledges it", async () => {
  vi.useFakeTimers();
  try {
    const { InstantTerrainWorkerClient } = await import("../src/telescope/instant-terrain-backend");
    const worker = new TestWorker(), client = new InstantTerrainWorkerClient(worker as any);
    const abort = new AbortController();
    const rendering = expect(client.request("render", {}, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await rendering;
    worker.reply({ id: worker.sent[0].id, error: "Terrain request cancelled" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(client.failed).toBeNull();
    const next = client.request("render"), bitmap = { close: vi.fn() };
    worker.reply({ id: worker.sent.at(-1).id, bitmap });
    expect((await next).bitmap).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("retains the thirty-second cold initialization deadline", async () => {
  vi.useFakeTimers();
  try {
    const { InstantTerrainWorkerClient } = await import("../src/telescope/instant-terrain-backend");
    const worker = new TestWorker();
    worker.postMessage = data => { worker.sent.push(data); };
    const client = new InstantTerrainWorkerClient(worker as any);
    const initialization = expect(client.request("init")).rejects.toThrow("init timed out");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await initialization;
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("releases even prewarm-only workers when dynamic maps close", async () => {
  const {
    prewarmInstantTerrain,
    releaseInstantTerrainBackend,
    prepareInstantTerrain,
  } = await import("../src/telescope/instant-terrain-backend");
  prewarmInstantTerrain();
  const old = TestWorker.instances[0];
  releaseInstantTerrainBackend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(old.terminate).toHaveBeenCalled();
  const renderer = await prepareInstantTerrain(generation(), deps());
  expect(renderer.backend).toBe("worker");
  expect(TestWorker.instances).toHaveLength(2);
  releaseInstantTerrainBackend();
  await expect(renderer.render({})).rejects.toThrow("Obsolete");
});

it("falls back to the regular canvas after worker resource failure", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  TestWorker.initError = true;
  const d = deps();
  const handle = await prepareInstantTerrain(generation(), d);
  expect(handle.backend).toBe("main");
  expect(d.build).toHaveBeenCalledOnce();
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  expect(handle.render({})).toBe("canvas");
  const next = await prepareInstantTerrain(generation(2), d);
  handle.invalidate();
  expect(d.invalidate).not.toHaveBeenCalled();
  next.invalidate();
  expect(d.invalidate).toHaveBeenCalledOnce();
  expect(TestWorker.instances).toHaveLength(1);
});
