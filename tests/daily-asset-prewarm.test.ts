// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock('../src/telescope/daily-asset-worker-client', () => ({ prepareDailyAssetsOffThread: vi.fn(async () => ({ type: 'done', prepared: 1, failures: 0, elapsedMs: 1 })) }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prewarmInstantTerrain: vi.fn(async () => true) }));
import { scheduleDailyAssetWarmup } from "../src/telescope/daily-asset-prewarm";
import { prepareDailyAssetsOffThread } from '../src/telescope/daily-asset-worker-client';
import {
  backgroundAssetYield,
  prepareAssetJobs,
} from "../src/telescope/background-idle";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function viewer() {
  const handlers = new Set<(event: any) => void>();
  return {
    addHandler: vi.fn((_name: string, handler: (event: any) => void) =>
      handlers.add(handler),
    ),
    removeHandler: vi.fn((_name: string, handler: (event: any) => void) =>
      handlers.delete(handler),
    ),
    draw(baked = true) {
      for (const handler of [...handlers])
        handler({ tiledImage: { source: { __bakedDzi: baked } } });
    },
    handlers,
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('uses only the asset worker by default and aborts it when the daily map is replaced', async () => {
  const map = viewer();
  const cancel = scheduleDailyAssetWarmup({ viewer: map, isCurrent: () => true, yieldTask: async () => {} });
  map.draw();
  await vi.waitFor(() => expect(prepareDailyAssetsOffThread).toHaveBeenCalled());
  const [request, signal] = vi.mocked(prepareDailyAssetsOffThread).mock.calls.at(-1)!;
  expect(request.baseUrl).toBe(new URL('./', document.baseURI).href);
  expect(signal.aborted).toBe(false);
  cancel();
  expect(signal.aborted).toBe(true);
});

it("waits for an actual baked tile and a later task, then warms stages serially", async () => {
  const map = viewer(),
    idle = barrier(),
    first = barrier();
  const one = vi.fn(() => first.promise),
    two = vi.fn(async () => {});
  const yieldTask = vi.fn(async () => {
    await idle.promise;
  });
  const cancel = scheduleDailyAssetWarmup({
    viewer: map,
    isCurrent: () => true,
    stages: [one, two],
    yieldTask,
  });
  map.draw(false);
  expect(yieldTask).not.toHaveBeenCalled();
  map.draw();
  map.draw();
  expect(yieldTask).toHaveBeenCalledOnce();
  expect(one).not.toHaveBeenCalled();
  idle.resolve();
  await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
  expect(two).not.toHaveBeenCalled();
  first.resolve();
  await vi.waitFor(() => expect(two).toHaveBeenCalledOnce());
  expect(map.handlers.size).toBe(0);
  expect(yieldTask).toHaveBeenCalledTimes(2);
  cancel();
});

it("cancels before paint without starting downloads or leaving a draw listener", () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const map = viewer(),
    stage = vi.fn();
  const cancel = scheduleDailyAssetWarmup({
    viewer: map,
    isCurrent: () => true,
    stages: [stage],
  });
  cancel();
  map.draw();
  expect(stage).not.toHaveBeenCalled();
  expect(map.handlers.size).toBe(0);
  expect(info).not.toHaveBeenCalled();
});

it('logs one start and timed finish including idle waits and the final preparation stage', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const map = viewer(), idle = barrier(), work = barrier();
  const stage = vi.fn(() => work.promise);
  const cancel = scheduleDailyAssetWarmup({
    viewer: map, isCurrent: () => true,
    yieldTask: () => idle.promise, stages: [stage],
  });
  map.draw(false);
  expect(info).not.toHaveBeenCalled();
  map.draw(); map.draw();
  expect(info).toHaveBeenCalledExactlyOnceWith('[Dynamic assets] Daily warmup started', { sinceNavigationMs: 100 });
  now = 900;
  idle.resolve();
  await vi.waitFor(() => expect(stage).toHaveBeenCalledOnce());
  expect(info).toHaveBeenCalledOnce();
  now = 2600;
  work.resolve();
  await vi.waitFor(() => expect(info).toHaveBeenCalledWith(
    '[Dynamic assets] Daily warmup finished in 2.50 seconds',
    expect.objectContaining({ elapsedMs: 2500, sinceNavigationMs: 2600, failures: 0 }),
  ));
  cancel();
  expect(info.mock.calls.filter(([message]) => String(message).startsWith('[Dynamic assets]'))).toHaveLength(2);
});

