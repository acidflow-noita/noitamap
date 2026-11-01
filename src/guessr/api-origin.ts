/** Shared origin selection without importing the browser's account/UI modules. */
export function gameApiOrigin(): string | null {
  const value = import.meta.env.VITE_GUESSR_API_URL ||
    (import.meta.env.PROD && typeof location !== 'undefined' && location.hostname === 'dynamic-map.noitamap.com'
      ? 'https://guessr-api.sage-data.xyz' : null);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}
