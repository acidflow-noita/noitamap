const RENDERER_STORAGE_KEY = 'noitamap-renderer';

export type RendererType = 'canvas' | 'webgl';

export const isRenderer = (v: unknown): v is RendererType => v === 'canvas' || v === 'webgl';

export function getStoredRenderer(): RendererType {
  // assign it a variable, so typescript can associate a type with the variable
  const item = localStorage.getItem(RENDERER_STORAGE_KEY);
  return isRenderer(item) ? item : 'webgl';
}

export function setStoredRenderer(renderer: RendererType) {
  localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
}
