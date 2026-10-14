import { positiveInteger, powerOfTwo } from "./format";

export interface RegionCoordinate {
  readonly horizontal: number;
  readonly vertical: number;
}

export interface CookedMapManifest {
  readonly pageSize: number;
  readonly regionColumns: number;
  readonly regionRows: number;
  /** Every coordinate in a rectangular region grid must be explicit. */
  readonly regions: readonly RegionCoordinate[];
  readonly origin: { readonly x: number; readonly y: number };
}

export const NORMAL_MAP_MANIFEST: CookedMapManifest = Object.freeze({
  pageSize: 512,
  regionColumns: 70,
  regionRows: 48,
  regions: Object.freeze(
    [-1, 0, 1].flatMap((vertical) =>
      [-1, 0, 1].map((horizontal) => Object.freeze({ horizontal, vertical })),
    ),
  ),
  origin: Object.freeze({ x: -53760, y: -31744 }),
});

export interface MapLayout {
  readonly manifest: CookedMapManifest;
  readonly minHorizontal: number;
  readonly minVertical: number;
  readonly horizontalRegions: number;
  readonly verticalRegions: number;
  readonly pageColumns: number;
  readonly pageRows: number;
  readonly pageCount: number;
  readonly width: number;
  readonly height: number;
  readonly maxLevel: number;
}

export function mapLayout(input: CookedMapManifest): MapLayout {
  if (!input || !Array.isArray(input.regions) || input.regions.length === 0)
    throw new Error("Cooked map requires an explicit nonempty region list");
  powerOfTwo(input.pageSize, "pageSize");
  positiveInteger(input.regionColumns, "regionColumns");
  positiveInteger(input.regionRows, "regionRows");
  if (
    !input.origin ||
    !Number.isSafeInteger(input.origin.x) ||
    !Number.isSafeInteger(input.origin.y)
  )
    throw new RangeError("Map origin must contain safe integers");
  const keys = new Set<string>();
  let minHorizontal = Infinity,
    minVertical = Infinity,
    maxHorizontal = -Infinity,
    maxVertical = -Infinity;
  const regions = input.regions.map((region) => {
    if (
      !region ||
      !Number.isSafeInteger(region.horizontal) ||
      !Number.isSafeInteger(region.vertical)
    )
      throw new RangeError("Invalid region coordinates");
    const key = `${region.horizontal},${region.vertical}`;
    if (keys.has(key))
      throw new Error("Duplicate region in cooked-map manifest");
    keys.add(key);
    minHorizontal = Math.min(minHorizontal, region.horizontal);
    maxHorizontal = Math.max(maxHorizontal, region.horizontal);
    minVertical = Math.min(minVertical, region.vertical);
    maxVertical = Math.max(maxVertical, region.vertical);
    return Object.freeze({
      horizontal: region.horizontal,
      vertical: region.vertical,
    });
  });
  const horizontalRegions = maxHorizontal - minHorizontal + 1,
    verticalRegions = maxVertical - minVertical + 1;
  if (horizontalRegions * verticalRegions !== regions.length)
    throw new Error("Cooked-map region grid has missing regions");
  const pageColumns = horizontalRegions * input.regionColumns,
    pageRows = verticalRegions * input.regionRows;
  const pageCount = pageColumns * pageRows,
    width = pageColumns * input.pageSize,
    height = pageRows * input.pageSize;
  if (
    ![
      pageColumns,
      pageRows,
      pageCount,
      width,
      height,
      input.origin.x + width,
      input.origin.y + height,
    ].every(Number.isSafeInteger) ||
    pageCount >= 0xffffffff
  )
    throw new RangeError(
      "Cooked-map bounds exceed supported reference capacity",
    );
  const manifest = Object.freeze({
    pageSize: input.pageSize,
    regionColumns: input.regionColumns,
    regionRows: input.regionRows,
    regions: Object.freeze(regions),
    origin: Object.freeze({ x: input.origin.x, y: input.origin.y }),
  });
  return Object.freeze({
    manifest,
    minHorizontal,
    minVertical,
    horizontalRegions,
    verticalRegions,
    pageColumns,
    pageRows,
    pageCount,
    width,
    height,
    maxLevel: Math.ceil(Math.log2(Math.max(width, height))),
  });
}

export function pageIndex(
  layout: MapLayout,
  region: RegionCoordinate,
  x: number,
  y: number,
): number {
  const { manifest } = layout;
  if (
    !region ||
    !Number.isSafeInteger(region.horizontal) ||
    !Number.isSafeInteger(region.vertical) ||
    region.horizontal < layout.minHorizontal ||
    region.horizontal >= layout.minHorizontal + layout.horizontalRegions ||
    region.vertical < layout.minVertical ||
    region.vertical >= layout.minVertical + layout.verticalRegions
  )
    throw new RangeError("Region is outside the cooked-map manifest");
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= manifest.regionColumns ||
    y >= manifest.regionRows
  )
    throw new RangeError("Page is outside its cooked-map region");
  return (
    ((region.vertical - layout.minVertical) * manifest.regionRows + y) *
      layout.pageColumns +
    (region.horizontal - layout.minHorizontal) * manifest.regionColumns +
    x
  );
}
