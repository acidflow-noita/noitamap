/**
 * daily_seed.ts
 *
 * Fetches the Noita daily seed from daily-seed.acidflow.stream,
 * a static-assets-only CF Worker updated once per day by a separate cron worker.
 *
 * The worker exposes both `current_seed.txt` (today's daily) and
 * `previous_seed.txt` (yesterday's). Both use a short cache which also expires at UTC midnight.
 *
 * If the user has the tab open across midnight, the next call will re-fetch.
 */

const DAILY_SEED_URL = "https://daily-seed.acidflow.stream/current_seed.txt";
const PREVIOUS_SEED_URL =
  "https://daily-seed.acidflow.stream/previous_seed.txt";

const CACHE_MS = 60_000;
interface SeedRequest {
  utcDate: string;
  promise: Promise<number>;
}
interface SeedCache {
  at: number;
  seed: number | null;
  utcDate: string | null;
  pending: SeedRequest | null;
}
const daily: SeedCache = { at: 0, seed: null, utcDate: null, pending: null };
const previous: SeedCache = { at: 0, seed: null, utcDate: null, pending: null };

/** Current UTC date as "YYYY-MM-DD" */
function currentUTCDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch the daily seed. Cached for at most a minute, never across UTC midnight. The seed publisher
 * may update after midnight, so a calendar-day cache can pin yesterday all day.
 * Explicit daily buttons force a fresh read.
 */
function fetchSeed(cache: SeedCache, url: string, force: boolean): Promise<number> {
  const today = currentUTCDate();
  // The toolbar, URL resolver and early baked-map probe share one cold read.
  // A manual refresh starts a new read; subsequent normal callers join it.
  if (!force && cache.pending?.utcDate === today) return cache.pending.promise;
  if (
    !force &&
    cache.seed !== null &&
    cache.utcDate === today &&
    Date.now() - cache.at < CACHE_MS
  )
    return Promise.resolve(cache.seed);

  const request: SeedRequest = {
    utcDate: today,
    promise: readSeed(url).then((seed) => {
      // Superseded requests still resolve for their original callers, but may
      // not repopulate a cleared cache or overwrite a newer manual refresh.
      if (cache.pending === request && currentUTCDate() === today) {
        cache.at = Date.now();
        cache.seed = seed;
        cache.utcDate = today;
      }
      return seed;
    }).finally(() => {
      if (cache.pending === request) cache.pending = null;
    }),
  };
  cache.pending = request;
  return request.promise;
}

async function readSeed(url: string): Promise<number> {
  const resp = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Daily seed fetch failed: ${resp.status}`);

  const text = await resp.text();
  const seed = Number(text.trim());
  if (
    !/^\d+$/.test(text.trim()) ||
    !Number.isSafeInteger(seed) ||
    seed <= 0 ||
    seed > 0xffffffff
  ) {
    throw new Error(`Could not parse daily seed from response: ${text}`);
  }

  return seed;
}

export function fetchDailySeed(force = false): Promise<number> {
  return fetchSeed(daily, DAILY_SEED_URL, force);
}

/**
 * Fetch yesterday's daily seed. Same short caching as fetchDailySeed.
 * Returns null on network/parse failure (callers should treat as "unknown" —
 * the previous-daily worker is the source of truth, no localStorage fallback
 * here so the public map and pro behave the same on a fresh tab).
 */
export async function fetchPreviousDailySeed(
  force = false,
): Promise<number | null> {
  try {
    return await fetchSeed(previous, PREVIOUS_SEED_URL, force);
  } catch {
    return null;
  }
}

/**
 * Clear the cached seeds (useful if you want to force re-fetch).
 */
export function clearDailySeedCache(): void {
  for (const cache of [daily, previous]) {
    cache.at = 0;
    cache.seed = null;
    cache.utcDate = null;
    cache.pending = null;
  }
}

/** Synchronous accessor for the cached previous-daily seed (today's UTC day
 *  only). Returns null if uncached, expired, or the worker hadn't responded
 *  yet. UI code uses this to recolour the seed input without awaiting another
 *  network round trip. */
export function getCachedPreviousDailySeed(): number | null {
  if (previous.seed !== null && previous.utcDate === currentUTCDate()) {
    return previous.seed;
  }
  return null;
}

/** Synchronous accessor for the cached current-daily seed. Same caveats as
 *  getCachedPreviousDailySeed. */
export function getCachedDailySeed(): number | null {
  if (daily.seed !== null && daily.utcDate === currentUTCDate()) {
    return daily.seed;
  }
  return null;
}

/** Label a comparison from the same daily identity used by the seed controls.
 * The broad map isDaily flag also includes older bakes, so it cannot do this.
 * A missing previous pointer need not hide the known "yesterday" identity. */
export function getCachedDailyComparisonTarget(seed: number): { kind: 'today' | 'previous'; seed?: number } | null {
  const today = getCachedDailySeed(), previous = getCachedPreviousDailySeed();
  if (today === null || today === previous) return null;
  if (seed === today) return previous === null ? { kind: 'previous' } : { kind: 'previous', seed: previous };
  return { kind: 'today', seed: today };
}

/** The selected seed's identity, shared by the toolbar and report heading. */
export function getCachedDailySeedIdentity(seed: number): 'today' | 'previous' | null {
  const today = getCachedDailySeed(), previous = getCachedPreviousDailySeed();
  if (previous !== null && seed === previous) return 'previous';
  if (today !== null && seed === today) return 'today';
  return null;
}
