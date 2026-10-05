/** Continue in a browser task so queued input and rendering can run. A resolved
 * promise alone only extends the current microtask chain. */
export function yieldGenerationTask(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise(resolve => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

let tail = Promise.resolve();

/** Telescope's RNG, unlocks and app state are shared. Yielding must let the UI
 * run without letting another seed/alternate unlock pass replace that state. */
export function runGenerationTask<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work);
  tail = result.then(() => {}, () => {});
  return result;
}
