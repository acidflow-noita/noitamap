const RENDERER_STORAGE_KEY = 'noitamap-renderer';

export type RendererType = 'canvas' | 'webgl';

export const isRenderer = (v: unknown): v is RendererType => v === 'canvas' || v === 'webgl';

export function getStoredRenderer(): RendererType {
  // Keep the compatible default, but honor an explicit choice on deployed
  // sites too. AppOSD checks WebGL support before constructing its drawer.
  try {
    const v = localStorage.getItem(RENDERER_STORAGE_KEY);
    if (isRenderer(v)) return v;
  } catch { /* Storage may be disabled. */ }
  return "canvas";
}

export function setStoredRenderer(renderer: RendererType) {
  localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
}

export function clearStoredRenderer(): void {
  localStorage.removeItem(RENDERER_STORAGE_KEY);
}

// Full pixels are the default. An explicit performance opt-out stays saved.
const LIVE_PIXEL_KEY = 'noitamap-full-pixels-v2';
let fullPixelTerrainForBake = false;

export function isFullPixelBake(): boolean {
  return fullPixelTerrainForBake;
}

export function isGLTerrainEnabled(): boolean {
  if (fullPixelTerrainForBake) return true;
  try { return localStorage.getItem(LIVE_PIXEL_KEY) !== '0'; }
  catch { return true; }
}

/** Reload after changing modes so generator, scene data and renderer agree. */
export function setGLTerrain(enabled: boolean): void {
  try { localStorage.setItem(LIVE_PIXEL_KEY, enabled ? '1' : '0'); }
  catch { /* The caller can still display the current effective setting. */ }
}

export function setFullPixelTerrainForBake(enabled: boolean): void {
  fullPixelTerrainForBake = enabled;
}

/** Baked pixels do not require live full-pixel generation to be enabled. */
export function shouldUseBakedTerrain(search: string): boolean {
  return !new URLSearchParams(search).has("nb");
}
