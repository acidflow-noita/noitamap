/**
 * URL parameter value mappings for compact URLs
 *
 * Encoder uses short values, decoder accepts both short and full for backward compatibility.
 */

import type { OverlayKey } from './overlays';
import type { MapName } from './tile_data';

// Overlay short codes
const OVERLAY_SHORT_TO_FULL: Record<string, OverlayKey> = {
  st: 'structures',
  it: 'items',
  bo: 'bosses',
  or: 'orbs',
  sa: 'spatialAwareness',
  bb: 'biomeBoundaries',
  hm: 'hiddenMessages',
};

const OVERLAY_FULL_TO_SHORT: Record<OverlayKey, string> = {
  structures: 'st',
  items: 'it',
  bosses: 'bo',
  orbs: 'or',
  spatialAwareness: 'sa',
  biomeBoundaries: 'bb',
  hiddenMessages: 'hm',
};

// Map name short codes
const MAP_SHORT_TO_FULL: Record<string, MapName> = {
  r: 'regular-main-branch',
  n: 'new-game-plus-main-branch',
  nm: 'nightmare-main-branch',
  ab: 'apotheosis-beta-branch',
  rb: 'regular-beta',
  p: 'purgatory',
  an: 'apotheosis-new-game-plus',
  at: 'apotheosis-tuonela',
  nv: 'noitavania',
  nn: 'noitavania-new-game-plus',
  al: 'alternate-biomes',
  de: 'deepend-main-branch',
  bm: 'biomemap-main-branch',
  br: 'biomemaprendered-main-branch',
  mt: 'maptestdev',
};

const MAP_FULL_TO_SHORT: Record<MapName, string> = {
  'regular-main-branch': 'r',
  'new-game-plus-main-branch': 'n',
  'nightmare-main-branch': 'nm',
  'apotheosis-beta-branch': 'ab',
  'regular-beta': 'rb',
  'purgatory': 'p',
  'apotheosis-new-game-plus': 'an',
  'apotheosis-tuonela': 'at',
  'noitavania': 'nv',
  'noitavania-new-game-plus': 'nn',
  'alternate-biomes': 'al',
  'deepend-main-branch': 'de',
  'biomemap-main-branch': 'bm',
  'biomemaprendered-main-branch': 'br',
  'maptestdev': 'mt',
};

/**
 * Convert overlay key to short code for URL encoding
 */
export function overlayToShort(key: OverlayKey): string {
  return OVERLAY_FULL_TO_SHORT[key] ?? key;
}

/**
 * Convert short code or full name to overlay key (for decoding)
 * Returns undefined if not a valid overlay
 */
export function shortToOverlay(code: string): OverlayKey | undefined {
  // Try short code first
  if (code in OVERLAY_SHORT_TO_FULL) {
    return OVERLAY_SHORT_TO_FULL[code];
  }
  // Try full name (backward compat)
  if (code in OVERLAY_FULL_TO_SHORT) {
    return code as OverlayKey;
  }
  return undefined;
}

/**
 * Convert map name to short code for URL encoding
 */
export function mapToShort(name: MapName): string {
  return MAP_FULL_TO_SHORT[name] ?? name;
}

/**
 * Convert short code or full name to map name (for decoding)
 * Returns undefined if not a valid map
 */
export function shortToMap(code: string): MapName | undefined {
  // Try short code first
  if (code in MAP_SHORT_TO_FULL) {
    return MAP_SHORT_TO_FULL[code];
  }
  // Try full name (backward compat)
  if (code in MAP_FULL_TO_SHORT) {
    return code as MapName;
  }
  return undefined;
}

/**
 * Convert sidebar value to short code
 */
export function sidebarToShort(isOpen: boolean): string | null {
  return isOpen ? '1' : null;
}

/**
 * Convert short code or full value to sidebar state (for decoding)
 */
export function shortToSidebar(value: string | null): boolean {
  if (!value) return false;
  return value === '1' || value === 'open';
}
