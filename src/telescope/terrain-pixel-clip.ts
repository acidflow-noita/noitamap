export interface TerrainPixelRect { x: number; y: number; width: number; height: number }

/** Clip an unrotated terrain working surface at physical-pixel boundaries.
 * Canvas path antialiasing must not turn a known terrain block into a partial
 * erasure. Camera rotation happens later, when OSD presents the finished frame.
 * `inside` excludes a saved frame's outer partial pixels; the fresh frame
 * underneath already owns them and has the correct camera sampling. */
export function clipTerrainPixels(
  context: CanvasRenderingContext2D,
  rectangles: readonly TerrainPixelRect[],
  rounding: 'center' | 'inside' = 'center',
): void {
  const m = context.getTransform();
  if (m.b !== 0 || m.c !== 0) throw new Error('Terrain working surfaces must be axis aligned');
  context.resetTransform();
  context.beginPath();
  for (const rect of rectangles) {
    const x0 = m.a * rect.x + m.e, x1 = m.a * (rect.x + rect.width) + m.e;
    const y0 = m.d * rect.y + m.f, y1 = m.d * (rect.y + rect.height) + m.f;
    const left = Math.ceil(Math.min(x0, x1) - (rounding === 'center' ? .5 : 0));
    const top = Math.ceil(Math.min(y0, y1) - (rounding === 'center' ? .5 : 0));
    const right = rounding === 'center' ? Math.ceil(Math.max(x0, x1) - .5) : Math.floor(Math.max(x0, x1));
    const bottom = rounding === 'center' ? Math.ceil(Math.max(y0, y1) - .5) : Math.floor(Math.max(y0, y1));
    if (right > left && bottom > top) context.rect(left, top, right - left, bottom - top);
  }
  context.clip();
  context.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}
