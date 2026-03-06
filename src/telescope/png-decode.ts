/**
 * png-decode.ts
 *
 * Pure-JS PNG decoding using fast-png.
 * Never touches canvas / getImageData — immune to browser fingerprinting
 * protection (LibreWolf, Safari ITP, iOS Safari, Firefox RFP).
 */

import { decode } from "fast-png";

export interface RawImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Decode a PNG from an ArrayBuffer into raw RGBA pixel data.
 * Returns { data: Uint8ClampedArray, width, height } — same shape as
 * ImageData, so call sites can be swapped in without further changes.
 */
export function decodePngToRgba(buf: ArrayBuffer): RawImageData {
  const decoded = decode(new Uint8Array(buf));
  const { width, height, palette } = decoded;

  // Handle Palette-indexed PNGs explicitly
  if (palette) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const indices = decoded.data as Uint8Array;

    // fast-png palette arrays are flattened eg. [R, G, B, R, G, B] or maybe with Alpha depending on transparency chunks, but usually RGB.
    // However, they return it as an array of R,G,B (and sometimes A) arrays? Let's check fast-png types later, but typically it's number[][].
    // Wait, fast-png returns palette as array of RGB tuples: `[R, G, B, A?]` per index.
    for (let i = 0; i < width * height; i++) {
      const idx = indices[i];
      const color = palette[idx];
      const rBase = i * 4;
      if (color) {
        rgba[rBase] = color[0] ?? 0;
        rgba[rBase + 1] = color[1] ?? 0;
        rgba[rBase + 2] = color[2] ?? 0;
        rgba[rBase + 3] = color[3] ?? 255; // Alpha defaults to 255 if not in palette
      } else {
        // Fallback for out-of-bounds index
        rgba[rBase + 3] = 255;
      }
    }
    return { data: rgba, width, height };
  }

  // fast-png may return 1, 2, 3, or 4 channels. Normalize to RGBA.
  const channels = decoded.channels ?? decoded.data.length / (width * height);
  const pixels = decoded.data as Uint8Array | Uint16Array;

  // Handle 16-bit PNGs by downsampling to 8-bit
  const isU16 = pixels instanceof Uint16Array;

  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const base = i * channels;
    const rBase = i * 4;

    const get = (offset: number) => {
      const v = pixels[base + offset] ?? 0;
      return isU16 ? Math.round((v as number) / 257) : (v as number); // 65535→255
    };

    if (channels === 1) {
      // Grayscale
      const g = get(0);
      rgba[rBase] = g;
      rgba[rBase + 1] = g;
      rgba[rBase + 2] = g;
      rgba[rBase + 3] = 255;
    } else if (channels === 2) {
      // Grayscale + Alpha
      const g = get(0);
      rgba[rBase] = g;
      rgba[rBase + 1] = g;
      rgba[rBase + 2] = g;
      rgba[rBase + 3] = get(1);
    } else if (channels === 3) {
      // RGB
      rgba[rBase] = get(0);
      rgba[rBase + 1] = get(1);
      rgba[rBase + 2] = get(2);
      rgba[rBase + 3] = 255;
    } else {
      // RGBA - must mirror Canvas premultiplied alpha: when alpha=0, RGB=0
      const a = get(3);
      if (a === 0) {
        rgba[rBase] = 0;
        rgba[rBase + 1] = 0;
        rgba[rBase + 2] = 0;
        rgba[rBase + 3] = 0;
      } else {
        rgba[rBase] = get(0);
        rgba[rBase + 1] = get(1);
        rgba[rBase + 2] = get(2);
        rgba[rBase + 3] = a;
      }
    }
  }

  return { data: rgba, width, height };
}

/**
 * Encode raw RGBA pixel data back to a PNG Blob URL.
 * Uses fast-png's encoder — no canvas involved.
 */
export async function rgbaToPngBlobUrl(data: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const { encode } = await import("fast-png");
  const encoded = encode({ data: new Uint8Array(data.buffer), width, height, channels: 4 });
  const blob = new Blob([encoded as unknown as BlobPart], { type: "image/png" });
  return URL.createObjectURL(blob);
}
