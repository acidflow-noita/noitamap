import type { Bounds, Point } from "./rules";
import { ANSWER_PIN_HEIGHT } from './map-pin';

/** Fill the panel on entry instead of shrinking the tall world into a strip.
 * Panning still reaches the portions above and below the initial view. */
export function frameMap(
  bounds: Bounds,
  width: number,
  height: number,
): Bounds {
  if (!(width > 0 && height > 0) || !Number.isFinite(width / height))
    return { ...bounds };
  const aspect = width / height;
  const w = Math.min(bounds.width, bounds.height * aspect);
  const h = w / aspect;
  return {
    x: bounds.x + (bounds.width - w) / 2,
    y: bounds.y + (bounds.height - h) / 2,
    width: w,
    height: h,
  };
}

/** Fit a revealed result with padding. A minimum terrain context avoids
 * extreme zoom for perfect guesses; an empty margin at world edges is fine. */
export function frameMarkers(
  points: readonly Point[],
  width: number,
  height: number,
): Bounds {
  if (
    !points.length ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error("Result markers must be finite points.");
  const left = Math.min(...points.map((p) => p.x)),
    right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y)),
    bottom = Math.max(...points.map((p) => p.y));
  const aspect =
    width > 0 && height > 0 && Number.isFinite(width / height)
      ? width / height
      : 1;
  let w = Math.max(1024, (right - left) * 1.4),
    h = Math.max(1024, (bottom - top) * 1.4);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  // A pin extends above its coordinate. Keep the whole larger solution pin
  // inside the result view, including when points span a short/wide panel.
  const verticalPadding = ANSWER_PIN_HEIGHT + 6, sidePadding = 30;
  if (width > sidePadding * 2 && height > verticalPadding * 2) {
    const unit = Math.max(w / width, h / height,
      (right - left) / (width - sidePadding * 2), (bottom - top) / (height - verticalPadding * 2));
    w = unit * width; h = unit * height;
  }
  return {
    x: (left + right - w) / 2,
    y: (top + bottom - h) / 2,
    width: w,
    height: h,
  };
}
