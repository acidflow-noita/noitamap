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
let cachedAt = 0;
let cachedPrevAt = 0;
let cachedSeed: number | null = null;
let cachedUTCDate: string | null = null;
let cachedPrevSeed: number | null = null;
let cachedPrevUTCDate: string | null = null;

/** Current UTC date as "YYYY-MM-DD" */
function currentUTCDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch the daily seed. Cached for at most a minute, never across UTC midnight. The seed publisher
 * may update after midnight, so a calendar-day cache can pin yesterday all day.
 * Explicit daily buttons force a fresh read.
 */
export async function fetchDailySeed(force = false): Promise<number> {
  const today = currentUTCDate();
  if (
    !force &&
    cachedSeed !== null &&
    cachedUTCDate === today &&
    Date.now() - cachedAt < CACHE_MS
  )
    return cachedSeed;

  const resp = await fetch(DAILY_SEED_URL, {
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

  cachedAt = Date.now();
  cachedSeed = seed;
  cachedUTCDate = today;
  return seed;
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
  const today = currentUTCDate();
  if (
    !force &&
    cachedPrevSeed !== null &&
    cachedPrevUTCDate === today &&
    Date.now() - cachedPrevAt < CACHE_MS
  )
    return cachedPrevSeed;

  try {
    const resp = await fetch(PREVIOUS_SEED_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const text = (await resp.text()).trim();
    const seed = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(seed) ||
      seed <= 0 ||
      seed > 0xffffffff
    )
      return null;
    cachedPrevAt = Date.now();
    cachedPrevSeed = seed;
    cachedPrevUTCDate = today;
    return seed;
  } catch {
    return null;
  }
}

/**
 * Clear the cached seeds (useful if you want to force re-fetch).
 */
export function clearDailySeedCache(): void {
  cachedSeed = null;
  cachedUTCDate = null;
  cachedPrevSeed = null;
  cachedPrevUTCDate = null;
}

/** Synchronous accessor for the cached previous-daily seed (today's UTC day
 *  only). Returns null if uncached, expired, or the worker hadn't responded
 *  yet. UI code uses this to recolour the seed input without awaiting another
 *  network round trip. */
export function getCachedPreviousDailySeed(): number | null {
  if (cachedPrevSeed !== null && cachedPrevUTCDate === currentUTCDate()) {
    return cachedPrevSeed;
  }
  return null;
}

/** Synchronous accessor for the cached current-daily seed. Same caveats as
 *  getCachedPreviousDailySeed. */
export function getCachedDailySeed(): number | null {
  if (cachedSeed !== null && cachedUTCDate === currentUTCDate()) {
    return cachedSeed;
  }
  return null;
}
