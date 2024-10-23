import type { AppState } from '../app';

import { asMapName } from './tile_data';

/**
 * Given a value from the query string, return a number if it's a valid integer
 * or null if it's invalid
 */
export const intQueryValue = (value: string | null): number | null => {
  if (value === null) return null;

  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return null;
  return num;
};

/**
 * Take the window's URL and return partial application state
 */
export function parseURL(): Partial<AppState> {
  const url = new URL(window.location.toString());

  const x = intQueryValue(url.searchParams.get('x'));
  const y = intQueryValue(url.searchParams.get('y'));

  const logZoom = intQueryValue(url.searchParams.get('zoom'));
  const zoom = logZoom !== null ? Math.pow(2, logZoom / -100) : null;

  const map = asMapName(url.searchParams.get('map') ?? '');

  let pos = undefined;
  if (x !== null && y !== null && zoom !== null) {
    pos = { x, y, zoom };
  }

  return { pos, map };
}

/**
 * Take complete application state and write it to the window's URL
 */
export function updateURL(data: AppState) {
  const url = new URL(window.location.toString());

  url.searchParams.set('x', data.pos.x.toFixed(0));
  url.searchParams.set('y', data.pos.y.toFixed(0));
  url.searchParams.set('zoom', (Math.log2(data.pos.zoom) * -100).toFixed(0));
  url.searchParams.set('map', data.map);
  window.history.replaceState(null, '', url.toString());
}
