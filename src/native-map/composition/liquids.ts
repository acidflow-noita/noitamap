import Flatbush from "flatbush";
import { writeRGBA } from "./pixels";
import type { LiquidSurface } from "./types";

export const LIQUID_SURFACE_REACH = 6;

/** Runs must already include global connected-run leveling. A cropped lattice
 * cannot determine sourceY or the area-weighted shared surface correctly. */
export function createLiquidPainter(
  surfaces: readonly LiquidSurface[],
  worldWidth: number,
) {
  const reach = LIQUID_SURFACE_REACH;
  const index = surfaces.length ? new Flatbush(surfaces.length) : null;
  for (const surface of surfaces) {
    if (
      ![
        surface.left,
        surface.right,
        surface.y,
        surface.sourceY ?? surface.y,
        surface.material,
      ].every(Number.isSafeInteger) ||
      surface.right <= surface.left ||
      surface.material <= 0
    )
      throw new Error("Invalid prepared liquid surface");
    index!.add(
      surface.left,
      Math.min(surface.y, surface.sourceY ?? surface.y) - reach,
      surface.right,
      Math.max(surface.y, surface.sourceY ?? surface.y) + reach,
    );
  }
  index?.finish();
  return (
    pixels: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    height: number,
    sample: (x: number, y: number) => number,
    color: (material: number, x: number, y: number) => number,
  ) => {
    const p0 = Math.floor((x + worldWidth / 2) / worldWidth);
    const p1 = Math.floor((x + width - 1 + worldWidth / 2) / worldWidth);
    for (let pw = p0; pw <= p1; pw++) {
      const offset = pw * worldWidth;
      // Preserve the original spatial-index visitation order for overlapping runs.
      for (const id of index?.search(
        x - offset,
        y,
        x + width - offset,
        y + height,
      ) ?? []) {
        const surface = surfaces[id];
        const top = Math.min(surface.y, surface.sourceY ?? surface.y) - reach;
        const bottom =
          Math.max(surface.y, surface.sourceY ?? surface.y) + reach;
        for (let wy = Math.max(y, top); wy < Math.min(y + height, bottom); wy++)
          for (
            let wx = Math.max(x, surface.left + offset);
            wx < Math.min(x + width, surface.right + offset);
            wx++
          ) {
            const existing = sample(wx, wy);
            if (existing !== 0 && existing !== surface.material) continue;
            const i = ((wy - y) * width + wx - x) * 4;
            if (wy < surface.y) {
              if (existing === surface.material) pixels.fill(0, i, i + 4);
            } else if (
              existing === 0 &&
              sample(wx, bottom) === surface.material
            )
              writeRGBA(pixels, i, color(surface.material, wx, wy));
          }
      }
    }
  };
}
