import { afterEach, beforeEach, expect, it, vi } from "vitest";

let schedule: typeof import("../src/telescope/terrain-work-queue").scheduleTerrainWork;
let wake: typeof import("../src/telescope/terrain-work-queue").wakeTerrainWorkQueue;
const signal = () => new AbortController().signal;
function barrier<T = number>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const queue = await import("../src/telescope/terrain-work-queue");
  schedule = queue.scheduleTerrainWork;
  wake = queue.wakeTerrainWorkQueue;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps at most two asynchronous renders in flight instead of flooding worker queues", async () => {
  const waits = Array.from({ length: 5 }, () => barrier());
  const started: number[] = [];
  const results = waits.map((wait, index) =>
    schedule(
      () => {
        started.push(index);
        return wait.promise;
      },
      signal(),
      () => index,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([0, 1]);
  expect(vi.getTimerCount()).toBe(0); // No busy polling while workers are full.
  waits[0].resolve(10);
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 2]);
  waits[1].resolve(11);
  waits[2].resolve(12);
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 2, 3, 4]);
  waits[3].resolve(13);
  waits[4].resolve(14);
  expect(await Promise.all(results)).toEqual([10, 11, 12, 13, 14]);
});

it("recomputes queued priorities after the viewport changes while draws are active", async () => {
  const waits = Array.from({ length: 4 }, () => barrier());
  const started: number[] = [];
  let priority = [0, 1, 2, 3];
  const results = waits.map((wait, index) =>
    schedule(
      () => {
        started.push(index);
        return wait.promise;
      },
      signal(),
      () => priority[index],
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([0, 1]);
  priority = [0, 1, 100, -10];
  waits[0].resolve(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 3]);
  waits[1].resolve(1);
  waits[3].resolve(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 3, 2]);
  waits[2].resolve(2);
  await Promise.all(results);
});

