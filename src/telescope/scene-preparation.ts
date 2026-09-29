import type { CompressedSceneBitmap } from './scene-bitmap-provider';

/** Visible requests and background cooking share one bounded preparation
 * queue. The background loop admits only one scene at a time, so navigation
 * can take the next slot instead of waiting behind the entire map. */
export function createScenePreparation(
  keys: readonly string[],
  prepare: (key: string) => Promise<CompressedSceneBitmap | undefined>,
  release: () => void,
  options: { concurrency?: number; maxBytes?: number; bytesForKey?: (key: string) => number } = {},
) {
  const images = new Map<string, CompressedSceneBitmap>();
  const remaining = new Set(keys), inflight = new Map<string, Promise<CompressedSceneBitmap | undefined>>();
  const lifetime = new AbortController();
  let warming: Promise<void> | undefined;
  let active = 0, activeBytes = 0;
  const queue: Array<{ bytes: number; run: () => void }> = [];
  const limit = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 1) || 1));
  const pump = () => {
    while (active < limit && queue.length) {
      if (active && activeBytes + queue[0].bytes > (options.maxBytes ?? Infinity)) break;
      queue.shift()!.run();
    }
  };
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  let finishAll!: () => void, failAll!: (error: unknown) => void;
  const complete = new Promise<void>((yes, no) => { finishAll = yes; failAll = no; });
  void complete.catch(() => {});
  if (!remaining.size) finishAll();
  const loadBitmap = (key: string): Promise<CompressedSceneBitmap | undefined> => {
    if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
    if (!remaining.has(key)) return Promise.resolve(images.get(key));
    const pending = inflight.get(key);
    if (pending) return pending;
    const bytes = Math.max(0, options.bytesForKey?.(key) ?? 0);
    const job = new Promise<CompressedSceneBitmap | undefined>((resolve, reject) => {
      queue.push({ bytes, run: () => {
        active++; activeBytes += bytes;
        void (async () => {
          lifetime.signal.throwIfAborted();
          const image = await prepare(key);
          lifetime.signal.throwIfAborted();
          if (image) images.set(key, image);
          remaining.delete(key);
          if (!remaining.size) { releaseOnce(); finishAll(); }
          return image;
        })().then(resolve, reject).finally(() => { active--; activeBytes -= bytes; pump(); });
      } });
    });
    inflight.set(key, job);
    void job.catch(error => { failAll(error); });
    pump();
    void job.finally(() => inflight.delete(key)).catch(() => {});
    return job;
  };
  return {
    images, loadBitmap, complete, signal: lifetime.signal,
    get pending() { return remaining.size; },
    warmAll(): Promise<void> {
      return warming ??= (async () => {
        let yieldedAt = performance.now();
        for (const key of keys) {
          lifetime.signal.throwIfAborted();
          if (performance.now() - yieldedAt >= 6) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            yieldedAt = performance.now();
          }
          await loadBitmap(key);
        }
        await complete;
      })();
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new DOMException('Scene preparation cancelled', 'AbortError'));
      failAll(lifetime.signal.reason); releaseOnce(); images.clear();
      pump();
    },
  };
}
