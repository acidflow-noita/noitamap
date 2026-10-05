/** Continue in a browser task so queued input and rendering can run. A resolved
 * promise alone only extends the current microtask chain. */
export function yieldGenerationTask(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  const task = scheduler?.yield ? scheduler.yield() : new Promise<void>(resolve => {
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
  return signal ? task.then(() => { signal.throwIfAborted(); }) : task;
}

/** Check only at complete biome regions/path attempts. The budget bounds a
 * batch of work; it is not a delay added to each region. */
export function createGenerationCheckpoint(signal?: AbortSignal): () => Promise<void> | undefined {
  let deadline = performance.now() + 8;
  return () => {
    signal?.throwIfAborted();
    if (performance.now() < deadline) return;
    return yieldGenerationTask(signal).then(() => { deadline = performance.now() + 8; });
  };
}

/** Release the main generator when obsolete PW work is already running.
 * Workers finish their independent scans; late success/failure stays observed. */
export function waitForGenerationWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
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
