export function readRGBA(
  data: Uint8Array | Uint8ClampedArray,
  i: number,
): number {
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
  rgba: number,
): void {
  data[i] = (rgba >>> 16) & 255;
  data[i + 1] = (rgba >>> 8) & 255;
  data[i + 2] = rgba & 255;
  data[i + 3] = rgba >>> 24;
}

