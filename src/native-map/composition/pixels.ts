import type { PixelBytes } from "./types";

export function readRGBA(data: PixelBytes, i: number): number {
  return (
    ((data[i + 3] << 24) |
      (data[i] << 16) |
      (data[i + 1] << 8) |
      data[i + 2]) >>>
    0
  );
}

export function writeRGBA(
  data: Uint8ClampedArray,
  i: number,
  color: number,
): void {
  data[i] = (color >>> 16) & 255;
  data[i + 1] = (color >>> 8) & 255;
  data[i + 2] = color & 255;
  data[i + 3] = color >>> 24;
}

/** Preserve the reference's straight-alpha operation order and byte rounding. */
export function compositeRGBA(foreground: number, background: number): number {
  const a = foreground >>> 24,
    b = background >>> 24;
  if (a === 255 || b === 0) return foreground;
  if (a === 0) return background;
  const weight = b * (255 - a),
    alpha = a * 255 + weight;
  const channel = (shift: number) =>
    Math.round(
      (((foreground >>> shift) & 255) * a * 255 +
        ((background >>> shift) & 255) * weight) /
        alpha,
    );
  return (
    ((Math.round(alpha / 255) << 24) |
      (channel(16) << 16) |
      (channel(8) << 8) |
      channel(0)) >>>
    0
  );
}
