import type { Bounds, Point } from "./rules";
import { ANSWER_PIN_HEIGHT, GUESS_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT } from './map-pin';

export const RESULT_PIN_PADDING_Y = Math.max(GUESS_PIN_HEIGHT, HIGHLIGHT_PIN_HEIGHT, ANSWER_PIN_HEIGHT / 2) + 6;
const RESULT_PIN_PADDING_X = Math.max(HIGHLIGHT_PIN_HEIGHT / 2, ANSWER_PIN_HEIGHT / 2) + 8;

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

/** Keep the pins visible and prefer captured terrain for the surrounding context. */
export function frameMarkers(
  points: readonly Point[],
  width: number,
  height: number,
  bounds?: Bounds,
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
  if (width > RESULT_PIN_PADDING_X * 2 && height > RESULT_PIN_PADDING_Y * 2) {
    const context = Math.max(w / width, h / height);
    const fill = bounds ? Math.min(bounds.width / width, bounds.height / height) : context;
    const unit = Math.max(Math.min(context, fill),
      (right - left) / (width - 2 * RESULT_PIN_PADDING_X), (bottom - top) / (height - 2 * RESULT_PIN_PADDING_Y));
    w = unit * width; h = unit * height;
    if (bounds) {
      const origin = (first: number, last: number, size: number, start: number, extent: number, inset: number) => {
        const centered = (first + last - size) / 2;
        const terrain = size <= extent ? Math.max(start, Math.min(start + extent - size, centered)) : start + (extent - size) / 2;
        return Math.max(last + inset - size, Math.min(first - inset, terrain));
      };
      return {
        x: origin(left, right, w, bounds.x, bounds.width, RESULT_PIN_PADDING_X * unit),
        y: origin(top, bottom, h, bounds.y, bounds.height, RESULT_PIN_PADDING_Y * unit),
        width: w, height: h,
      };
    }
  }
  return {
    x: (left + right - w) / 2,
    y: (top + bottom - h) / 2,
    width: w,
    height: h,
  };
}
