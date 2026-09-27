import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../src/telescope/terrain-shader-prewarm", () => ({
  prewarmTerrainShader: async () => {},
}));
// The native resource suite verifies real GL texture ownership and pixels.
// This fake keeps backend lifecycle tests independent of game assets and GL.
vi.mock("../src/telescope/shared-instant-terrain", () => ({
  SharedInstantTerrainResources: class {
    constructor(readonly renderer: any) {}
    get stats() { return { planeCount: 3 }; }
    async ensureResources(...args: any[]) { return this.renderer.ensureResources(...args); }
    setPlane(plane: number) { this.renderer.setPlane(plane); }
    render(view: any) { return this.renderer.render(view); }
    invalidate() { this.renderer.invalidate(); }
  },
}));

class TestWorker {
  static instances: TestWorker[] = [];
  static initError = false;
  static holdInit = false;
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
    if (data.type === "init" && TestWorker.holdInit) return;
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
  TestWorker.holdInit = false;
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
    build = vi.fn(() => true),
    setPlane = vi.fn(),
    deleteProgram = vi.fn(),
    loseContext = vi.fn();
  const renderers: any[] = [];
  class Renderer {
    constructor() { renderers.push(this); }
    engineReady = true;
    gl = { getError: () => 0, deleteProgram, getExtension: () => ({ loseContext }) };
    program = {};
    invalidate = invalidate;
    render = render;
    setPlane = setPlane;
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
    setPlane,
    renderers,
    deleteProgram,
    loseContext,
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

it("shares one initialization while keeping each plane's queued render independent", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  const gen = generation(), d = deps();
  const planes = [0, -1, 1] as const;
  const handles = await Promise.all(planes.map(plane => prepareInstantTerrain(gen, d, plane)));
  const repeated = await Promise.all(planes.map(plane => prepareInstantTerrain({ ...gen }, d, plane)));
  expect(new Set(handles).size).toBe(3);
  expect(repeated).toEqual(handles);
  expect(TestWorker.instances).toHaveLength(1);
  const worker = TestWorker.instances[0];
  expect(worker.sent.map(message => message.type)).toEqual(["prewarm", "init"]);

  const drawings = handles.map((handle, index) => handle.render({ width: 256, x: index }));
  const requests = worker.sent.filter(message => message.type === "render");
  expect(requests.map(message => message.plane)).toEqual(planes);
  expect(new Set(requests.map(message => message.token)).size).toBe(1);
  const bitmaps = requests.map(() => ({ close: vi.fn() }));
  // Replies can arrive after another plane has queued its draw. Each facade
  // must still resolve its own transfer, without shared mutable plane state.
  for (let index = requests.length - 1; index >= 0; index--)
    worker.reply({ id: requests[index].id, bitmap: bitmaps[index] });
  expect(await Promise.all(drawings)).toEqual(bitmaps);
  for (const bitmap of bitmaps) expect(bitmap.close).not.toHaveBeenCalled();

  handles[1].invalidate();
  handles[0].invalidate();
  handles[2].invalidate();
  expect(worker.sent.filter(message => message.type === "invalidate")).toHaveLength(1);
  for (const handle of handles) await expect(handle.render({})).rejects.toThrow("Obsolete");
});

it("retires every old plane on reseed and closes a tile returned by the old generation", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  const gen = generation(), d = deps();
  const old = await Promise.all(([0, -1, 1] as const).map(plane => prepareInstantTerrain(gen, d, plane)));
  const worker = TestWorker.instances[0];
  const pending = old[1].render({ width: 256 });
  const rejected = expect(pending).rejects.toThrow("Obsolete");
  const oldRequest = worker.sent.at(-1);
  const next = await prepareInstantTerrain(generation(2), d, 1);
  const bitmap = { close: vi.fn() };
  worker.reply({ id: oldRequest.id, bitmap });
  await rejected;
  expect(bitmap.close).toHaveBeenCalledOnce();
  for (const handle of old) {
    handle.invalidate();
    await expect(handle.render({})).rejects.toThrow("Obsolete");
  }
  expect(worker.sent.filter(message => message.type === "invalidate")).toHaveLength(0);
  expect(worker.sent.filter(message => message.type === "init")).toHaveLength(2);
  const drawing = next.render({ width: 256 });
  expect(worker.sent.at(-1).plane).toBe(1);
  const currentBitmap = { close: vi.fn() };
  worker.reply({ id: worker.sent.at(-1).id, bitmap: currentBitmap });
  expect(await drawing).toBe(currentBitmap);
});

