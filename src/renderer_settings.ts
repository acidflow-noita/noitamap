const RENDERER_STORAGE_KEY = 'noitamap-renderer';
const HD_RENDERER_STORAGE_KEY = 'noitamap-hd-renderer';

export type RendererType = 'canvas' | 'webgl';

export const isRenderer = (v: unknown): v is RendererType => v === 'canvas' || v === 'webgl';

/**
 * Hostname-based dev override mirror. Kept inline (not imported from main.ts)
 * so renderer init has no module-graph dependency on app startup.
 */
function isLocalhost(): boolean {
  const h = (typeof window !== "undefined" && window.location && window.location.hostname) || "";
  return /^(localhost|127\.0\.0\.1|dev\.noitamap\.com)$/.test(h);
}

export function getStoredRenderer(): RendererType {
  // Instant terrain uses the canvas drawer's per-tile filtering and actual
  // tile-drawn lifecycle. A persisted local drawer experiment must not bypass
  // either contract; terrain itself still runs on the GPU in its worker.
  if (isInstantTerrainEnabled()) return "canvas";
  // Force canvas for everyone in production: Chromium's webgl drawer produces
  // visible raster artifacts on POI overlays and highlight circles at certain
  // zoom levels. Localhost is allowed to opt into webgl via the dev console
  // (window.noitamap.setRenderer("webgl")) so we can A/B perf + baked-DZI
  // fringing at zoom without shipping it to users.
  if (isLocalhost()) {
    const v = localStorage.getItem(RENDERER_STORAGE_KEY);
    if (isRenderer(v)) return v;
  }
  return "canvas";
}

export function setStoredRenderer(renderer: RendererType) {
  localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
}

export function clearStoredRenderer(): void {
  localStorage.removeItem(RENDERER_STORAGE_KEY);
}

// Full-pixel generation is an OFFLINE bake/diagnostic mode, not a browser
// preference. The old "noitamap-gl-terrain" storage value is deliberately never
// read: hiding the checkbox alone would leave returning users on the slow path.
let fullPixelTerrainForBake = false;

/** Historical name for offline full-pixel generation. Completed baked pixels
 * are loaded separately from the live renderer preference. */
export function isGLTerrainEnabled(): boolean {
  return fullPixelTerrainForBake;
}

/** Live GPU detail defaults on. Keep old diagnostic links usable, without
 * reviving the unrelated, slow offline-pyramid preference. */
export function isHDRendererEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location?.search ?? '').get('terrain');
    if (override === 'gpu') return true;
    if (override === 'approx') return false;
  }
  try {
    return localStorage.getItem(HD_RENDERER_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setHDRendererEnabled(enabled: boolean): void {
  let persisted = false;
  try {
    localStorage.setItem(HD_RENDERER_STORAGE_KEY, String(enabled));
    persisted = true;
  } catch {
    // Keep the choice through the required reload even if storage is blocked.
  }
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    if (persisted) url.searchParams.delete('terrain');
    else url.searchParams.set('terrain', enabled ? 'gpu' : 'approx');
    window.history.replaceState(window.history.state, '', url);
  }
}

/** GPU pixels at the requested display resolution, independent of the offline
 * native-resolution pyramid renderer. Native entrypoints select their mode. */
export function isInstantTerrainEnabled(): boolean {
  return !fullPixelTerrainForBake && typeof window !== 'undefined' &&
    isHDRendererEnabled();
}

/** Generation, worker data, material tables and cache identities must all use
 * the same fork, even when WebGL is unavailable and presentation falls back. */
export function useRenderPerfGeneration(): boolean {
  return isGLTerrainEnabled() || isInstantTerrainEnabled();
}

/** Internal native-entrypoint switch. Never expose this through UI, URL state,
 * localStorage, or the browser's noitamap console commands. */
export function setFullPixelTerrainForBake(enabled: boolean): void {
  fullPixelTerrainForBake = enabled;
}

/** Baked pixels do not require live full-pixel generation to be enabled. */
export function shouldUseBakedTerrain(search: string): boolean {
  return !new URLSearchParams(search).has("nb");
}
