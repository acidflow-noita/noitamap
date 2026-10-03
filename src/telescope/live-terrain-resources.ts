import type { LiquidSurface } from './liquid-surfaces';
import type { TerrainOwnership } from './terrain-policy';

/** Insert host records before the final Wang-parameter row, whose position is
 * part of Telescope's shader ABI. All original biome rows stay at their indices. */
export function packHostTerrainTable(
  table: { width: number; height: number; data: Float32Array },
  ownership: TerrainOwnership, surfaces: LiquidSurface[],
) {
  const cells: LiquidSurface[][] = Array.from({ length: ownership.owners.length }, () => []);
  const width = ownership.width;
  for (const surface of surfaces) {
    const x0 = Math.max(0, Math.floor((surface.left + width * 256) / 512));
    const x1 = Math.min(width - 1, Math.floor((surface.right - 1 + width * 256) / 512));
    const y0 = Math.max(0, Math.floor((surface.y - 6 + 7168) / 512));
    const y1 = Math.min(47, Math.floor((surface.y + 5 + 7168) / 512));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * width + x].push(surface);
  }
  const base = (table.height - 1) * table.width;
  const records = cells.length + cells.reduce((n, list) => n + list.length, 0);
  const height = table.height + Math.ceil(records / table.width);
  const data = new Float32Array(table.width * height * 4);
  data.set(table.data.subarray(0, base * 4));
  data.set(table.data.subarray(base * 4), (height - 1) * table.width * 4);
  let next = base + cells.length;
  cells.forEach((list, i) => {
    data.set([ownership.owners[i] >= 0 ? 1 : 0, next, list.length, 0], (base + i) * 4);
    for (const s of list) { data.set([s.left, s.right, s.y, s.material], next * 4); next++; }
  });
  return { table: { width: table.width, height, data }, base };
}
