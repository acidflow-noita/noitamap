import { BLUE_NOISE_SIZE, blueNoiseRanks } from "./blue-noise-ranks.mjs";

// A progressive blue-noise rank mask, remapped through the triangular inverse
// CDF. Monotonic remapping preserves the blue-noise threshold ordering.
// Identical Float32 samples are used by JS, WASM composition and the GPU texture.
export const GLOW_DITHER_SIZE = BLUE_NOISE_SIZE;
export const GLOW_DITHER_TILE = (() => {
  const ranks = blueNoiseRanks(), count = ranks.length;
  return Float32Array.from(ranks, rank => {
    const tail = Math.min(rank, count - 1 - rank);
    const magnitude = 1 - Math.sqrt((2 * tail + 1) / count);
    return rank < count / 2 ? -magnitude : magnitude;
  });
})();

// Stable, zero-centered and shared by RGB. Never fed into glow history.
export function glowDither(x, y) {
  return GLOW_DITHER_TILE[(y & (GLOW_DITHER_SIZE - 1)) * GLOW_DITHER_SIZE + (x & (GLOW_DITHER_SIZE - 1))];
}

export function glowDitherField(width, height) {
  const noise = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) noise[y * width + x] = glowDither(x, y);
  return noise;
}

export const GLOW_DITHER_GLSL = `
uniform highp sampler2D glowDitherTexture;
float glowDither(uvec2 pixel) {
  return texelFetch(glowDitherTexture,ivec2(pixel&uvec2(${GLOW_DITHER_SIZE - 1}u)),0).r;
}`;
