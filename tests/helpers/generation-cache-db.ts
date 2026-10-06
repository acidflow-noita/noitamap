import { vi } from 'vitest';

/** Minimal request/commit fixture, with structured cloning and rollback.
 * Browser checks cover native transaction activity and scheduling separately. */
export function generationCacheDB() {
  const records = new Map<string, any>();
  let puts = 0, failPutAt = Infinity;
  const encode = (key: any) => typeof key === 'string' ? key : JSON.stringify(key);
  const db = { close: vi.fn(), transaction: (_name: string, mode = 'readonly') => {
    const staged = new Map(records);
    let pending = 0, ended = false;
    const requests = new Set<any>();
    const progress = new Set<() => void>();
    const tx: any = {
      error: null,
      addEventListener: (_: string, fn: () => void) => progress.add(fn),
      removeEventListener: (_: string, fn: () => void) => progress.delete(fn),
      abort: () => { if (ended) return; ended = true; queueMicrotask(() => {
        for (const req of requests) { req.error = new DOMException('Aborted', 'AbortError'); req.onerror?.(); }
        requests.clear(); tx.onabort?.();
      }); },
    };
    const request = (work: () => unknown) => {
      if (ended) throw new DOMException('Transaction is inactive', 'TransactionInactiveError');
      const req: any = { transaction: tx };
      requests.add(req);
      pending++;
      queueMicrotask(() => {
        if (ended) return;
        try {
          req.result = work();
          for (const fn of progress) fn();
          req.onsuccess?.();
          requests.delete(req);
        } catch (error) {
          tx.error = req.error = error; req.onerror?.(); tx.abort();
        }
        pending--;
        // Native IDB auto-commit follows the complete microtask checkpoint,
        // including Promise.all continuations of multiple successful requests.
        setTimeout(() => {
          if (pending || ended) return;
          ended = true;
          if (mode === 'readwrite') { records.clear(); for (const [key, value] of staged) records.set(key, value); }
          tx.oncomplete?.();
        }, 0);
      });
      return req;
    };
    tx.objectStore = () => ({
      get: (key: unknown) => request(() => structuredClone(staged.get(encode(key)))),
      getAll: (range: any) => request(() => structuredClone([...staged.values()].filter(value =>
        Array.isArray(value.cacheKey) && value.cacheKey[0] === range.lower[0] && value.cacheKey[1] === range.lower[1]
        && value.cacheKey[2] >= range.lower[2] && value.cacheKey[2] <= range.upper[2])
        .sort((a, b) => a.cacheKey[2] - b.cacheKey[2]))),
      put: (value: any) => {
        if (++puts === failPutAt) throw new DOMException('Cannot clone this page', 'DataCloneError');
        const cloned = structuredClone(value);
        return request(() => { staged.set(encode(value.cacheKey), cloned); return value.cacheKey; });
      },
      delete: (key: any) => request(() => {
        if (key?.lower) {
          for (const [storedKey, value] of staged) if (Array.isArray(value.cacheKey)
            && value.cacheKey[0] === key.lower[0] && value.cacheKey[1] === key.lower[1]
            && value.cacheKey[2] >= key.lower[2] && value.cacheKey[2] <= key.upper[2]) staged.delete(storedKey);
        } else staged.delete(encode(key));
      }),
      clear: () => request(() => staged.clear()),
    });
    return tx;
  } };
  vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
  vi.stubGlobal('indexedDB', { open: () => {
    const req: any = { result: db }; queueMicrotask(() => req.onsuccess?.()); return req;
  } });
  return { db: db as unknown as IDBDatabase, records,
    failAfterPuts: (count: number) => { failPutAt = puts + count; },
    allowPuts: () => { failPutAt = Infinity; },
    header: () => [...records.values()].find(record => record.format === 'generation-pages-v1')?.value,
  };
}
