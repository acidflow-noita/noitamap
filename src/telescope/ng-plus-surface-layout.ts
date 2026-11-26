import { visibleWorldSpan } from './world-coverage';

// All of the source and replacement surface gradients start at -1024.
// Two more chunks above that include the largest height displacement.
export const NG_PLUS_SURFACE_TOP = -2048;
const CHUNK = 512, WORLD_TOP = -14 * CHUNK;
const SURFACE_COLORS = [0xcc9944, 0xd6d8e3, 0x33e311]; // Desert, Winter, Hills2

export function changedNGPlusSurfaceCells(level: number, pixels: Uint32Array, baseRGBA: ArrayLike<number>, width: number): Uint16Array | undefined {
  if (level <= 0 || level % 7 !== 0) return;
  // Noita's paint_replace_color takes the original color at template cell (16, 5).
  const ref = 4 * (5 * width + 16);
  const replacement = SURFACE_COLORS[(level / 7) % SURFACE_COLORS.length];
  if ((baseRGBA[ref] << 16 | baseRGBA[ref + 1] << 8 | baseRGBA[ref + 2]) === replacement) return;
  const cells: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const p = 4 * i;
    if ((pixels[i] & 0xffffff) === replacement && baseRGBA[p] === baseRGBA[ref] &&
        baseRGBA[p + 1] === baseRGBA[ref + 1] && baseRGBA[p + 2] === baseRGBA[ref + 2]) cells.push(i);
  }
  return Uint16Array.from(cells);
}

/** Keep the capture's sky and the unchanged hills, rooms and mountains outside
 * this sparse tile source. Outer PWs only extend to the captured DZI edges. */
export function ngPlusSurfaceLayout(cells: Uint16Array, width: number, worlds: number[]) {
  const rows = new Map<number, Set<number>>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pw of worlds) {
    const span = visibleWorldSpan(pw, width * CHUNK, 'normal', true);
    for (const i of cells) {
      const y = WORLD_TOP + Math.floor(i / width) * CHUNK;
      const x = ((i % width) - width / 2 + pw * width) * CHUNK;
      if (y < NG_PLUS_SURFACE_TOP || x < span.minX || x >= span.minX + span.width) continue;
      let row = rows.get(y);
      if (!row) {
        row = new Set();
        rows.set(y, row);
      }
      row.add(x);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + CHUNK);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y + CHUNK);
    }
  }
  if (!rows.size) return null;
  return {
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    intersects(x: number, y: number, w: number, h: number) {
      for (let cy = Math.floor(y / CHUNK) * CHUNK; cy < y + h; cy += CHUNK) {
        const row = rows.get(cy);
        if (!row) continue;
        for (let cx = Math.floor(x / CHUNK) * CHUNK; cx < x + w; cx += CHUNK) {
          if (row.has(cx)) return true;
        }
      }
      return false;
    },
  };
}
