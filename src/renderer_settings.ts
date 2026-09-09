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

// ─── GPU final-pixel terrain (render-perf port) ──────────────────────────────

const GL_TERRAIN_KEY = "noitamap-gl-terrain";

/** Opt-in full-pixel terrain. Reload when changing it to select one complete fork. */
export function isGLTerrainEnabled(): boolean {
  try {
    return localStorage.getItem(GL_TERRAIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGLTerrain(enabled: boolean): void {
  try {
    localStorage.setItem(GL_TERRAIN_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** Full-pixel compatibility is checked against the manifest, not the seed URL. */
export function shouldUseBakedTerrain(search: string, fullPixels = isGLTerrainEnabled()): boolean {
  return !new URLSearchParams(search).has("nb");
}
