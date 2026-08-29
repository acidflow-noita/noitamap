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
const GL_TERRAIN_SS_KEY = "noitamap-gl-terrain-supersample";

/**
 * The WebGL2 final-pixel biome renderer (src/telescope/gl-terrain-tile-source.ts).
 *
 * OFF by default while it is being brought up: it replaces the biome layer
 * wholesale, so it stays opt-in until it has been compared against the CPU
 * composite path on real seeds.
 *   noitamap.setGLTerrain(true)   -> opt in, reload
 */
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

/**
 * Max supersample factor for zoomed-out tiles.
 *
 * A tile pixel covering N world pixels is rendered at N x tile size and filtered
 * down, so no final-pixel detail is lost when zooming out. The cap bounds the
 * cost: at 8 a 512px tile renders 4096x4096 (~67 MB of GPU-side pixels) before
 * reduction, which is fine as a one-off per tile but is the knob to turn if tile
 * generation becomes the bottleneck. 1 disables supersampling entirely and gives
 * the aliased point-sampled look upstream avoided by disabling detail instead.
 */
export function getGLTerrainSupersampleCap(): number {
  try {
    const v = Number(localStorage.getItem(GL_TERRAIN_SS_KEY));
    if (Number.isFinite(v) && v >= 1 && v <= 16) return Math.round(v);
  } catch {
    /* fall through */
  }
  return 8;
}

export function setGLTerrainSupersampleCap(n: number): void {
  try {
    localStorage.setItem(GL_TERRAIN_SS_KEY, String(Math.max(1, Math.min(16, Math.round(n)))));
  } catch {
    /* storage unavailable */
  }
}

