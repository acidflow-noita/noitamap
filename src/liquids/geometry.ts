import { reprojectCamera, type CameraMatrix } from '../portals/geometry';
import { MAX_MASK_PIXELS, type MaskBounds } from './mask-index';
export const LIQUID_ENTER_SCALE = 0.75;
export const LIQUID_EXIT_SCALE = 0.5;
export const LIQUID_MAX_FRAME_PIXELS = 4 * 1024 * 1024;
// Guaranteed WebGL2 texture dimension. Large/high-DPI views use a bounded
// presentation surface instead of disabling animation as a pool fills it.
export const LIQUID_MAX_FRAME_DIMENSION = 2048;

export function inverseCamera(m: CameraMatrix): CameraMatrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Object.values(m).every(Number.isFinite) || !Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  const inverse = { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
  return Object.values(inverse).every(Number.isFinite) ? inverse : null;
}
function boundsOf(m: CameraMatrix, rect: MaskBounds) {
  const points = [[rect.x, rect.y], [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]];
  const xs = points.map(([x, y]) => m.a * x + m.c * y + m.e);
  const ys = points.map(([x, y]) => m.b * x + m.d * y + m.f);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}
export function liquidBoundsContain(outer: MaskBounds, inner: MaskBounds) {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}
export function liquidBoundsOverlap(a: MaskBounds, b: MaskBounds) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
export function visibleLiquidBounds(camera: CameraMatrix, mask: MaskBounds, width: number, height: number): MaskBounds | null {
  const r = boundsOf(camera, mask), x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(width, r.x + r.width) - x, h = Math.min(height, r.y + r.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
/** Test whether the old snapshot already contains every needed screen pixel.
 * This avoids taking another snapshot on every drag through the same pool. */
export function liquidCropContains(current: CameraMatrix, rendered: CameraMatrix, crop: MaskBounds, wanted: MaskBounds) {
  const m = reprojectCamera(rendered, current);
  return !!m && liquidBoundsContain(crop, boundsOf(m, wanted));
}
/** Keep a completed crop attached to its world pixels as OSD moves. The
 * element keeps its original CSS left/top, so compensate for that offset. */
export function liquidReprojection(current: CameraMatrix, rendered: CameraMatrix, crop: MaskBounds,
  width: number, height: number) {
  const m = reprojectCamera(current, rendered);
  if (!m) return null;
  const rect = boundsOf(m, crop);
  return {
    matrix: { ...m, e: m.e + m.a * crop.x + m.c * crop.y - crop.x,
      f: m.f + m.b * crop.x + m.d * crop.y - crop.y },
    visible: rect.x < width && rect.y < height && rect.x + rect.width > 0 && rect.y + rect.height > 0,
  };
}
export function liquidViewBounds(m: CameraMatrix, width: number, height: number, active: boolean): MaskBounds | null {
  const inverse = inverseCamera(m);
  if (!inverse || ![width, height].every(n => Number.isFinite(n) && n > 0) ||
    Math.hypot(m.a, m.b) < (active ? LIQUID_EXIT_SCALE : LIQUID_ENTER_SCALE)) return null;
  const rect = boundsOf(inverse, { x: 0, y: 0, width, height });
  const bounds = { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 };
  if (!Object.values(bounds).every(Number.isSafeInteger)) return null;
  const alignedWidth = (Math.ceil((bounds.x + bounds.width) / 256) - Math.floor(bounds.x / 256)) * 256;
  const alignedHeight = (Math.ceil((bounds.y + bounds.height) / 256) - Math.floor(bounds.y / 256)) * 256;
  return alignedWidth * alignedHeight <= MAX_MASK_PIXELS ? bounds : null;
}
export function liquidScreenCrop(m: CameraMatrix, mask: MaskBounds, width: number, height: number, ratio: number, ratioY = ratio) {
  const inverse = inverseCamera(m);
  if (!inverse || ![mask.x, mask.y, mask.width, mask.height].every(Number.isSafeInteger) ||
    ![width, height, mask.width, mask.height, ratio, ratioY].every(n => Number.isFinite(n) && n > 0)) return null;
  const rect = boundsOf(m, mask);
  const x = Math.max(0, Math.floor((rect.x - 3) * ratio)), y = Math.max(0, Math.floor((rect.y - 3) * ratioY));
  const right = Math.min(Math.round(width * ratio), Math.ceil((rect.x + rect.width + 3) * ratio));
  const bottom = Math.min(Math.round(height * ratioY), Math.ceil((rect.y + rect.height + 3) * ratioY));
  if (![x, y, right, bottom].every(Number.isSafeInteger) || right <= x || bottom <= y) return null;
  const sourceWidth = right - x, sourceHeight = bottom - y;
  const scale = Math.min(1, Math.sqrt(LIQUID_MAX_FRAME_PIXELS / (sourceWidth * sourceHeight)),
    LIQUID_MAX_FRAME_DIMENSION / sourceWidth, LIQUID_MAX_FRAME_DIMENSION / sourceHeight);
  const renderWidth = Math.max(1, Math.floor(sourceWidth * scale)), renderHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const scaleX = sourceWidth / renderWidth, scaleY = sourceHeight / renderHeight;
  const screenToWorld = [inverse.a * scaleX / ratio, inverse.b * scaleX / ratio,
      inverse.c * scaleY / ratioY, inverse.d * scaleY / ratioY,
      inverse.a * x / ratio + inverse.c * y / ratioY + inverse.e,
      inverse.b * x / ratio + inverse.d * y / ratioY + inverse.f];
  return screenToWorld.every(n => Number.isFinite(n) && Number.isFinite(Math.fround(n)))
    ? { x, y, width: sourceWidth, height: sourceHeight, renderWidth, renderHeight, screenToWorld } : null;
}
