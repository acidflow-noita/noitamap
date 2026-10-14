// Owned liquid-input preparation. Adapted from Noitamap liquid-surfaces.ts; see NOTICE.txt.
import type { LiquidSurface } from "./types";

export function liquidMaterialIds(xml: string, names: string[]): Set<number> {
  const entries = new Map<string, Record<string, string>>();
  // Disabled definitions in XML comments must never override live materials.
  for (const match of xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .matchAll(/<CellData(?:Child)?\b([^>]*?)>/g)) {
    const attributes: Record<string, string> = {};
    for (const a of match[1].matchAll(/([\w]+)\s*=\s*"([^"]*)"/g))
      attributes[a[1]] = a[2];
    if (attributes.name) entries.set(attributes.name, attributes);
  }
  const resolve = (
    name: string,
    seen = new Set<string>(),
  ): Record<string, string> => {
    if (seen.has(name)) return {};
    seen.add(name);
    const value = entries.get(name) ?? {};
    return { ...(value._parent ? resolve(value._parent, seen) : {}), ...value };
  };
  const ids = new Set<number>();
  names.forEach((name, id) => {
    const m = resolve(name);
    if (m.cell_type === "liquid" && m.liquid_sand === "0") ids.add(id);
  });
  return ids;
}
export function findLiquidSurfaces(
  lattice: { GW: number; GH: number; mat: Uint16Array; cov: Float32Array },
  ids: Set<number>,
  width: number,
  offsetY = 0,
): LiquidSurface[] {
  const surfaces: LiquidSurface[] = [],
    rows: number[] = [],
    { GW, GH, mat, cov } = lattice;
  for (let y = 1; y < GH; y++)
    for (let x = 0; x < GW;) {
      const i = y * GW + x;
      // Most cells cannot be free surfaces. Reject their coverage before
      // consulting material physics, especially on the live worker path.
      if (cov[i] < 0.5 || cov[i - GW] >= 0.5) {
        x++;
        continue;
      }
      const material = mat[i] - 1;
      if (!ids.has(material) || (mat[i - GW] > 1 && mat[i - GW] !== mat[i])) {
        x++;
        continue;
      }
      const from = x++,
        above = cov[i - GW];
      while (
        x < GW &&
        mat[y * GW + x] - 1 === material &&
        cov[y * GW + x] >= 0.5 &&
        cov[(y - 1) * GW + x] === above &&
        (mat[(y - 1) * GW + x] <= 1 || mat[(y - 1) * GW + x] === material + 1)
      )
        x++;
      if (x - from < 2) continue; // droplets/single-cell deposits are not authored pools
      // Invert the lattice's smoothstep interpolation at coverage 0.5.
      // An explicit AIR node has coverage -1, unlike an untouched zero node.
      const coverage = (0.5 - above) / (1 - above);
      const fraction = 0.5 - Math.sin(Math.asin(1 - 2 * coverage) / 3);
      surfaces.push({
        left: from * 10 - width * 256 - 5,
        right: x * 10 - width * 256 - 5,
        y: Math.ceil((y - 1 + fraction) * 10 - 7168 - 0.5) + offsetY,
        material,
      });
      rows.push(y);
    }
  // A pool can straddle two lattice rows. Independent row-wise leveling
  // otherwise leaves a 10px stair in one connected fluid. Join touching runs
  // only when the actual liquid cells share an edge below the higher surface.
  // This is a sparse pass over surfaces, not another world-sized flood fill.
  const starts = new Map<number, number[]>();
  const parents = surfaces.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  surfaces.forEach((s, i) => {
    const list = starts.get(s.left) ?? [];
    list.push(i);
    starts.set(s.left, list);
  });
  surfaces.forEach((left, i) => {
    for (const j of starts.get(left.right) ?? []) {
      const right = surfaces[j];
      if (left.material !== right.material || Math.abs(rows[i] - rows[j]) > 1)
        continue;
      const x = (left.right + width * 256 + 5) / 10;
      const cell = Math.max(rows[i], rows[j]) * GW + x;
      if (
        x <= 0 ||
        x >= GW ||
        cov[cell - 1] < 0.5 ||
        cov[cell] < 0.5 ||
        mat[cell - 1] !== left.material + 1 ||
        mat[cell] !== left.material + 1
      )
        continue;
      parents[root(j)] = root(i);
    }
  });
  const totals = new Map<number, { width: number; area: number }>();
  surfaces.forEach((s, i) => {
    const id = root(i),
      total = totals.get(id) ?? { width: 0, area: 0 };
    const span = s.right - s.left;
    total.width += span;
    total.area += span * s.y;
    totals.set(id, total);
  });
  surfaces.forEach((s, i) => {
    const total = totals.get(root(i))!;
    // Preserve the grid's nominal liquid area, rounded to one world pixel.
    const y = Math.round(total.area / total.width);
    if (y !== s.y) {
      s.sourceY = s.y;
      s.y = y;
    }
  });
  return surfaces;
}
