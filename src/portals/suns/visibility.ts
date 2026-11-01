import type { CameraMatrix } from '../geometry';
import { SUN_FRAME_SIZE, type SunPlacement } from './placements';

export const SUN_ENTER_PIXELS = 18;
export const SUN_EXIT_PIXELS = 12;
export const SUN_PREFETCH_MARGIN = 192;

/** Separate entry/exit thresholds prevent rapid start/stop during small zooms. */
export function sunVisibility(sun: SunPlacement, camera: CameraMatrix, width: number, height: number, active: boolean) {
  if (width <= 0 || height <= 0 || !Object.values(camera).every(Number.isFinite))
    return { visible: false, animate: false, prepare: false, pixels: 0 };
  const { a, b, c, d, e, f } = camera;
  const pixels = sun.diameter * Math.hypot(a, b);
  const x = a * sun.x + c * sun.y + e, y = b * sun.x + d * sun.y + f;
  const rx = (Math.abs(a) + Math.abs(c)) * SUN_FRAME_SIZE / 2;
  const ry = (Math.abs(b) + Math.abs(d)) * SUN_FRAME_SIZE / 2;
  const intersects = (margin: number) => x + rx >= -margin && y + ry >= -margin &&
    x - rx <= width + margin && y - ry <= height + margin;
  const detailed = pixels >= (active ? SUN_EXIT_PIXELS : SUN_ENTER_PIXELS);
  return { visible: intersects(0), animate: detailed && intersects(0),
    prepare: detailed && intersects(SUN_PREFETCH_MARGIN), pixels };
}
