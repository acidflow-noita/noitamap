#!/usr/bin/env node
/** Attach a validated existing Sage seed record to each publishable daily world.
 * Run with: node --import tsx build_scripts/bake-sage-seed.mjs --out=/out
 * A binary schemaVersion of 4 does not mean the final V4 population is baked.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SageRecordReader, createBakedSageSnapshot, readBakedSageSnapshot, readBakedSageComparison, locateSageSeed } from '../src/sage/records.ts';
const worlds = ['left', 'middle', 'right'];
const pointerOrigin = 'https://daily-seed.acidflow.stream';
const censusOrigins = ['https://daily-middle.acidflow.stream', 'https://previous-daily-middle.acidflow.stream'];
async function atomicJSON(file, value) {
  const temporary = `${file}.sage-tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n'); await rename(temporary, file);
}
async function boundedText(fetcher, url, maximum) {
  const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000) });
  if (!response.ok || Number(response.headers.get('Content-Length')) > maximum) {
    await response.body?.cancel();
    throw new Error(`Invalid daily metadata response (HTTP ${response.status})`);
  }
  const stream = response.body?.getReader();
  if (!stream) throw new Error('Daily metadata response has no body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new Error('Daily metadata response is too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { await stream.cancel().catch(() => {}); stream.releaseLock(); }
}
async function dailyPointers(fetcher) {
  const results = await Promise.allSettled(['current', 'previous'].map(async kind => {
    const value = (await boundedText(fetcher, `${pointerOrigin}/${kind}_seed.txt`, 64)).trim();
    const seed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(seed) || seed < (kind === 'previous' ? 0 : 1) || seed > 0xffffffff)
      throw new Error(`Invalid ${kind} daily seed pointer`);
    return seed;
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    const error = new Error(failed.reason instanceof Error ? failed.reason.message : 'Daily pointers unavailable');
    error.observed = Object.fromEntries(results.flatMap((result, index) => result.status === 'fulfilled'
      ? [[index === 0 ? 'current' : 'previous', result.value]] : []));
    throw error;
  }
  return { current: results[0].value, previous: results[1].value };
}
const withoutComparison = ({ comparison, ...snapshot }) => snapshot;
const agreesWithObserved = (observed, seed, previousSeed) =>
  (observed?.current === undefined || observed.current === seed) &&
  (observed?.previous === undefined || observed.previous === previousSeed);
/** Resolve an existing previous-daily census, never another seed's pair.
 * Workers and pointers use bounded requests; the archive fallback is 806 bytes.
 * @param {number} seed
 * @param {{fetcher?: typeof fetch, reader?: Pick<import('../src/sage/records.ts').SageReader, 'read'>,
 * existing?: unknown, now?: () => Date}} [options]
 */
