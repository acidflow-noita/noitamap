/** The vertical planes have locally stored coverage lattices, but noise,
 * material bands and rare-material tests are evaluated at ABSOLUTE world pixels.
 * Only the resulting lattice address is translated back into the plane. */
import {
  CoverGrid,
  lookupCoord,
  wangLookup,
  sampleByType,
  computeMaterialNoiseDensity,
  DEFAULT_PARAMS,
} from "noita-telescope-full-pixels/engine_resolve/topo2_resolve.js";
import {
  WANG_PARAMS_BY_ID,
  BIOME_ENGINE,
} from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import { selectComponentForCell } from "noita-telescope-full-pixels/engine_resolve/band_select.js";
import { resolveCellFull } from "noita-telescope-full-pixels/engine_resolve/chunk_wobble.js";

export function createPlaneMaterialField(
  lattice: any,
  pixels: Uint32Array,
  mapWidth: number,
  offsetY: number,
  regionOriginX?: number,
) {
  const grid = new CoverGrid(lattice.GW, lattice.GH, lattice.cov, lattice.mat);
  const table = new Map<number, any>(
    BIOME_ENGINE.map((b: any) => [b.color & 0xffffff, b]),
  );
  const params = WANG_PARAMS_BY_ID.map(
    ([scale, threshold, type]: number[]) => ({ scale, threshold, type }),
  );
  const map = {
    w: mapWidth,
    colorAt: (x: number, y: number) => pixels[y * mapWidth + x] & 0xffffff,
  };
  const cell: any = {};
  const noise = (color: number) => table.get(color)?.noiseBiomeEdges !== false;
  const coords = (scale: number, x: number, y: number) => {
    const c = lookupCoord(scale, x, y);
    if (regionOriginX !== undefined) {
      const pw = Math.floor((x + mapWidth * 256) / (mapWidth * 512));
      c[0] = Math.fround(c[0] - regionOriginX - (pw * mapWidth * 512) / 10);
    }
    c[1] = Math.fround(c[1] - offsetY / 10);
    return c;
  };
  return (x: number, y: number): number => {
    // Each vertical map broadcasts a row, so clamping its physical row does
    // not change the biome; the horizontal wobble still needs absolute Y.
    resolveCellFull(map, x, y, noise, cell);
    const biome = table.get(cell.color);
    if (!biome?.supported || biome.topo !== 2) return -1;
    const zero = coords(0, x, y),
      idx = wangLookup(grid, zero[0], zero[1]);
    const p = idx >= 1 ? (params[idx] ?? DEFAULT_PARAMS) : DEFAULT_PARAMS;
    const c = coords(p.scale, x, y),
      coverage = sampleByType(grid, p.type, c[0], c[1]);
    if (coverage < Math.fround(p.threshold)) return 0;
    const direct = wangLookup(grid, c[0], c[1]);
    if (direct >= 1) return direct;
    return Math.max(
      0,
      selectComponentForCell(
        biome,
        x,
        y,
        computeMaterialNoiseDensity(x, y, coverage),
      ),
    );
  };
}
