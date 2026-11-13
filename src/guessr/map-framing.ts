import type { Bounds, Point } from "./rules";
import { ANSWER_PIN_HEIGHT, GUESS_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT } from './map-pin';

/** Fill the panel on entry, or contain the entire world when explicitly asked. */
export function frameMap(
  bounds: Bounds,
  width: number,
  height: number,
  fit: 'fill' | 'contain' = 'fill',
): Bounds {
  if (!(width > 0 && height > 0) || !Number.isFinite(width / height))
    return { ...bounds };
  const aspect = width / height;
  const w = fit === 'contain' ? Math.max(bounds.width, bounds.height * aspect)
    : Math.min(bounds.width, bounds.height * aspect);
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
  // Pins extend above their tips; the solution target extends around its centre.
  const verticalPadding = Math.max(GUESS_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT, ANSWER_PIN_HEIGHT / 2) + 6;
  const sidePadding = Math.max(HIGHLIGHT_PIN_HEIGHT / 2, ANSWER_PIN_HEIGHT / 2) + 6;
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