it('logs cancellation time without a later success for an abandoned warmup', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const map = viewer(), work = barrier();
  const stage = vi.fn(() => work.promise);
  const cancel = scheduleDailyAssetWarmup({
    viewer: map, isCurrent: () => true, yieldTask: async () => {}, stages: [stage],
  });
  map.draw();
  await vi.waitFor(() => expect(stage).toHaveBeenCalledOnce());
  now = 800;
  cancel(); cancel();
  work.resolve();
  await work.promise;
  await Promise.resolve();
  expect(info.mock.calls.map(([message]) => message)).toEqual([
    '[Dynamic assets] Daily warmup started',
    '[Dynamic assets] Daily warmup cancelled in 0.70 seconds',
  ]);
});

it("preserves an in-flight shared operation but never starts its next stage after navigation", async () => {
  const map = viewer(),
    first = barrier();
  const one = vi.fn(() => first.promise),
    two = vi.fn();
  const cancel = scheduleDailyAssetWarmup({
    viewer: map,
    isCurrent: () => true,
    stages: [one, two],
    yieldTask: async () => {},
  });
  map.draw();
  await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
  cancel();
  first.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(two).not.toHaveBeenCalled();
});

it("ignores obsolete daily intents and keeps a failed GPU stage separate from cached assets", async () => {
  const map = viewer(),
    failure = new Error("GPU unavailable"),
    failed = vi.fn();
  const download = vi.fn(async () => {}),
    gpu = vi.fn(async () => {
      throw failure;
    }),
    scenes = vi.fn(async () => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const cancel = scheduleDailyAssetWarmup({
    viewer: map,
    isCurrent: () => true,
    stages: [download, gpu, scenes],
    yieldTask: async () => {},
    onFailure: failed,
  });
  map.draw();
  await vi.waitFor(() => expect(scenes).toHaveBeenCalledOnce());
  expect(download).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledWith(failure);
  expect(info.mock.calls.find(([message]) => String(message).startsWith('[Dynamic assets] Daily warmup finished'))?.[1]).toMatchObject({ failures: 1 });
  cancel();
  const stale = vi.fn();
  scheduleDailyAssetWarmup({
    viewer: map,
    isCurrent: () => false,
    stages: [stale],
  });
  map.draw();
  expect(stale).not.toHaveBeenCalled();
  expect(map.handlers.size).toBe(0);
});

it("releases an idle wait immediately when foreground initialization takes over", async () => {
  const request = vi.fn(() => 42),
    cancel = vi.fn();
  vi.stubGlobal("requestIdleCallback", request);
  vi.stubGlobal("cancelIdleCallback", cancel);
  const promotion = new AbortController(),
    finished = vi.fn();
  const pending = backgroundAssetYield(promotion.signal).then(finished);
  expect(finished).not.toHaveBeenCalled();
  promotion.abort();
  await pending;
  expect(cancel).toHaveBeenCalledWith(42);
  expect(finished).toHaveBeenCalledOnce();
});

it("promotes the same background decode queue to eight foreground jobs without duplication", async () => {
  const idle = vi.fn(() => 7);
  vi.stubGlobal("requestIdleCallback", idle);
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const promotion = new AbortController(),
    jobs = Array.from({ length: 12 }, (_, i) => i);
  const running = new Map<number, () => void>();
  let maxActive = 0;
  const load = vi.fn(
    (key: number) =>
      new Promise<void>((done) => {
        running.set(key, () => {
          running.delete(key);
          done();
        });
        maxActive = Math.max(maxActive, running.size);
      }),
  );
  const pending = prepareAssetJobs(jobs, load, promotion.signal);
  expect(idle).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled();
  promotion.abort();
  await vi.waitFor(() => expect(running.size).toBe(8));
  for (const done of [...running.values()]) done();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(12));
  for (const done of [...running.values()]) done();
  await pending;
  expect(maxActive).toBe(8);
  expect(load.mock.calls.map(([key]) => key).sort((a, b) => a - b)).toEqual(
    jobs,
  );
});

it("finishes an empty job list without an idle wait", async () => {
  const load = vi.fn(),
    idle = vi.fn();
  await prepareAssetJobs([], load, new AbortController().signal, idle);
  expect(load).not.toHaveBeenCalled();
  expect(idle).not.toHaveBeenCalled();
});
