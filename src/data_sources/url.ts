import type { AppState } from '../app';

import { asMapName, type MapName } from './tile_data';
import { isValidOverlayKey, OverlayKey } from './overlays';
import {
  overlayToShort,
  shortToOverlay,
  mapToShort,
  shortToMap,
  sidebarToShort,
  shortToSidebar,
} from './param-mappings';

/**
 * Extended app state with overlays and sidebar
 */
export interface URLState extends Partial<AppState> {
  overlays?: OverlayKey[];
  sidebarOpen?: boolean;
  canvas?: 'map' | 'black' | 'white';
  /** Seed number for dynamic map */
  seed?: number;
  /** Daily seed flag — if true, seed came from daily fetch */
  dailySeed?: boolean;
}

/**
 * Desired URL param order: x, y, z (zoom), m (map), se (seed), ds (daily seed), o (overlays), s (sidebar), c (canvas)
 * Short params used for encoding, decoder accepts both short and long names
 */
const PARAM_ORDER = ['x', 'y', 'z', 'm', 'se', 'ds', 'o', 's', 'c'];

/**
 * Reorder URL search params to maintain consistent order
 * Also cleans up old long param names, replacing them with short versions
 */
function reorderParams(url: URL): void {
  const params: [string, string][] = [];

  // Map old param names to new short names for cleanup
  const OLD_TO_NEW: Record<string, string> = {
    zoom: 'z',
    map: 'm',
    overlays: 'o',
    sidebar: 's',
    canvas: 'c',
  };

  // Collect all params in desired order
  for (const key of PARAM_ORDER) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      params.push([key, value]);
    }
  }

  // Clear short params and old long params
  for (const key of PARAM_ORDER) {
    url.searchParams.delete(key);
  }
  for (const oldKey of Object.keys(OLD_TO_NEW)) {
    url.searchParams.delete(oldKey);
  }

  // Re-add in order
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
 * Get param value, checking both short and long names
 */
function getParam(url: URL, shortName: string, longName: string): string | null {
  return url.searchParams.get(shortName) ?? url.searchParams.get(longName);
}

/**
 * Take the window's URL and return partial application state
 * Accepts both short (z, m, o, s) and long (zoom, map, overlays, sidebar) param names
 */
export function parseURL(): URLState {
  const url = new URL(window.location.toString());

  const x = intQueryValue(url.searchParams.get('x'));
  const y = intQueryValue(url.searchParams.get('y'));

  const logZoom = intQueryValue(getParam(url, 'z', 'zoom'));
  const zoom = logZoom !== null ? Math.pow(2, logZoom / -100) : null;

  // Accept both short and long map names
  const mapParam = getParam(url, 'm', 'map');
  const map = mapParam ? (shortToMap(mapParam) ?? asMapName(mapParam)) : undefined;

  let pos = undefined;
  if (x !== null && y !== null && zoom !== null) {
    pos = { x, y, zoom };
  }

  // Parse overlays - accept both short (o) and long (overlays) param names
  // and both short (st, bo, etc.) and long (structures, bosses, etc.) values
  const overlaysParam = getParam(url, 'o', 'overlays');
  const overlays: OverlayKey[] = [];
  if (overlaysParam) {
    for (const key of overlaysParam.split(',')) {
      const overlay = shortToOverlay(key);
      if (overlay) {
        overlays.push(overlay);
      } else if (isValidOverlayKey(key)) {
        // Fallback for any valid overlay key not in mapping
        overlays.push(key);
      }
    }
  }

  // Get sidebar open state - accept both short and long param names and values
  const sidebarParam = getParam(url, 's', 'sidebar');
  const sidebarOpen = shortToSidebar(sidebarParam);

  // Get canvas background - accept both short and long param names
  const canvasParam = getParam(url, 'c', 'canvas');
  let canvas: 'map' | 'black' | 'white' | undefined = undefined;
  if (canvasParam === 'b' || canvasParam === 'black') {
    canvas = 'black';
  } else if (canvasParam === 'w' || canvasParam === 'white') {
    canvas = 'white';
  } else if (canvasParam === 'm' || canvasParam === 'map') {
    canvas = 'map';
  }

  // Parse seed params for dynamic map
  const seedParam = url.searchParams.get('se');
  const seed = seedParam !== null ? intQueryValue(seedParam) ?? undefined : undefined;
  const dsParam = url.searchParams.get('ds');
  const dailySeed = dsParam === '1' || dsParam === 'true' || undefined;

  return { pos, map, overlays, sidebarOpen, canvas, seed, dailySeed };
}

/**
 * Take complete application state and write it to the window's URL
 * Uses short param names for compact URLs
 */
export function updateURL(data: AppState) {
  const url = new URL(window.location.toString());

  url.searchParams.set('x', data.pos.x.toFixed(0));
  url.searchParams.set('y', data.pos.y.toFixed(0));
  url.searchParams.set('z', (Math.log2(data.pos.zoom) * -100).toFixed(0));
  url.searchParams.set('m', mapToShort(data.map as MapName));
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
 * Update URL with overlays state (uses short param name and values)
 */
export function updateURLWithOverlays(overlays: OverlayKey[]) {
  const url = new URL(window.location.toString());
  if (overlays.length > 0) {
    const shortOverlays = overlays.map(overlayToShort);
    url.searchParams.set('o', shortOverlays.join(','));
  } else {
    url.searchParams.delete('o');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Update URL with sidebar open state (uses short param name and value)
 */
export function updateURLWithSidebar(isOpen: boolean) {
  const url = new URL(window.location.toString());
  const shortValue = sidebarToShort(isOpen);
  if (shortValue) {
    url.searchParams.set('s', shortValue);
  } else {
    url.searchParams.delete('s');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Update URL with canvas background state (uses short param name and short values)
 */
export function updateURLWithCanvas(canvas: 'map' | 'black' | 'white') {
  const url = new URL(window.location.toString());
  if (canvas === 'map') {
    url.searchParams.delete('c');
  } else {
    const shortVal = canvas === 'black' ? 'b' : 'w';
    url.searchParams.set('c', shortVal);
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Update URL with seed params for dynamic map
 */
export function updateURLWithSeed(seed: number, isDailySeed: boolean) {
  const url = new URL(window.location.toString());
  url.searchParams.set('se', seed.toString());
  if (isDailySeed) {
    url.searchParams.set('ds', '1');
  } else {
    url.searchParams.delete('ds');
  }
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Clear seed params from the URL
 */
export function clearSeedParams() {
  const url = new URL(window.location.toString());
  url.searchParams.delete('se');
  url.searchParams.delete('ds');
  reorderParams(url);
  window.history.replaceState(null, '', url.toString());
}
