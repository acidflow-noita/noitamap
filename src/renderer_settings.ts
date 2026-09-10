const RENDERER_STORAGE_KEY = 'noitamap-renderer';

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

/** Historical name shared by the renderer and generator. Public maps always
 * use approximate live terrain; completed baked pixels are loaded separately. */
export function isGLTerrainEnabled(): boolean {
  return fullPixelTerrainForBake;
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
