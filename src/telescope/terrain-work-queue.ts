/** Schedule bounded leaf renders, not whole recursive world-sized tile jobs.
 * A new viewport request can run between any two leaf renders. */
type Work<T> = {
  run: () => T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  priority: () => number;
};
const queue: Work<any>[] = [];
let scheduled = false;
function pump(): void {
  const until = performance.now() + 8;
  do {
    // Cancelled/invalid viewport callbacks must not poison the global queue.
    const ranked: { task: Work<any>; priority: number }[] = [];
    for (const task of queue.splice(0)) {
      try {
        task.signal.throwIfAborted();
        const priority = task.priority();
        ranked.push({
          task,
          priority: Number.isFinite(priority) ? priority : 0,
        });
      } catch (error) {
        task.reject(error);
      }
    }
    ranked.sort((a, b) => a.priority - b.priority);
    queue.push(...ranked.map((entry) => entry.task));
    const task = queue.shift();
    if (!task) break;
    try {
      task.signal.throwIfAborted();
      task.resolve(task.run());
    } catch (error) {
      task.reject(error);
    }
  } while (performance.now() < until);
  scheduled = queue.length > 0;
  if (scheduled) setTimeout(pump, 0);
}
export function scheduleTerrainWork<T>(
  run: () => T,
  signal: AbortSignal,
  priority: () => number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push({ run, signal, priority, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      setTimeout(pump, 0);
    }
  });
}