export async function resolveDailySageComparison(seed, {
  fetcher = fetch, reader = new SageRecordReader(fetcher), existing, now = () => new Date(),
} = {}) {
  const saved = readBakedSageComparison(existing, seed);
  const preserved = saved ? (({ record, ...comparison }) => comparison)(saved) : undefined;
  let before;
  try { before = await dailyPointers(fetcher); }
  catch (error) {
    const retained = saved && agreesWithObserved(error.observed, seed, saved.previousSeed) ? preserved : undefined;
    console.warn(`[sage] previous-daily pointers unavailable; ${retained ? 'retaining verified comparison' : 'comparison omitted'} (${error.message})`);
    return retained;
  }
  if (before.current !== seed || !before.previous || before.previous === seed) return undefined;
  try { locateSageSeed(before.previous); }
  catch { console.warn(`[sage] previous seed ${before.previous} is outside Sage coverage; comparison omitted`); return undefined; }
  let snapshot = saved?.previousSeed === before.previous ? withoutComparison(saved.snapshot) : null;
  if (!snapshot) {
    const candidates = await Promise.allSettled(censusOrigins.map(async origin => {
      const candidate = JSON.parse(await boundedText(fetcher, `${origin}/sage.json`, 256 * 1024));
      if (readBakedSageSnapshot(candidate, before.previous)) return withoutComparison(candidate);
      const embedded = readBakedSageComparison(candidate, seed);
      return embedded?.previousSeed === before.previous ? withoutComparison(embedded.snapshot) : null;
    }));
    snapshot = candidates.find(result => result.status === 'fulfilled' && result.value)?.value;
    if (!snapshot) {
      try {
        snapshot = createBakedSageSnapshot(before.previous, await reader.read(before.previous));
        if (!readBakedSageSnapshot(snapshot, before.previous)) throw new Error('Sage returned an invalid previous-daily record');
      } catch (error) {
        snapshot = createBakedSageSnapshot(before.previous, null, error instanceof Error ? error.message : 'Previous-daily Sage lookup failed');
      }
    }
  }
  let after;
  try { after = await dailyPointers(fetcher); }
  catch (error) {
    console.warn(`[sage] previous-daily pair could not be rechecked; new comparison omitted (${error.message})`);
    return saved?.previousSeed === before.previous && agreesWithObserved(error.observed, seed, before.previous) ? preserved : undefined;
  }
  if (after.current !== before.current || after.previous !== before.previous) {
    console.warn('[sage] daily pointers changed during lookup; comparison omitted');
    return undefined;
  }
  return { kind: 'previous-daily', currentSeed: seed, previousSeed: before.previous,
    observedAt: now().toISOString(), snapshot };
}
/** @param {string} directory
 * @param {{reader?: Pick<import('../src/sage/records.ts').SageReader, 'read'>, required?: boolean,
 * resolveComparison?: typeof resolveDailySageComparison}} [options]
 */
export async function attachSageToBake(directory, { reader = new SageRecordReader(), required = false, resolveComparison } = {}) {
  const seed = Number((await readFile(join(directory, 'seed.txt'), 'utf8')).trim());
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error('Invalid bake seed');
  const files = await Promise.all(worlds.map(async world => {
    const path = join(directory, world, 'generation.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.seed !== seed) throw new Error(`Mismatched ${world} generation seed`);
    return { world, path, data };
  }));
  // A resumed terrain bake already has immutable census data. Reuse only a
  // fully validated, identical snapshot across all worlds; repair sidecars too.
  const previous = files[0].data.sage;
  const identicalPrevious = previous && files.every(({ data }) => JSON.stringify(data.sage) === JSON.stringify(previous));
  let snapshot = previous && files.every(({ data }) => readBakedSageSnapshot(data.sage, seed)
    && JSON.stringify(data.sage) === JSON.stringify(previous)) ? previous : null;
  if (!snapshot) {
    try {
      snapshot = createBakedSageSnapshot(seed, await reader.read(seed));
      if (!readBakedSageSnapshot(snapshot, seed)) throw new Error('Sage returned an invalid or mismatched record');
    } catch (error) {
      if (required) throw error;
      snapshot = createBakedSageSnapshot(seed, null, error instanceof Error ? error.message : 'Sage lookup failed');
    }
  }
  if (resolveComparison) {
    // Current-record availability is independent of the already-baked previous
    // census; preserve that verified record even if retrying current still fails.
    const existing = identicalPrevious && readBakedSageComparison(previous, seed)
      ? { ...snapshot, comparison: previous.comparison } : snapshot;
    const comparison = await resolveComparison(seed, { reader, existing });
    snapshot = { ...withoutComparison(snapshot), ...(comparison ? { comparison } : {}) };
  }
  for (const { world, path, data } of files) {
    data.sage = snapshot;
    await atomicJSON(path, data);
    await atomicJSON(join(directory, world, 'sage.json'), snapshot);
  }
  console.log(`[sage] ${snapshot.status} for seed ${seed}; attached to all three worlds${snapshot.reason ? ` (${snapshot.reason})` : ''}`);
  return snapshot;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv.slice(2).find(arg => arg.startsWith('--out='))?.slice(6) ?? process.env.OUT_DIR ?? '/out';
  await attachSageToBake(resolve(out), { required: process.env.SAGE_REQUIRED === '1', resolveComparison: resolveDailySageComparison });
}
