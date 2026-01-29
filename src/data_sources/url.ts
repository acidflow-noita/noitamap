import type { AppState } from '../app';

import { asMapName } from './tile_data';
import { isValidOverlayKey, OverlayKey } from './overlays';

/**
 * Extended app state with overlays, drawing, and sidebar
 */
export interface URLState extends Partial<AppState> {
  overlays?: OverlayKey[];
  drawing?: string;
  sidebarOpen?: boolean;
}

/**
 * Desired URL param order: x, y, zoom, map, overlays, sidebar, drawing (drawing always last)
 */
const PARAM_ORDER = ['x', 'y', 'zoom', 'map', 'overlays', 'sidebar', 'drawing'];

/**
 * Reorder URL search params to maintain consistent order (drawing always last)
 */
function reorderParams(url: URL): void {
  const params: [string, string][] = [];

  // Collect all params in desired order
  for (const key of PARAM_ORDER) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      params.push([key, value]);
    }
  }

  // Clear and re-add in order
  for (const key of PARAM_ORDER) {
    url.searchParams.delete(key);
  }
  for (const [key, value] of params) {
    url.searchParams.set(key, value);
  }
}

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
export function parseURL(): URLState {
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

  // Parse overlays
  const overlaysParam = url.searchParams.get('overlays');
  const overlays: OverlayKey[] = [];
  if (overlaysParam) {
    for (const key of overlaysParam.split(',')) {
      if (isValidOverlayKey(key)) {
        overlays.push(key);
      }
    }
  }

  // Get drawing param (encoded string)
  const drawing = url.searchParams.get('drawing') ?? undefined;

  // Get sidebar open state
  const sidebarOpen = url.searchParams.get('sidebar') === 'open';

  return { pos, map, overlays, drawing, sidebarOpen };
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
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Get currently enabled overlays from the DOM
 */
export function getEnabledOverlays(): OverlayKey[] {
  const overlays: OverlayKey[] = [];
  const togglers = document.querySelectorAll('.overlayToggler:checked');
  for (const toggler of togglers) {
    if (toggler instanceof HTMLInputElement) {
      const key = toggler.dataset.overlayKey;
      if (isValidOverlayKey(key)) {
        overlays.push(key);
      }
    }
  }
  return overlays;
}

/**
 * Update URL with overlays state
 */
export function updateURLWithOverlays(overlays: OverlayKey[]) {
  const url = new URL(window.location.toString());
  if (overlays.length > 0) {
    url.searchParams.set('overlays', overlays.join(','));
  } else {
    url.searchParams.delete('overlays');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Update URL with drawing data
 */
export function updateURLWithDrawing(drawing: string | null) {
  const url = new URL(window.location.toString());
  if (drawing) {
    url.searchParams.set('drawing', drawing);
  } else {
    url.searchParams.delete('drawing');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Update URL with sidebar open state
 */
export function updateURLWithSidebar(isOpen: boolean) {
  const url = new URL(window.location.toString());
  if (isOpen) {
    url.searchParams.set('sidebar', 'open');
  } else {
    url.searchParams.delete('sidebar');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}
