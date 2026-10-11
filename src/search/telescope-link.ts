export const TELESCOPE_URL = 'https://lymm37.github.io/noita-telescope/';

/** Keep the resolved seed, including for daily maps, and let Telescope's
 * search results choose the view. No camera parameters are transferred. */
export function telescopeSearchUrl(query: string, seed: number | null): string | undefined {
  if (!query.trim() || seed === null || !Number.isInteger(seed)
    || seed < 0 || seed > 2147483647) return;
  const url = new URL(TELESCOPE_URL);
  url.searchParams.set('seed', String(seed));
  url.searchParams.set('q', query.trim());
  return url.toString();
}
