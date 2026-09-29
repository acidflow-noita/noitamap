declare const OpenSeadragon: any;

export interface ViewportArtBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Physical display pixels per source pixel. */
  scale: number;
}

/** Draw decoded artwork directly into CanvasDrawer's current frame. Compose
 * with its existing transform: the drawer has already applied viewport flip,
 * while the coordinate conversion below includes image and viewport rotation. */
export function drawViewportArt(
  context: CanvasRenderingContext2D,
  item: any,
  viewport: any,
  width: number,
  height: number,
  draw: (bounds: ViewportArtBounds) => void,
): boolean {
  if (!item.imageToViewportCoordinates || !viewport.pixelFromPoint)
    return false;
  const density =
    (typeof OpenSeadragon !== "undefined" && OpenSeadragon.pixelDensityRatio) ||
    globalThis.devicePixelRatio ||
    1;
  const point = (x: number, y: number) =>
    viewport.pixelFromPoint(item.imageToViewportCoordinates(x, y, true), true);
  const p = point(0, 0),
    px = point(1, 0),
    py = point(0, 1);
  const a = (px.x - p.x) * density,
    b = (px.y - p.y) * density;
  const c = (py.x - p.x) * density,
    d = (py.y - p.y) * density;
  const e = p.x * density,
    f = p.y * density;
  if (
    ![a, b, c, d, e, f].every(Number.isFinite) ||
    Math.abs(a * d - b * c) < 1e-20
  )
    return false;
  context.save();
  try {
    context.transform(a, b, c, d, e, f);
    // Source-level flips are independent of the viewport's drawer transform.
    if (item.getFlip?.()) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    const m = context.getTransform(),
      determinant = m.a * m.d - m.b * m.c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20)
      return false;
    const corners = [
      [0, 0],
      [context.canvas.width, 0],
      [0, context.canvas.height],
      [context.canvas.width, context.canvas.height],
    ].map(([x, y]) => ({
      x: (m.d * (x - m.e) - m.c * (y - m.f)) / determinant,
      y: (-m.b * (x - m.e) + m.a * (y - m.f)) / determinant,
    }));
    const left = Math.max(0, Math.min(...corners.map((p) => p.x)));
    const top = Math.max(0, Math.min(...corners.map((p) => p.y)));
    const right = Math.min(width, Math.max(...corners.map((p) => p.x)));
    const bottom = Math.min(height, Math.max(...corners.map((p) => p.y)));
    if (right <= left || bottom <= top) return true;
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha *= item.opacity ?? 1;
    const scale = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    // Preserve source pixels at 1:1 and when magnified; average their colour
    // when shrinking, as the baked map's reduced levels do.
    context.imageSmoothingEnabled = scale < 1 - 1e-9;
    context.imageSmoothingQuality = 'high';
    draw({ left, top, right, bottom, scale });
    return true;
  } finally {
    context.restore();
  }
}