it("does not resurrect a released backend when shared initialization is pending", async () => {
  const { prepareInstantTerrain, releaseInstantTerrainBackend } =
    await import("../src/telescope/instant-terrain-backend");
  TestWorker.holdInit = true;
  const d = deps(), gen = generation();
  const preparations = ([0, -1, 1] as const).map(plane => prepareInstantTerrain(gen, d, plane));
  const rejected = preparations.map(preparation => expect(preparation).rejects.toMatchObject({ name: "AbortError" }));
  await vi.waitFor(() => expect(TestWorker.instances[0]?.sent.some(message => message.type === "init")).toBe(true));
  const worker = TestWorker.instances[0];
  releaseInstantTerrainBackend();
  await Promise.all(rejected);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(d.build).not.toHaveBeenCalled();
  TestWorker.holdInit = false;
  const next = await prepareInstantTerrain(generation(2), d);
  expect(next.backend).toBe("worker");
  expect(TestWorker.instances).toHaveLength(2);
  releaseInstantTerrainBackend();
});

it.each(["signed sibling", "signal-less early preparation"])(
  "does not cancel shared initialization needed by a surviving %s",
  async (consumer) => {
    vi.stubGlobal("Worker", undefined);
    const { prepareInstantTerrain } =
      await import("../src/telescope/instant-terrain-backend");
    const gen = generation(), d = deps();
    let release!: () => void;
    const atlas = new Promise<void>(resolve => { release = resolve; });
    d.initMaterialAtlas = vi.fn(() => atlas);
    const aborted = new AbortController(), sibling = new AbortController();
    const first = prepareInstantTerrain(gen, d, -1, aborted.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const surviving = prepareInstantTerrain(gen, d, 1,
      consumer === "signed sibling" ? sibling.signal : undefined);
    await vi.waitFor(() => expect(d.initMaterialAtlas).toHaveBeenCalledOnce());
    aborted.abort();
    release();
    await rejected;
    const handle = await surviving;
    expect(handle.backend).toBe("main");
    expect(handle.render({})).toBe("canvas");
    expect(d.setPlane).toHaveBeenLastCalledWith(1);
    expect(d.build).toHaveBeenCalledOnce();
    expect(d.renderers).toHaveLength(1);
    expect(d.invalidate).not.toHaveBeenCalled();
  },
);

it("ignores obsolete initialization without falling back or terminating the newer shared worker", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  TestWorker.holdInit = true;
  const d = deps();
  const old = prepareInstantTerrain(generation(), d, -1);
  const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(TestWorker.instances[0]?.sent.filter(message => message.type === "init")).toHaveLength(1));
  const worker = TestWorker.instances[0];
  const next = prepareInstantTerrain(generation(2), d, 1);
  await vi.waitFor(() => expect(worker.sent.filter(message => message.type === "init")).toHaveLength(2));
  const requests = worker.sent.filter(message => message.type === "init");
  worker.reply({ id: requests[0].id, error: "Obsolete terrain generation", errorName: "AbortError" });
  await rejected;
  worker.reply({ id: requests[1].id, resourceMs: 10 });
  const handle = await next;
  expect(handle.backend).toBe("worker");
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(d.build).not.toHaveBeenCalled();
  const drawing = handle.render({});
  const bitmap = { close: vi.fn() };
  worker.reply({ id: worker.sent.at(-1).id, bitmap });
  expect(await drawing).toBe(bitmap);
});

it("fails queued draws from every plane together when the shared context worker dies", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  const gen = generation(), d = deps();
  const handles = await Promise.all(([0, -1, 1] as const).map(plane => prepareInstantTerrain(gen, d, plane)));
  const worker = TestWorker.instances[0];
  const rejected = handles.map(handle => expect(handle.render({})).rejects.toThrow("context died"));
  const requests = worker.sent.filter(message => message.type === "render");
  worker.onerror?.({ message: "context died" });
  await Promise.all(rejected);
  expect(worker.terminate).toHaveBeenCalledOnce();
  for (const handle of handles) await expect(handle.render({})).rejects.toThrow("context died");
  for (const request of requests) {
    const bitmap = { close: vi.fn() };
    worker.reply({ id: request.id, bitmap });
    expect(bitmap.close).toHaveBeenCalledOnce();
  }
});

