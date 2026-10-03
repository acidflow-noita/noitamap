/** A module worker may dispatch messages while its top-level imports await
 * assets. Wait for its own ready message before sending the one-shot build. */
export function buildTerrainInWorker(worker: Worker, request: unknown, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    let started = false, settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      error === undefined ? resolve(value) : reject(error);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(started
        ? 'Terrain resource worker timed out while building resources'
        : 'Terrain resource worker timed out while loading its modules/assets')), 60_000);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    worker.onmessage = ({ data }) => {
      if (data?.type === 'ready') {
        if (started) return;
        started = true;
        arm();
        try { worker.postMessage(request); } catch (error) { finish(error); }
      } else if (data?.error) finish(new Error(data.error));
      else if (started && data?.cpu) finish(undefined, data);
      else finish(new Error('Invalid terrain resource worker response'));
    };
    worker.onerror = event => finish(new Error(event.message || 'Terrain resource worker failed to load'));
    worker.onmessageerror = () => finish(new Error('Terrain resource worker response could not be decoded'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else arm();
  });
}
