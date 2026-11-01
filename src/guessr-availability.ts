/** Guessr currently shares the dynamic-map deployment and its Pro integration. */
export function isGuessrAvailable(
  hostname: string,
  development = false,
): boolean {
  return (
    development ||
    [
      "dynamic-map.noitamap.com",
      "dynamic-map.noitamap.pages.dev",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "::1",
    ].includes(hostname.toLowerCase())
  );
}

export const GUESSR_CANONICAL_URL = "https://dynamic-map.noitamap.com/guess/";
