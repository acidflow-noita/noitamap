import { afterEach, expect, it, vi } from 'vitest';
import { OptionalCacheDatabase } from '../src/telescope/cache-storage';
import { generationCacheRecords, readGenerationCache, writeGenerationCache } from '../src/telescope/generation-cache-records';
import { generationCacheDB } from './helpers/generation-cache-db';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const owner = () => new OptionalCacheDatabase('test-generation-pages', 14, () => {});
function entry(length: number, cacheKey = '42-all') {
  return { cacheKey, timestamp: Date.now(), seed: 42,
    tileLayers: [{ buffer: Uint8Array.from([0, 255, 1]).buffer, validChunks: ['1,0', '-2,3'] }],
    sage: { previous: 41 }, reportInventory: { worlds: { 0: { count: 3 } } },
    poisByPW: { '0,0': Array.from({ length }, (_, i) => ({ type: 'chest', x: i, value: NaN, missing: undefined,
      items: [{ type: 'wand', x: i + 0.5, cards: ['BOMB'] }] })), '-1,-1': [] },
    pixelScenesByPW: { '0,0': [{ x: 5, y: -25929, width: 512, height: 1139, name: 'watercave', imgData: null }] },
  };
}

it.each([0, 1, 1023, 1024, 1025, 4097])('round-trips %i POIs, metadata, undefined/NaN and native buffer bytes without changing input', async length => {
  const fixture = generationCacheDB(), storage = owner(), value = entry(length), before = structuredClone(value);
  await writeGenerationCache(storage, fixture.db, 'generations', value);
  expect(await readGenerationCache(storage, fixture.db, 'generations', value.cacheKey)).toEqual(value);
  expect(value).toEqual(before);
  const pages = [...fixture.records.values()].filter(record => record.values);
  expect(pages.every(page => page.values.length <= 1024)).toBe(true);
});

it('reads an untouched legacy generation and replaces it atomically with pages', async () => {
  const fixture = generationCacheDB(), storage = owner(), original = entry(4);
  fixture.records.set(original.cacheKey, structuredClone(original));
  expect(await readGenerationCache(storage, fixture.db, 'generations', original.cacheKey)).toEqual(original);
  const replacement = entry(1000);
  const writing = writeGenerationCache(storage, fixture.db, 'generations', replacement);
  expect(fixture.records.get(original.cacheKey)).toEqual(original);
  await writing;
  expect(fixture.records.has(original.cacheKey)).toBe(false);
  expect(await readGenerationCache(storage, fixture.db, 'generations', original.cacheKey)).toEqual(replacement);
});

it('rolls back failed replacement pages and retains the previous complete generation', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fixture = generationCacheDB(), storage = owner(), original = entry(1000);
  await writeGenerationCache(storage, fixture.db, 'generations', original);
  const before = structuredClone(fixture.records);
  fixture.failAfterPuts(3);
  await expect(writeGenerationCache(storage, fixture.db, 'generations', entry(2000))).rejects.toMatchObject({ name: 'DataCloneError' });
  expect(fixture.records).toEqual(before);
  fixture.allowPuts();
  expect(await readGenerationCache(owner(), fixture.db, 'generations', original.cacheKey)).toEqual(original);
});

it.each(['missing', 'short', 'timestamp'])('treats a %s page as a miss instead of publishing partial POIs', async damage => {
  const fixture = generationCacheDB(), storage = owner(), original = entry(2700);
  await writeGenerationCache(storage, fixture.db, 'generations', original);
  const [key, page] = [...fixture.records.entries()].find(([, record]) => record.cacheKey[2] === 1)!;
  if (damage === 'missing') fixture.records.delete(key);
  else if (damage === 'short') page.values.pop();
  else page.timestamp--;
  expect(await readGenerationCache(storage, fixture.db, 'generations', original.cacheKey)).toBeUndefined();
});

it('removes replaced surplus pages without touching another seed', async () => {
  const fixture = generationCacheDB(), storage = owner(), other = entry(800, '43-all');
  await writeGenerationCache(storage, fixture.db, 'generations', entry(4100));
  await writeGenerationCache(storage, fixture.db, 'generations', other);
  const small = entry(1);
  await writeGenerationCache(storage, fixture.db, 'generations', small);
  expect(fixture.records.size).toBe([...generationCacheRecords(small), ...generationCacheRecords(other)].length);
  expect(await readGenerationCache(storage, fixture.db, 'generations', '43-all')).toEqual(other);
});

it('uses the stored page size so future batch tuning does not invalidate existing records', async () => {
  const fixture = generationCacheDB(), storage = owner(), original = entry(5);
  const records = [...generationCacheRecords(original)];
  const header = structuredClone(records.at(-1)!) as any;
  header.pageItems = 2;
  const values = original.poisByPW['0,0'];
  for (const [index, page] of [values.slice(0, 2), values.slice(2, 4), values.slice(4), original.pixelScenesByPW['0,0']].entries()) {
    const cacheKey = ['generation-pages-v1', original.cacheKey, index];
    fixture.records.set(JSON.stringify(cacheKey), { cacheKey, timestamp: original.timestamp, values: structuredClone(page) });
  }
  fixture.records.set(JSON.stringify(header.cacheKey), header);
  expect(await readGenerationCache(storage, fixture.db, 'generations', original.cacheKey)).toEqual(original);
});

it.each(['version', 'size', 'missing world'])('rejects a malformed %s manifest as a miss', async damage => {
  const fixture = generationCacheDB(), storage = owner(), original = entry(100);
  await writeGenerationCache(storage, fixture.db, 'generations', original);
  const header = [...fixture.records.values()].find(record => record.format)!;
  if (damage === 'version') header.format = 'unsupported';
  else if (damage === 'size') header.pageItems = 0;
  else header.arrays.pop();
  expect(await readGenerationCache(storage, fixture.db, 'generations', original.cacheKey)).toBeUndefined();
});