it("rejects cancelled queued work immediately even when both workers remain busy", async () => {
  const waits = [barrier(), barrier()];
  const busy = waits.map((wait) =>
    schedule(
      () => wait.promise,
      signal(),
      () => 0,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  const controller = new AbortController(),
    run = vi.fn();
  const cancelled = schedule(run, controller.signal, () => -100);
  const rejected = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  waits.forEach((wait) => wait.resolve(1));
  await Promise.all(busy);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).not.toHaveBeenCalled();
});

it("does not run already-aborted work or requests cancelled by their priority callback", async () => {
  const before = new AbortController(),
    during = new AbortController(),
    run = vi.fn();
  before.abort();
  const first = expect(
    schedule(run, before.signal, () => 0),
  ).rejects.toMatchObject({ name: "AbortError" });
  const second = expect(
    schedule(run, during.signal, () => {
      during.abort();
      return 0;
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const valid = schedule(
    () => 17,
    signal(),
    () => 1,
  );
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all([first, second]);
  expect(await valid).toBe(17);
  expect(run).not.toHaveBeenCalled();
});

it("releases asynchronous capacity after rejection and isolates synchronous and priority failures", async () => {
  const waits = [barrier(), barrier()];
  const errors = waits.map((wait) =>
    schedule(
      () => wait.promise,
      signal(),
      () => 0,
    ),
  );
  const caught = errors.map((result) =>
    expect(result).rejects.toThrow("draw failed"),
  );
  await vi.advanceTimersByTimeAsync(0);
  const priorityError = expect(
    schedule(
      () => 0,
      signal(),
      () => {
        throw new Error("bad priority");
      },
    ),
  ).rejects.toThrow("bad priority");
  const syncError = expect(
    schedule(
      () => {
        throw new Error("bad canvas");
      },
      signal(),
      () => 0,
    ),
  ).rejects.toThrow("bad canvas");
  const good = schedule(
    () => 42,
    signal(),
    () => 1,
  );
  waits.forEach((wait) => wait.reject(new Error("draw failed")));
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([...caught, priorityError, syncError]);
  expect(await good).toBe(42);
});

it("continues yielding after eight milliseconds of synchronous rendering", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const order: (number | string)[] = [];
  const results = [0, 1, 2, 3].map((index) =>
    schedule(
      () => {
        order.push(index);
        now += 5;
        return index;
      },
      signal(),
      () => 0,
    ),
  );
  setTimeout(() => order.push("UI work"), 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual([0, 1, "UI work"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toEqual([0, 1, "UI work", 2, 3]);
  expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
});

it("awaits thenables as well as native promises", async () => {
  const waits = [barrier(), barrier(), barrier()];
  const started: number[] = [];
  const results = waits.map((wait, index) =>
    schedule(
      () => {
        started.push(index);
        return { then: wait.promise.then.bind(wait.promise) };
      },
      signal(),
      () => 0,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([0, 1]);
  waits[0].resolve(0);
  waits[1].resolve(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 2]);
  waits[2].resolve(2);
  expect(await Promise.all(results)).toEqual([0, 1, 2]);
});

it("admits one background leaf only after foreground work finishes, regardless of numeric priority", async () => {
  const started: string[] = [];
  const waits = new Map(
    ["backA", "backB", "frontA", "frontB", "frontC"].map((name) => [
      name,
      barrier<string>(),
    ]),
  );
  const enqueue = (name: string, background = false) =>
    schedule(
      () => {
        started.push(name);
        return waits.get(name)!.promise;
      },
      signal(),
      () => (background ? -1000 : 1000),
      { background },
    );
  const results = [
    enqueue("backA", true),
    enqueue("backB", true),
    enqueue("frontA"),
    enqueue("frontB"),
  ];
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual(["frontA", "frontB"]);
  waits.get("frontA")!.resolve("frontA");
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual(["frontA", "frontB"]);
  expect(vi.getTimerCount()).toBe(0);
  waits.get("frontB")!.resolve("frontB");
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual(["frontA", "frontB", "backA"]);
  expect(vi.getTimerCount()).toBe(0);

  // A background draw cannot be interrupted, but it leaves the second queue
  // slot available for newly visible work instead of filling a worker FIFO.
  results.push(enqueue("frontC"));
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual(["frontA", "frontB", "backA", "frontC"]);
  waits.get("backA")!.resolve("backA");
  await vi.advanceTimersByTimeAsync(1);
  expect(started).not.toContain("backB");
  expect(vi.getTimerCount()).toBe(0);
  waits.get("frontC")!.resolve("frontC");
  await vi.advanceTimersByTimeAsync(1);
  expect(started.at(-1)).toBe("backB");
  waits.get("backB")!.resolve("backB");
  expect(await Promise.all(results)).toEqual([
    "backA",
    "backB",
    "frontA",
    "frontB",
    "frontC",
  ]);
});

it("promotes a coalesced background tile when a foreground subscriber joins while both slots are busy", async () => {
  const active = [barrier(), barrier()];
  const foreground = active.map((wait) =>
    schedule(
      () => wait.promise,
      signal(),
      () => 0,
    ),
  );
  const tile = barrier(),
    tileRun = vi.fn(() => tile.promise);
  let background = true;
  const queued = schedule(tileRun, signal(), () => -1, {
    background: () => background,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(tileRun).not.toHaveBeenCalled();
  background = false;
  wake();
  expect(vi.getTimerCount()).toBe(0); // Promotion waits for a slot, without polling.
  active[0].resolve(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(tileRun).toHaveBeenCalledOnce();
  // Losing that subscriber after dispatch must not cancel the background
  // request that still needs this same result.
  background = true;
  wake();
  tile.resolve(42);
  active[1].resolve(2);
  expect(await queued).toBe(42);
  expect(await Promise.all(foreground)).toEqual([1, 2]);
});

it("does not dispatch a queued tile whose last foreground subscriber left before its turn", async () => {
  const active = barrier(),
    backgroundTile = barrier();
  const foreground = schedule(
    () => active.promise,
    signal(),
    () => 0,
  );
  await vi.advanceTimersByTimeAsync(0);
  let background = false;
  const run = vi.fn(() => backgroundTile.promise);
  const queued = schedule(run, signal(), () => -10, {
    background: () => background,
  });
  background = true;
  wake();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  active.resolve(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledOnce();
  backgroundTile.resolve(2);
  expect(await Promise.all([foreground, queued])).toEqual([1, 2]);
});

it("cancels queued background work and isolates background predicate and draw failures", async () => {
  const active = barrier();
  const first = schedule(
    () => active.promise,
    signal(),
    () => 0,
    { background: true },
  );
  const failed = expect(first).rejects.toThrow("background draw failed");
  await vi.advanceTimersByTimeAsync(0);
  const controller = new AbortController(),
    cancelledRun = vi.fn();
  const cancelled = expect(
    schedule(cancelledRun, controller.signal, () => 0, { background: true }),
  ).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await cancelled;
  const predicateFailure = expect(
    schedule(
      () => 0,
      signal(),
      () => 0,
      {
        background: () => {
          throw new Error("invalid background state");
        },
      },
    ),
  ).rejects.toThrow("invalid background state");
  const nextRun = vi.fn(() => 17);
  const next = schedule(nextRun, signal(), () => 0, { background: true });
  await vi.advanceTimersByTimeAsync(1);
  await predicateFailure;
  expect(nextRun).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  active.reject(new Error("background draw failed"));
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(await next).toBe(17);
  expect(cancelledRun).not.toHaveBeenCalled();
});

it("yields after every synchronous background leaf so foreground can enter between them", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const order: string[] = [],
    results: Promise<unknown>[] = [];
  for (let index = 0; index < 3; index++)
    results.push(
      schedule(
        () => order.push(`back${index}`),
        signal(),
        () => 0,
        { background: true },
      ),
    );
  setTimeout(() => {
    order.push("UI work");
    results.push(
      schedule(
        () => order.push("foreground"),
        signal(),
        () => 100,
      ),
    );
  }, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["back0", "UI work"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toEqual(["back0", "UI work", "foreground", "back1"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toEqual(["back0", "UI work", "foreground", "back1", "back2"]);
  await Promise.all(results);
});
