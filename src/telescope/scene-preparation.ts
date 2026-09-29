import type { CompressedSceneBitmap } from './scene-bitmap-provider';

/** Visible requests and background cooking share one bounded preparation
 * queue. The background loop admits only one scene at a time, so navigation
 * can take the next slot instead of waiting behind the entire map. */
export function createScenePreparation(
  keys: readonly string[],
  prepare: (key: string) => Promise<CompressedSceneBitmap | undefined>,
  release: () => void,
) {
  const images = new Map<string, CompressedSceneBitmap>();
  const remaining = new Set(keys), inflight = new Map<string, Promise<CompressedSceneBitmap | undefined>>();
  const lifetime = new AbortController();
  let queue = Promise.resolve(), warming: Promise<void> | undefined;
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  let resolve!: () => void, reject!: (error: unknown) => void;
  const complete = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void complete.catch(() => {});
  if (!remaining.size) resolve();
  const loadBitmap = (key: string): Promise<CompressedSceneBitmap | undefined> => {
    if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
    if (!remaining.has(key)) return Promise.resolve(images.get(key));
    const pending = inflight.get(key);
    if (pending) return pending;
    const job = queue.then(async () => {
      lifetime.signal.throwIfAborted();
      const image = await prepare(key);
      lifetime.signal.throwIfAborted();
      if (image) images.set(key, image);
      remaining.delete(key);
      if (!remaining.size) { releaseOnce(); resolve(); }
      return image;
    });
    inflight.set(key, job);
    queue = job.then(() => {}, error => { reject(error); });
    void job.finally(() => inflight.delete(key)).catch(() => {});
    return job;
  };
  return {
    images, loadBitmap, complete, signal: lifetime.signal,
    get pending() { return remaining.size; },
    warmAll(): Promise<void> {
      return warming ??= (async () => {
        for (const key of keys) { lifetime.signal.throwIfAborted(); await loadBitmap(key); }
        await complete;
      })();
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new DOMException('Scene preparation cancelled', 'AbortError'));
      reject(lifetime.signal.reason); releaseOnce(); images.clear();
    },
  };
}
