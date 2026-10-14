import { validatePixels, type PixelBytes } from "./format";

/** The exact integer semantics of build_scripts/terrain-pyramid.mjs:reduce2.
 * Called during preparation only, after all source layers have been composed. */
export function reduceFinalPixels(
  pixels: PixelBytes,
  width: number,
  height: number,
): { data: Uint8Array; width: number; height: number } {
  validatePixels(pixels, width, height);
  const w = Math.ceil(width / 2),
    h = Math.ceil(height / 2);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row0 = y * 2 * width * 4,
      row1 = row0 + width * 4;
    const secondRow = y * 2 + 1 < height;
    for (let x = 0; x < w; x++) {
      const p0 = row0 + x * 8,
        p1 = p0 + 4,
        p2 = row1 + x * 8,
        p3 = p2 + 4;
      const secondCol = x * 2 + 1 < width,
        target = (y * w + x) * 4;
      const a0 = pixels[p0 + 3],
        a1 = secondCol ? pixels[p1 + 3] : 0;
      const a2 = secondRow ? pixels[p2 + 3] : 0,
        a3 = secondRow && secondCol ? pixels[p3 + 3] : 0;
      const alpha = a0 + a1 + a2 + a3;
      if (!alpha) continue;
      if (alpha === 1020) {
        for (let c = 0; c < 3; c++)
          out[target + c] =
            (pixels[p0 + c] +
              pixels[p1 + c] +
              pixels[p2 + c] +
              pixels[p3 + c] +
              2) >>
            2;
        out[target + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++) {
          let sum = pixels[p0 + c] * a0;
          if (a1) sum += pixels[p1 + c] * a1;
          if (a2) sum += pixels[p2 + c] * a2;
          if (a3) sum += pixels[p3 + c] * a3;
          out[target + c] = Math.round(sum / alpha);
        }
        out[target + 3] = (alpha + 2) >> 2;
      }
    }
  }
  return { data: out, width: w, height: h };
}
