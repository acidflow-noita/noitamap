interface DecodedPng {
  width: number;
  height: number;
  depth: number;
  ctype: number;
  data: Uint8Array;
  tabs: Record<string, unknown>;
}
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** UPNG 2.1 already unfilters static truecolor8 into RGB/RGBA order. Use a
 * bulk copy for RGBA or one packed output write per RGB pixel.
 * Keep a separate buffer because Telescope clears spawn pixels in this result.
 * Other depths/types and animated frames retain UPNG's original conversion. */
export function telescopePngRgba(image: DecodedPng, upng: { toRGBA8(image: any): ArrayBuffer[] }): Uint8Array {
  const size = image.width * image.height * 4;
  if (image.depth === 8 && image.tabs && image.tabs.acTL == null
    && image.data instanceof Uint8Array && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height)
    && image.width >= 0 && image.height >= 0 && Number.isSafeInteger(size) && size <= 0x7fffffff) {
    if (image.ctype === 6) {
      const rgba = new Uint8Array(size);
      // UPNG's non-interlaced data may retain trailing scanline/filter storage.
      // A short source is zero-padded, like assigning undefined to Uint8Array.
      if (image.data.length) rgba.set(image.data.subarray(0, size));
      return rgba;
    }
    const transparent = image.tabs.tRNS;
    if (image.ctype === 2 && LITTLE_ENDIAN && image.data.length >= size / 4 * 3
      && (transparent == null || Array.isArray(transparent))) {
      const rgba = new Uint8Array(size), words = new Uint32Array(rgba.buffer), data = image.data;
      // RGB tRNS keys remain source-depth values. Out-of-range keys cannot
      // match an 8-bit sample; never truncate them into a different color.
      const key = Array.isArray(transparent) && transparent.length === 3
        && transparent.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
        ? transparent[0] | (transparent[1] << 8) | (transparent[2] << 16) : -1;
      for (let p = 0, i = 0; p < words.length; p++, i += 3) {
        const rgb = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
        // Preserve hidden RGB even for transparent pixels, as UPNG does.
        words[p] = rgb | (rgb === key ? 0 : 0xff000000);
      }
      return rgba;
    }
  }
  return new Uint8Array(upng.toRGBA8(image)[0]);
}
