const RENDERER_STORAGE_KEY = 'noitamap-renderer';

export type RendererType = 'canvas' | 'webgl';

export function getStoredRenderer(): RendererType {
  return (localStorage.getItem(RENDERER_STORAGE_KEY) as RendererType) || 'canvas';
}

export function setStoredRenderer(renderer: RendererType) {
  localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
}
