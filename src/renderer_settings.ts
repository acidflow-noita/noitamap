const RENDERER_STORAGE_KEY = 'noitamap-renderer';

export type RendererType = 'canvas' | 'webgl';

export const isRenderer = (v: unknown): v is RendererType => v === 'canvas' || v === 'webgl';

export function getStoredRenderer(): RendererType {
  // Force canvas for everyone: Chromium's webgl drawer produces visible
  // raster artifacts on POI overlays and highlight circles at certain zoom levels.
  return "canvas";
}

export function setStoredRenderer(renderer: RendererType) {
  localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
}
