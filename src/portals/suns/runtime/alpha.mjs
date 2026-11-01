// Reference surface for native glow when displaying a transparent frame.
export const TRANSPARENT_MATTE = "#1b1026";
export const TRANSPARENT_MATTE_COLOR = 0x1b1026;

// Core coverage preserves opaque dark artwork. The remaining coverage encodes
// glow as soft alpha, calibrated to the UI surface without a background plate.
export function unmatteRGBA(pixels, background, monochrome = false) {
  const bg = [background >>> 16 & 255, background >>> 8 & 255, background & 255];
  for (let i = 0; i < pixels.length; i += 4) {
    let alpha = pixels[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const value = pixels[i + c];
      if (value > bg[c]) alpha = Math.max(alpha, (value - bg[c]) / (255 - bg[c]));
      else if (value < bg[c]) alpha = Math.max(alpha, (bg[c] - value) / bg[c]);
    }
    const opacity = Math.max(0, Math.min(255, Math.ceil(alpha * 255 - 1e-7)));
    pixels[i + 3] = opacity;
    if (!opacity) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 0; continue; }
    alpha = opacity / 255;
    for (let c = 0; c < 3; c++) pixels[i + c] = (pixels[i + c] - bg[c] * (1 - alpha)) / alpha;
    if (monochrome) pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
  }
  return pixels;
}
