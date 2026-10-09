import type { OptionalCacheDatabase } from './cache-storage';

// Array keys cannot collide with the string keys used by older builds. Keep
// the same object store/schema so clearing and expiry also cover these pages.
const FORMAT = 'generation-pages-v1';
const PAGE_ITEMS = 1024;
const REQUEST_BATCH = 2;
const sections = ['poisByPW', 'pixelScenesByPW'] as const;
type Section = typeof sections[number];
interface GenerationEntry {
  cacheKey: string;
  timestamp: number;
  poisByPW: Record<string, unknown[]>;
  pixelScenesByPW: Record<string, unknown[]>;
}
type PageKey = [string, string, number];
interface ArrayPlan { section: Section; world: string; length: number }
interface Header<T extends GenerationEntry> {
  cacheKey: PageKey;
  timestamp: number;
  format: typeof FORMAT;
  pageItems: number;
  value: T;
  arrays: ArrayPlan[];
}
interface Page { cacheKey: PageKey; timestamp: number; values: unknown[] }
const key = (cacheKey: string, page: number): PageKey => [FORMAT, cacheKey, page];
const range = (cacheKey: string, first = -1, last = Number.MAX_SAFE_INTEGER) =>
  IDBKeyRange.bound(key(cacheKey, first), key(cacheKey, last));

/** Generated inputs stay owned by the completed generation. Slice only the
 * page being saved; never stringify or clone the entire POI graph first. */
export function* generationCacheRecords<T extends GenerationEntry>(entry: T): Generator<Page | Header<T>> {
  const arrays: ArrayPlan[] = [];
  const value = { ...entry };
  let page = 0;
  for (const section of sections) {
    value[section] = Object.fromEntries(Object.keys(entry[section]).map(world => [world, []]));
    for (const [world, values] of Object.entries(entry[section])) {
      arrays.push({ section, world, length: values.length });
      for (let offset = 0; offset < values.length; offset += PAGE_ITEMS) {
        yield { cacheKey: key(entry.cacheKey, page++), timestamp: entry.timestamp,
          values: values.slice(offset, offset + PAGE_ITEMS) };
      }
    }
  }
  yield { cacheKey: key(entry.cacheKey, -1), timestamp: entry.timestamp, format: FORMAT, pageItems: PAGE_ITEMS, value, arrays };
}

/** Every bounded batch is queued from the preceding requests' success
 * microtasks, while the transaction is active. IDB events let the browser run
 * input between small clones; a timer/scheduler yield here would close the
 * transaction. A failed page rolls back both replacement and deletion. */
export async function writeGenerationCache<T extends GenerationEntry>(
  storage: OptionalCacheDatabase, db: IDBDatabase, storeName: string, entry: T,
): Promise<void> {
  const transaction = db.transaction(storeName, 'readwrite');
  const complete = storage.complete(transaction);
  // A request/encoding error can reject before the transaction's abort event.
  // Observe both immediately, preserving the original error for the caller.
  void complete.catch(() => {});
  try {
    const store = transaction.objectStore(storeName);
    await storage.read(store.delete(range(entry.cacheKey)));
    let pending: Promise<unknown>[] = [];
    for (const record of generationCacheRecords(entry)) {
      const request = storage.read(store.put(record));
      // A later synchronous clone failure also aborts already queued pages.
      void request.catch(() => {});
      pending.push(request);
      if (pending.length === REQUEST_BATCH) { await Promise.all(pending); pending = []; }
    }
    await Promise.all(pending);
    // Older builds safely miss this generation instead of reading a manifest
    // as a complete result. New builds continue to read untouched legacy keys.
    store.delete(entry.cacheKey);
    await complete;
  } catch (error) {
    try { transaction.abort(); } catch { /* already finished/aborted */ }
    await complete.catch(() => {});
    throw error;
  }
}

/** All pages are read in one snapshot transaction: another tab cannot replace
 * the header or a later page halfway through this read. Missing/malformed
 * pages are cache misses, never partially usable generation results. */
export async function readGenerationCache<T extends GenerationEntry>(
  storage: OptionalCacheDatabase, db: IDBDatabase, storeName: string, cacheKey: string,
): Promise<T | undefined> {
  const transaction = db.transaction(storeName, 'readonly');
  const store = transaction.objectStore(storeName);
  const header = await storage.read<Header<T> | undefined>(store.get(key(cacheKey, -1)));
  if (!header?.format) return storage.read<T | undefined>(store.get(cacheKey));
  if (header.format !== FORMAT || header.value?.cacheKey !== cacheKey || !Array.isArray(header.arrays)
    || !Number.isSafeInteger(header.pageItems) || header.pageItems < 1) return;
  const value = header.value;
  const seen = new Set<string>();
  let page = 0;
  for (const { section, world, length } of header.arrays) {
    if (!sections.includes(section) || typeof world !== 'string' || !Number.isSafeInteger(length) || length < 0
      || !Object.hasOwn(value[section] ?? {}, world) || !Array.isArray(value[section][world])
      || value[section][world].length || seen.has(`${section}/${world}`)) return;
    seen.add(`${section}/${world}`);
    for (let offset = 0; offset < length;) {
      const count = Math.min(REQUEST_BATCH, Math.ceil((length - offset) / header.pageItems));
      const records = await storage.read<Page[]>(store.getAll(range(cacheKey, page, page + count - 1)));
      if (records.length !== count) return;
      for (const record of records) {
        if (record.cacheKey?.[2] !== page++ || record.timestamp !== header.timestamp || !Array.isArray(record.values)
          || record.values.length !== Math.min(header.pageItems, length - offset)) return;
        value[section][world].push(...record.values);
        offset += record.values.length;
      }
    }
  }
  for (const section of sections) for (const world of Object.keys(value[section] ?? {}))
    if (!seen.has(`${section}/${world}`)) return;
  return value;
}
