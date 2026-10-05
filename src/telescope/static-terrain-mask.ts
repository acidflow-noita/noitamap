import Flatbush from "flatbush";

export interface StaticTerrainMask {
  x: number;
  y: number;
  width: number;
  height: number;
  /** One bit per authored material/force-air pixel. Transparent PNG pixels do
   * NOT reserve the scene's entire bounding rectangle. */
  bits: Uint8Array;
  /** FORCE AIR removes generated cells but still reveals the biome backdrop. */
  airBits?: Uint8Array;
}
export function staticSceneBits(
  data: Uint8Array | Uint8ClampedArray,
  forceAir = false,
): Uint8Array {
  const bits = new Uint8Array(Math.ceil(data.length / 4 / 8));
  for (let p = 0; p < data.length / 4; p++) {
    const i = p * 4;
    const air = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 66;
    if (
      data[i + 3] &&
      (data[i] || data[i + 1] || data[i + 2]) &&
      air === forceAir
    )
      bits[p >> 3] |= 1 << (p & 7);
  }
  return bits;
}

/** Keep authored static scene pixels in the base map, including the part of
 * altar_top that extends 40px ABOVE its biome-map chunk. No repaint and no
 * rectangular crop of the neighboring dynamic biome. */
export function createStaticTerrainMask(masks: StaticTerrainMask[] = []) {
  const index = masks.length ? new Flatbush(masks.length) : null;
  for (const m of masks) index!.add(m.x, m.y, m.x + m.width, m.y + m.height);
  index?.finish();
  const owns = (m: StaticTerrainMask, x: number, y: number, air = false) => {
    const px = x - m.x,
      py = y - m.y;
    if (px < 0 || py < 0 || px >= m.width || py >= m.height) return false;
    const p = py * m.width + px;
    return !!(
      (air ? (m.airBits?.[p >> 3] ?? 0) : m.bits[p >> 3]) &
      (1 << (p & 7))
    );
  };
  return {
    at(x: number, y: number) {
      return (index?.search(x, y, x, y) ?? []).some((id) =>
        owns(masks[id], x, y),
      );
    },
    clear(
      pixels: Uint8ClampedArray,
      x: number,
      y: number,
      w: number,
      h: number,
      air = false,
    ) {
      for (const id of index?.search(x, y, x + w, y + h) ?? []) {
        const m = masks[id];
        for (
          let wy = Math.max(y, m.y);
          wy < Math.min(y + h, m.y + m.height);
          wy++
        )
          for (
            let wx = Math.max(x, m.x);
            wx < Math.min(x + w, m.x + m.width);
            wx++
          ) {
            if (!owns(m, wx, wy, air)) continue;
            const i = ((wy - y) * w + wx - x) * 4;
            pixels.fill(0, i, i + 4);
          }
      }
    },
  };
}
