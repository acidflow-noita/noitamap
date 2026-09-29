import type { SceneBitmapData } from './scene-bitmap-provider';

/** Visible requests and background cooking share one bounded preparation
 * queue. The background loop admits only one scene at a time, so navigation
 * can take the next slot instead of waiting behind the entire map. */
export function createScenePreparation(
  keys: readonly string[],
  prepare: (key: string, persist: boolean, existing?: SceneBitmapData) => Promise<SceneBitmapData | undefined>,
  release: () => void,
  options: { concurrency?: number; maxBytes?: number; bytesForKey?: (key: string) => number;
    deferredPersistence?: boolean; maxRetainedBytes?: number } = {},
) {
  const images = new Map<string, SceneBitmapData>();
  const remaining = new Set(keys), inflight = new Map<string, Promise<SceneBitmapData | undefined>>();
  const lifetime = new AbortController();
  let warming: Promise<void> | undefined;
  const rawKeys = new Map<string, number>();
  let rawBytes = 0;
  const retain = (key: string, image: SceneBitmapData) => {
    rawBytes -= rawKeys.get(key) ?? 0;
    rawKeys.delete(key);
    if (image.pixels) {
      const size = image.pixels.byteLength;
      const budget = options.maxRetainedBytes ?? options.maxBytes ?? 0;
      while (rawBytes + size > budget && rawKeys.size) {
        const oldest = rawKeys.keys().next().value!;
        rawBytes -= rawKeys.get(oldest)!;
        rawKeys.delete(oldest); images.delete(oldest);
      }
      // Oversized scenes may be drawn by their requester, but never retained.
      if (size > budget) { images.delete(key); return; }
      rawKeys.set(key, size); rawBytes += size;
    }
    images.set(key, image);
  };
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
  const loadBitmap = (key: string, persist = false): Promise<SceneBitmapData | undefined> => {
    if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
    const existing = images.get(key);
    if (existing && (!persist || existing.blob)) return Promise.resolve(existing);
    const pending = inflight.get(key);
    if (pending) return persist ? pending.then(() => loadBitmap(key, true)) : pending;
    const bytes = Math.max(0, options.bytesForKey?.(key) ?? 0);
    const job = new Promise<SceneBitmapData | undefined>((resolve, reject) => {
      queue.push({ bytes, run: () => {
        active++; activeBytes += bytes;
        void (async () => {
          lifetime.signal.throwIfAborted();
          const image = await prepare(key, persist, existing);
          lifetime.signal.throwIfAborted();
          if (image) retain(key, image);
          if (!options.deferredPersistence || persist || image?.blob) remaining.delete(key);
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
        // Persist still-retained live pixels first, before background work can
        // replace their bounded cache entries and force another composition.
        for (const key of new Set([...images.keys(), ...keys])) {
          lifetime.signal.throwIfAborted();
          if (performance.now() - yieldedAt >= 6) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            yieldedAt = performance.now();
          }
          await loadBitmap(key, !!options.deferredPersistence);
        }
        await complete;
      })();
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new DOMException('Scene preparation cancelled', 'AbortError'));
      failAll(lifetime.signal.reason); releaseOnce(); images.clear(); rawKeys.clear(); rawBytes = 0;
      pump();
    },
  };
}
