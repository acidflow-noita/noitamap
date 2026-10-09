/** Schedule bounded leaf renders, not whole recursive world-sized tile jobs.
 * A new viewport request can run between any two leaf renders. */
type Work<T> = {
  run: () => T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  priority: () => number;
  background: boolean | (() => boolean);
  rankedBackground: boolean;
  queued: boolean;
  cleanup: () => void;
};
const queue: Work<any>[] = [];
// Keep work here, where its viewport priority can change, instead of sending
// every promise-returning render into a worker's FIFO at once.
const MAX_ASYNC_WORK = 2;
let activeAsync = 0;
let scheduled = false;
let pumping = false;
let needsRanking = false;

function requestPump(refresh = false): void {
  if (refresh) needsRanking = true;
  if (scheduled || pumping || !queue.length || activeAsync >= MAX_ASYNC_WORK)
    return;
  // A background leaf may be running, or foreground work may own a slot.
  // Neither case should spin timers for background-only queued work.
  if (
    !needsRanking &&
    activeAsync &&
    queue.every((task) => task.rankedBackground)
  )
    return;
  scheduled = true;
  setTimeout(pump, 0);
}

/** Reconsider a coalesced tile when a foreground subscriber joins or leaves.
 * Running work retains its slot; promotion never cancels shared subscribers. */
export function wakeTerrainWorkQueue(): void {
  requestPump(true);
}

function pump(): void {
  scheduled = false;
  pumping = true;
  needsRanking = false;
  const until = performance.now() + 8;
  while (activeAsync < MAX_ASYNC_WORK) {
    // Cancelled/invalid viewport callbacks must not poison the global queue.
    const ranked: { task: Work<any>; priority: number }[] = [];
    for (const task of queue.splice(0)) {
      try {
        task.signal.throwIfAborted();
        task.rankedBackground =
          typeof task.background === "function"
            ? task.background()
            : task.background;
        const priority = task.priority();
        // A priority callback may synchronously cancel this request.
        task.signal.throwIfAborted();
        ranked.push({
          task,
          priority: Number.isFinite(priority) ? priority : 0,
        });
      } catch (error) {
        task.queued = false;
        task.cleanup();
        task.reject(error);
      }
    }
    ranked.sort(
      (a, b) =>
        Number(a.task.rankedBackground) - Number(b.task.rankedBackground) ||
        a.priority - b.priority,
    );
    queue.push(...ranked.map((entry) => entry.task));
    const task = queue[0];
    // Admit at most one background leaf, only while foreground is idle. A
    // foreground request arriving during that leaf can still use slot two.
    if (!task || (task.rankedBackground && activeAsync)) break;
    queue.shift();
    task.queued = false;
    task.cleanup();
    try {
      task.signal.throwIfAborted();
      const result = task.run();
      if (result && typeof result.then === "function") {
        activeAsync++;
        Promise.resolve(result).then(
          (value) => {
            activeAsync--;
            task.resolve(value);
            requestPump(true);
          },
          (error) => {
            activeAsync--;
            task.reject(error);
            requestPump(true);
          },
        );
      } else task.resolve(result);
    } catch (error) {
      task.reject(error);
    }
    // Even a fast synchronous background renderer yields between leaves.
    if (task.rankedBackground || performance.now() >= until) break;
  }
  pumping = false;
  requestPump();
}
export interface TerrainWorkOptions {
  background?: boolean | (() => boolean);
}
export function scheduleTerrainWork<T>(
  run: () => T,
  signal: AbortSignal,
  priority: () => number,
  options: TerrainWorkOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      if (!task.queued) return;
      task.queued = false;
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.cleanup();
      reject(signal.reason);
    };
    const task: Work<T> = {
      run,
      signal,
      priority,
      background: options.background ?? false,
      rankedBackground: false,
      resolve,
      reject,
      queued: true,
      cleanup: () => signal.removeEventListener("abort", cancel),
    };
    signal.addEventListener("abort", cancel, { once: true });
    queue.push(task);
    requestPump(true);
  });
}
