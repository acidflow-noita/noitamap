/**
 * daily_seed.ts
 *
 * Fetches the Noita daily seed from daily-seed.acidflow.stream,
 * a static-assets-only CF Worker updated once per day by a separate cron worker.
 *
 * The worker exposes both `current_seed.txt` (today's daily) and
 * `previous_seed.txt` (yesterday's). Both are cached until UTC midnight.
 *
 * If the user has the tab open across midnight, the next call will re-fetch.
 */

const DAILY_SEED_URL = "https://daily-seed.acidflow.stream/current_seed.txt";
const PREVIOUS_SEED_URL = "https://daily-seed.acidflow.stream/previous_seed.txt";

let cachedSeed: number | null = null;
let cachedUTCDate: string | null = null;
let cachedPrevSeed: number | null = null;
let cachedPrevUTCDate: string | null = null;

/** Current UTC date as "YYYY-MM-DD" */
function currentUTCDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch the daily seed. Cached until midnight UTC — if the UTC day
 * changes the cache is invalidated and a fresh fetch is made.
 */
export async function fetchDailySeed(): Promise<number> {
  const today = currentUTCDate();
  if (cachedSeed !== null && cachedUTCDate === today) return cachedSeed;

  const resp = await fetch(DAILY_SEED_URL);
  if (!resp.ok) throw new Error(`Daily seed fetch failed: ${resp.status}`);

  const text = await resp.text();
  const seed = parseInt(text.trim(), 10);
  if (isNaN(seed)) {
    throw new Error(`Could not parse daily seed from response: ${text}`);
  }

  cachedSeed = seed;
  cachedUTCDate = today;
  return seed;
}

/**
 * Fetch yesterday's daily seed. Same UTC-day caching as fetchDailySeed.
 * Returns null on network/parse failure (callers should treat as "unknown" —
 * the previous-daily worker is the source of truth, no localStorage fallback
 * here so the public map and pro behave the same on a fresh tab).
 */
export async function fetchPreviousDailySeed(): Promise<number | null> {
  const today = currentUTCDate();
  if (cachedPrevSeed !== null && cachedPrevUTCDate === today) return cachedPrevSeed;

  try {
    const resp = await fetch(PREVIOUS_SEED_URL);
    if (!resp.ok) return null;
    const seed = parseInt((await resp.text()).trim(), 10);
    if (!Number.isFinite(seed) || seed <= 0) return null;
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
