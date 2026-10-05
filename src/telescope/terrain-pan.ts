import type { TerrainViewportPlan } from './terrain-viewport-compositor';

/** Reuse the overlap that presentation already preserves at the same zoom.
 * Fractional frame edges keep a fresh one-pixel halo underneath their blend;
 * zoom/resize and large jumps continue to use a full frame. A one-pixel size
 * difference from viewport rounding does not discard otherwise usable overlap. */
export function terrainPanPatches(previous: TerrainViewportPlan, next: TerrainViewportPlan) {
  const {pixelWidth: w, pixelHeight: h, scale} = next;
  if (previous.scale !== scale || Math.abs(previous.pixelWidth - w) > 1 || Math.abs(previous.pixelHeight - h) > 1
    || previous.samplingPlan || next.samplingPlan
    || previous.width !== previous.pixelWidth * scale || previous.height !== previous.pixelHeight * scale
    || next.width !== w * scale || next.height !== h * scale) return null;
  const dx = (previous.x - next.x) / scale, dy = (previous.y - next.y) / scale;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
  const hx = Number(!Number.isInteger(dx)), hy = Number(!Number.isInteger(dy));
  const left = dx <= 0 ? 0 : Math.ceil(dx) + hx, top = dy <= 0 ? 0 : Math.ceil(dy) + hy;
  const oldRight = previous.pixelWidth + dx, oldBottom = previous.pixelHeight + dy;
  const right = oldRight >= w ? w : Math.floor(oldRight) - hx, bottom = oldBottom >= h ? h : Math.floor(oldBottom) - hy;
  if (right <= left || bottom <= top || (right - left) * (bottom - top) < w * h / 2) return null;
  const samplingPlan = {x: next.x, y: next.y, pixelWidth: w, pixelHeight: h};
  return [
    {x: 0, y: 0, width: w, height: top},
    {x: 0, y: bottom, width: w, height: h - bottom},
    {x: 0, y: top, width: left, height: bottom - top},
    {x: right, y: top, width: w - right, height: bottom - top},
  ].filter(r => r.width > 0 && r.height > 0).map(r => ({x: r.x, y: r.y, plan: {
    x: next.x + r.x * scale, y: next.y + r.y * scale,
    width: r.width * scale, height: r.height * scale, scale,
    pixelWidth: r.width, pixelHeight: r.height, samplingPlan,
  }}));
}
