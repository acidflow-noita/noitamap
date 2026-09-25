/** Schedule bounded leaf renders, not whole recursive world-sized tile jobs.
 * A new viewport request can run between any two leaf renders. */
type Work<T> = {
  run: () => T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  priority: () => number;
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

function requestPump(): void {
  if (scheduled || pumping || !queue.length || activeAsync >= MAX_ASYNC_WORK)
    return;
  scheduled = true;
  setTimeout(pump, 0);
}

function pump(): void {
  scheduled = false;
  pumping = true;
  const until = performance.now() + 8;
  while (activeAsync < MAX_ASYNC_WORK) {
    // Cancelled/invalid viewport callbacks must not poison the global queue.
    const ranked: { task: Work<any>; priority: number }[] = [];
    for (const task of queue.splice(0)) {
      try {
        task.signal.throwIfAborted();
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
    ranked.sort((a, b) => a.priority - b.priority);
    queue.push(...ranked.map((entry) => entry.task));
    const task = queue.shift();
    if (!task) break;
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
            requestPump();
          },
          (error) => {
            activeAsync--;
            task.reject(error);
            requestPump();
          },
        );
      } else task.resolve(result);
    } catch (error) {
      task.reject(error);
    }
    if (performance.now() >= until) break;
  }
  pumping = false;
  requestPump();
}
export function scheduleTerrainWork<T>(
  run: () => T,
  signal: AbortSignal,
  priority: () => number,
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
      resolve,
      reject,
      queued: true,
      cleanup: () => signal.removeEventListener("abort", cancel),
    };
    signal.addEventListener("abort", cancel, { once: true });
    queue.push(task);
    requestPump();
  });
}