it("cancels one plane's draw without cancelling sibling planes or their shared resources", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  const gen = generation(), d = deps();
  const handles = await Promise.all(([0, -1, 1] as const).map(plane => prepareInstantTerrain(gen, d, plane)));
  const worker = TestWorker.instances[0], abort = new AbortController();
  const main = handles[0].render({});
  const cancelled = expect(handles[1].render({}, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  const hell = handles[2].render({});
  const requests = worker.sent.filter(message => message.type === "render");
  abort.abort();
  await cancelled;
  expect(worker.sent.at(-1)).toMatchObject({ type: "cancel", id: requests[1].id });
  worker.reply({ id: requests[1].id, error: "Terrain request cancelled", errorName: "AbortError" });
  const mainBitmap = { close: vi.fn() }, hellBitmap = { close: vi.fn() };
  worker.reply({ id: requests[0].id, bitmap: mainBitmap });
  worker.reply({ id: requests[2].id, bitmap: hellBitmap });
  expect(await main).toBe(mainBitmap);
  expect(await hell).toBe(hellBitmap);
  const retry = handles[1].render({});
  const bitmap = { close: vi.fn() };
  worker.reply({ id: worker.sent.at(-1).id, bitmap });
  expect(await retry).toBe(bitmap);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.sent.filter(message => message.type === "invalidate")).toHaveLength(0);
  expect(worker.sent.filter(message => message.type === "init")).toHaveLength(1);
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

it("shares one fallback context and selects each plane immediately before drawing", async () => {
  const { prepareInstantTerrain, releaseInstantTerrainBackend } =
    await import("../src/telescope/instant-terrain-backend");
  TestWorker.initError = true;
  const gen = generation(), d = deps();
  const planes = [0, -1, 1] as const;
  const handles = await Promise.all(planes.map(plane => prepareInstantTerrain(gen, d, plane)));
  const repeated = await Promise.all(planes.map(plane => prepareInstantTerrain({ ...gen }, d, plane)));
  expect(repeated).toEqual(handles);
  expect(new Set(handles).size).toBe(3);
  expect(handles.map(handle => handle.backend)).toEqual(["main", "main", "main"]);
  expect(d.renderers).toHaveLength(1);
  expect(d.build).toHaveBeenCalledOnce();
  expect(TestWorker.instances).toHaveLength(1);
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  d.setPlane.mockClear();

  for (const index of [2, 0, 1, 2]) {
    const view = { x: index, width: 256 };
    expect(handles[index].render(view)).toBe("canvas");
    expect(d.setPlane).toHaveBeenLastCalledWith(planes[index]);
    expect(d.render).toHaveBeenLastCalledWith(view);
    expect(d.setPlane.mock.invocationCallOrder.at(-1)).toBeLessThan(d.render.mock.invocationCallOrder.at(-1)!);
  }
  expect(d.build).toHaveBeenCalledOnce();
  const next = await prepareInstantTerrain(generation(2), d, -1);
  const invalidationsAfterReseed = d.invalidate.mock.calls.length;
  for (const handle of handles) {
    handle.invalidate();
    expect(() => handle.render({})).toThrow("Obsolete");
  }
  expect(d.invalidate).toHaveBeenCalledTimes(invalidationsAfterReseed);
  expect(next.render({})).toBe("canvas");
  expect(d.setPlane).toHaveBeenLastCalledWith(-1);
  expect(d.renderers).toHaveLength(1);
  expect(d.build).toHaveBeenCalledTimes(2);
  releaseInstantTerrainBackend();
  releaseInstantTerrainBackend();
  expect(d.invalidate).toHaveBeenCalledTimes(invalidationsAfterReseed + 1);
  expect(d.deleteProgram).toHaveBeenCalledOnce();
  expect(d.loseContext).toHaveBeenCalledOnce();
  expect(() => next.render({})).toThrow("Obsolete");
});

it("does not retry a failed fallback independently for sibling planes", async () => {
  const { prepareInstantTerrain } =
    await import("../src/telescope/instant-terrain-backend");
  TestWorker.initError = true;
  const gen = generation(), d = deps();
  d.build.mockReturnValue(false);
  const preparations = ([0, -1, 1] as const).map(plane => prepareInstantTerrain(gen, d, plane));
  await Promise.all(preparations.map(preparation => expect(preparation).rejects.toThrow("resources unavailable")));
  expect(d.renderers).toHaveLength(1);
  expect(d.build).toHaveBeenCalledOnce();
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  d.build.mockReturnValue(true);
  const next = await prepareInstantTerrain(generation(2), d);
  expect(next.backend).toBe("main");
  expect(d.renderers).toHaveLength(1);
  expect(d.build).toHaveBeenCalledTimes(2);
});
