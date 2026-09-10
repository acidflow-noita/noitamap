import Flatbush from "flatbush";
import { MATERIAL_NAMES_BY_ID } from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import { writeRGBA } from "./terrain-scenes";

/** Noita uses cell_type="liquid" for powders too. Honor the actual inherited
 * liquid_sand flag rather than flattening ores/sand based on the cell_type.
 * Static desert ground additionally sets liquid_static=1; loose sand/powders
 * generally do not. BOTH sand cases must be excluded from liquid leveling.
 * Unknown/missing flags are excluded conservatively, not assumed to be water. */
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
let liquids: Promise<Set<number>> | undefined;
export function loadLiquidMaterialIds(): Promise<Set<number>> {
  return (liquids ??= (async () => {
    const { getZip } = await import("../data-archive");
    const xml = (await getZip("main"))?.file("data/materials.xml");
    if (!xml) throw new Error("Missing liquid/powder material physics");
    return liquidMaterialIds(await xml.async("string"), MATERIAL_NAMES_BY_ID);
  })());
}
export interface LiquidSurface {
  left: number;
  right: number;
  y: number;
  material: number;
}

/** Straight liquid/air runs authored in the Wang lattice are level surfaces.
 * Edge-warp noise must not turn their free surface into a powder/rock edge.
 * Keep the cave wall/bottom samples; this is not a full fluid/reaction simulator. */
export function findLiquidSurfaces(
  lattice: { GW: number; GH: number; mat: Uint16Array; cov: Float32Array },
  ids: Set<number>,
  width: number,
  offsetY = 0,
): LiquidSurface[] {
  const surfaces: LiquidSurface[] = [],
    { GW, GH, mat, cov } = lattice;
  for (let y = 1; y < GH; y++)
    for (let x = 0; x < GW;) {
      const i = y * GW + x,
        material = mat[i] - 1;
      if (
        !ids.has(material) ||
        cov[i] < 0.5 ||
        cov[i - GW] >= 0.5 ||
        (mat[i - GW] > 1 && mat[i - GW] !== mat[i])
      ) {
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
    }
  return surfaces;
}
export function createLiquidSurfacePainter(
  surfaces: LiquidSurface[],
  worldWidth: number,
) {
  const reach = 6,
    index = surfaces.length ? new Flatbush(surfaces.length) : null;
  for (const s of surfaces)
    index!.add(s.left, s.y - reach, s.right, s.y + reach);
  index?.finish();
  return (
    pixels: Uint8ClampedArray,
    x: number,
    y: number,
    w: number,
    h: number,
    sample: (x: number, y: number) => number,
    color: (id: number, x: number, y: number) => number,
  ) => {
    const p0 = Math.floor((x + worldWidth / 2) / worldWidth),
      p1 = Math.floor((x + w - 1 + worldWidth / 2) / worldWidth);
    for (let pw = p0; pw <= p1; pw++) {
      const offset = pw * worldWidth;
      for (const id of index?.search(x - offset, y, x + w - offset, y + h) ??
        []) {
        const s = surfaces[id];
        for (
          let wy = Math.max(y, s.y - reach);
          wy < Math.min(y + h, s.y + reach);
          wy++
        )
          for (
            let wx = Math.max(x, s.left + offset);
            wx < Math.min(x + w, s.right + offset);
            wx++
          ) {
            const existing = sample(wx, wy);
            // Never erase rock, powder, or a different liquid to level this one.
            if (existing !== 0 && existing !== s.material) continue;
            const i = ((wy - y) * w + wx - x) * 4;
            if (wy < s.y) {
              if (existing === s.material) pixels.fill(0, i, i + 4);
            } else if (existing === 0 && sample(wx, s.y + reach) === s.material)
              writeRGBA(pixels, i, color(s.material, wx, wy));
          }
      }
    }
  };
}
