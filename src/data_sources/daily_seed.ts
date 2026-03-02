/**
 * daily_seed.ts
 *
 * Fetches the Noita daily seed from Nolla's endpoint.
 * The fetch happens from the end user's browser — not from the deployment.
 *
 * The daily seed changes at midnight UTC, so the cache is keyed by UTC date.
 * If the user has the tab open across midnight, the next call will re-fetch.
 */

const DAILY_SEED_URL = "https://takapuoli.noitagame.com/callback";

let cachedSeed: number | null = null;
let cachedUTCDate: string | null = null;

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
  // Response format: "field0;seedNumber;field2;..." — seed is at index 1
  const parts = text.split(";");
  const seed = parseInt(parts[1], 10);
  if (isNaN(seed)) throw new Error(`Could not parse daily seed from: ${text}`);

  cachedSeed = seed;
  cachedUTCDate = today;
  return seed;
}

/**
 * Clear the cached seed (useful if you want to force re-fetch).
 */
export function clearDailySeedCache(): void {
  cachedSeed = null;
  cachedUTCDate = null;
}
