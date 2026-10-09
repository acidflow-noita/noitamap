/** Published viewport frames are immutable. The display, history and cache
 * share their pixels and each release one reference; OSD tiles still copy. */
const references = new WeakMap<object, number>();

export function ownTerrainFrame(canvas: HTMLCanvasElement): HTMLCanvasElement {
  if (references.has(canvas)) throw new Error('Terrain frame already has an owner');
  references.set(canvas, 1);
  return canvas;
}

export function retainTerrainFrame(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const count = references.get(canvas);
  if (!count) throw new Error('Cannot retain a released terrain frame');
  references.set(canvas, count + 1);
  return canvas;
}

export function releaseTerrainImage(image: CanvasImageSource): void {
  const count = references.get(image);
  if (count && count > 1) { references.set(image, count - 1); return; }
  references.delete(image);
  const owned = image as any;
  if (typeof owned.close === 'function') owned.close();
  else if (typeof owned.getContext === 'function') owned.width = owned.height = 0;
}
