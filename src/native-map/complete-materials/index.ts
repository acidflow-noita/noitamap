import {
  CAVES_SETUP,
  getModifierGrid,
  bitmapNoiseNodeOffset,
  surfaceNoisePhase,
} from "./seed-modifiers.mjs";
import {
  copyCaveStateModifiers, validateCaveStateBinding, type CaveStateBinding,
} from "../game-state";

export const COMPLETE_MATERIAL_ABI = 3;
export const MATERIAL_UNRESOLVED = -1;
/** Only the first three classifications contain a resolved material ID. */
export const MaterialClassification = {
  resolved: 0,
  outsidePlane: 1,
  forceAir: 2,
  legacy: 3,
  unowned: 4,
  unknownBiome: 5,
  rawBiome: 6,
  unsupportedTopology: 7,
  unsupportedConfiguration: 8,
  outsideCarveTables: 9,
  missingModifier: 10,
} as const;
export type MaterialClassificationCode =
  (typeof MaterialClassification)[keyof typeof MaterialClassification];

export interface CompleteMaterialGrid {
  GW: number;
  GH: number;
  cov: Float32Array;
  mat: Uint16Array;
}
export interface CompleteMaterialLattice extends CompleteMaterialGrid {
  chunkCovered: Uint8Array;
}
export interface CompleteMaterialShaft {
  /** Physical column in the biome map; last duplicate column wins. */
  column: number;
  lattice: CompleteMaterialGrid;
  offsetY: number;
  /** Origin in lattice cells, as in createPlaneMaterialField. */
  originX: number;
}
export interface CompleteMaterialParameters {
  scale: number;
  threshold: number;
  type: number;
  present?: boolean;
}
export interface ModifierGrid {
  W: number;
  H: number;
  data: Float32Array;
  node94: number;
}
export const MODIFIER_KEYS = [
  "$biome_desert",
  "$biome_pyramid",
  "$biome_winter",
  "_EMPTY_",
] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];
export interface Topology0SeedInputs {
  seed: number;
  surfacePhase: number;
  bitmapNoiseOffset: number;
  /** Null explicitly preserves an unavailable input as missingModifier. */
  modifiers: Readonly<Record<ModifierKey, ModifierGrid | null>>;
}
export interface CarveTables {
  hashMin: number;
  hash: Float32Array;
  xMin: number;
  cosine: Float64Array;
  yMin: number;
  sine: Float64Array;
}
export interface CompleteMaterialInputs {
  seed: number;
  lattice: CompleteMaterialLattice;
  biomePixels: ArrayLike<number>;
  mapWidth: number;
  /** Packed engine chunk data: mode bits 8..9, paintsNothing bit 11. */
  hostChunks: Uint32Array;
  parameters: ReadonlyArray<CompleteMaterialParameters>;
  /** Omit for the main plane. A plane deliberately retains topo2-only semantics. */
  plane?: { offsetY: number; shafts?: ReadonlyArray<CompleteMaterialShaft> };
  /** Optional captured or separately prepared inputs, with the same raw seed. */
  topology0?: Topology0SeedInputs;
  /** Validated named runtime grids. Exclusive with a full topology0 override.
   * This narrows a cave-input dependency; it is not a complete game snapshot. */
  generationState?: CaveStateBinding;
  /** Optional finite exact tables. Out-of-table accesses stay unresolved. */
  carveTables?: CarveTables;
}
export interface CompleteMaterialBatch {
  /** Borrowed arrays: valid until this resolver's next resolve call. */
  materials: Int32Array;
  classifications: Uint8Array;
  /** Wobble-resolved cell index; -1 outside the plane. */
  owners: Int32Array;
  /** Host policy has distinct unknown-color behavior; -1 outside the plane. */
  hostOwners: Int32Array;
  unresolvedCount: number;
}
export interface CompleteMaterialResolver {
  readonly abi: typeof COMPLETE_MATERIAL_ABI;
  readonly memoryBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly generationStateDigest: string | null;
  resolve(x: number, y: number, width: number, height: number): CompleteMaterialBatch;
  /** Density must be an exact f32 (as returned by computeMaterialNoiseDensityPoints).
   * A selector's no-match remains -1. IDs are borrowed until next band/density query. */
  selectBandPoints(points: ReadonlyArray<MaterialBandPoint>): Int32Array;
  /** Converts coverage using owned computeMaterialNoiseDensity, then selects a band. */
  resolveCoverageBandPoints(points: ReadonlyArray<MaterialCoveragePoint>): Int32Array;
  /** Borrowed exact f32 density, valid until the next band/density query. */
  computeMaterialNoiseDensityPoints(points: ReadonlyArray<MaterialCoverageSample>): Float32Array;
}
export interface MaterialBandPoint { biomeId: number; x: number; y: number; density: number }
export interface MaterialCoverageSample { x: number; y: number; coverage: number }
export interface MaterialCoveragePoint extends MaterialCoverageSample { biomeId: number }
export interface CompleteMaterialOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** WASM plus borrowed result storage. Default and hard cap: 128 MiB. */
  maxBytes?: number;
}

interface MaterialExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  heap_base(): number;
  abi_version(): number;
  configure(w: number, h: number, c: number, m: number, p: number, count: number, offx: number): void;
  configure_world(colors: number, width: number, covered: number, ids: number): void;
  configure_host_chunks(chunks: number): void;
  configure_vertical(offsetY: number, originX: number, hasOrigin: number, limitOffset: number): void;
  configure_topo0_immutable(hash: number, min: number, count: number, cos: number, xmin: number, xcount: number, sin: number, ymin: number, ycount: number): void;
  configure_topo0_seed(phase: number, offset: number, seed: number, grids: number): void;
  resolve_complete_rect(x: number, y: number, width: number, height: number, mode: number, cosine: number, sine: number, output: number, classes: number, owners: number, guards: number): void;
  select_band_points(points: number, ids: number, count: number, output: number): void;
  resolve_coverage_band_points(points: number, ids: number, count: number, output: number): void;
  compute_density_points(points: number, count: number, output: number): void;
}
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_LATTICE_CELLS = 3584 * 2457;
const MAX_COORDINATE = 2 ** 26;
const align = (n: number) => Math.ceil(n / 16) * 16;
const validTranslation = (n: number) => Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE;
function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError("Material seed must be an unsigned 32-bit integer");
}
function assertGrid(grid: CompleteMaterialGrid): void {
  if (!Number.isInteger(grid.GW) || !Number.isInteger(grid.GH) ||
      grid.GW < 1 || grid.GH < 1 || grid.GW * grid.GH > MAX_LATTICE_CELLS ||
      !(grid.cov instanceof Float32Array) || !(grid.mat instanceof Uint16Array) ||
      grid.cov.length !== grid.GW * grid.GH || grid.mat.length !== grid.cov.length ||
      !grid.cov.every(Number.isFinite))
    throw new RangeError("Invalid complete material lattice");
}

/** Uncached preparation, owned by the caller. Preserves the pinned source chain. */
export function prepareTopology0Seed(seed: number): Topology0SeedInputs {
  return topology0Seed(seed);
}
function topology0Seed(seed: number, overrides?: Partial<Record<ModifierKey, ModifierGrid | null>>): Topology0SeedInputs {
  assertSeed(seed);
  if (Object.keys(CAVES_SETUP).sort().join() !== MODIFIER_KEYS.join())
    throw new Error("Modifier descriptor order differs from the C tables");
  return {
    seed,
    surfacePhase: surfaceNoisePhase(seed),
    bitmapNoiseOffset: bitmapNoiseNodeOffset(seed),
    modifiers: Object.fromEntries(MODIFIER_KEYS.map(key => [key,
      overrides && Object.hasOwn(overrides, key) ? overrides[key] : getModifierGrid(seed, key),
    ])) as Topology0SeedInputs["modifiers"],
  };
}

/** Exact host Math inputs used by the proven scalar kernel; no seed cache. */
export function prepareCarveTables(): CarveTables {
  const hashMin = -47000, xMin = -53824, yMin = -31808;
  const hash = new Float32Array(109001);
  const cosine = new Float64Array(107648), sine = new Float64Array(73856);
  const F = Math.fround;
  for (let i = 0; i < hash.length; i++) {
    const m = F(F(Math.sin(i + hashMin)) * F(43758.546875));
    hash[i] = F(m - Math.floor(m));
  }
  for (let i = 0; i < cosine.length; i++)
    cosine[i] = Math.cos((i + xMin + 0.5) / 1024) * 1024 * 0.5 * 0.05999999865889549;
  for (let i = 0; i < sine.length; i++)
    sine[i] = Math.sin((i + yMin + 0.5) / 1024) * 1024 * 0.5 * 0.05999999865889549;
  return { hashMin, hash, xMin, cosine, yMin, sine };
}

/** No loader, runtime shims, network or DOM. The cooker owns module delivery.
 * Invalid inputs/setup throw; legitimate unresolved pixels are classified.
 * The module and all data are local to this resolver after construction.
 */
export async function createCompleteMaterialResolver(
  input: CompleteMaterialInputs,
  module: WebAssembly.Module,
  options: CompleteMaterialOptions = {},
): Promise<CompleteMaterialResolver> {
  assertSeed(input.seed);
  const imported = input.generationState ? validateCaveStateBinding(input.generationState) : undefined;
  if (imported && (input.topology0 || imported.context.seed !== input.seed ||
      input.mapWidth !== (imported.context.ngPlus > 0 || imported.context.gameMode === "nightmare" ? 64 : 70)))
    throw new Error("Captured cave inputs conflict with the material context or explicit topology0 inputs");
  const { lattice, mapWidth, parameters, plane } = input;
  const parameterCount = parameters.length;
  const vertical = plane !== undefined;
  const cells = mapWidth * 48;
  const maxWidth = options.maxWidth ?? 640, maxHeight = options.maxHeight ?? 640;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (![64, 70].includes(mapWidth) ||
      lattice.chunkCovered.length !== cells || input.biomePixels.length !== cells ||
      input.hostChunks.length !== cells || parameters.length > 65536 ||
      !Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 1024 ||
      !Number.isInteger(maxHeight) || maxHeight < 1 || maxHeight > 4096 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw new RangeError("Invalid complete material inputs or bounds");
  assertGrid(lattice);
  for (const p of parameters)
    if (!Number.isFinite(p.scale) || Math.abs(p.scale) > 1024 ||
        !Number.isFinite(p.threshold) || !Number.isInteger(p.type) || p.type < 0 || p.type > 2)
      throw new RangeError("Invalid material sampling parameters");
  const offsetY = plane?.offsetY ?? 0;
  const shafts = new Map<number, CompleteMaterialShaft>();
  if (plane) {
    if (!Number.isSafeInteger(offsetY) || !validTranslation(offsetY) || (plane.shafts?.length ?? 0) > mapWidth)
      throw new RangeError("Invalid material plane");
    for (const shaft of plane.shafts ?? []) {
      if (!Number.isInteger(shaft.column) || shaft.column < 0 || shaft.column >= mapWidth ||
          !validTranslation(shaft.offsetY) || !validTranslation(shaft.originX))
        throw new RangeError("Invalid material shaft");
      assertGrid(shaft.lattice);
      shafts.set(shaft.column, shaft);
    }
  }
  const seedData = input.topology0 ?? (!plane ? topology0Seed(input.seed,
    input.generationState ? copyCaveStateModifiers(input.generationState) : undefined) : undefined);
  if (seedData && (seedData.seed !== input.seed || !validTranslation(seedData.surfacePhase) || !validTranslation(seedData.bitmapNoiseOffset)))
    throw new RangeError("Topology0 inputs do not match the material seed");
  const tables = input.carveTables ?? (!plane ? prepareCarveTables() : undefined);
  if (tables) {
    if (!(tables.hash instanceof Float32Array) || !(tables.cosine instanceof Float64Array) || !(tables.sine instanceof Float64Array) ||
        ![tables.hashMin, tables.xMin, tables.yMin].every(n => Number.isSafeInteger(n) && validTranslation(n)) ||
        ![tables.hash, tables.cosine, tables.sine].every(a => a.length > 0 && a.length <= 2 ** 21 && a.every(Number.isFinite)))
      throw new RangeError("Invalid carve tables");
  }
  const wasm = (await WebAssembly.instantiate(module)).exports as MaterialExports;
  if (wasm.abi_version() !== COMPLETE_MATERIAL_ABI)
    throw new Error("Unsupported complete material ABI");
  let cursor = align(wasm.heap_base());
  const allocate = (bytes: number) => { const p = cursor; cursor = align(cursor + bytes); return p; };
  const colors = allocate(cells * 4), covered = allocate(cells), ids = allocate(cells * 4);
  const chunks = allocate(cells * 4), params = allocate(parameters.length * 16);
  const hash = allocate(tables?.hash.byteLength ?? 0);
  const carveCos = allocate(tables?.cosine.byteLength ?? 0), carveSin = allocate(tables?.sine.byteLength ?? 0);
  const descriptors = allocate(MODIFIER_KEYS.length * 24);
  const modifiers = MODIFIER_KEYS.map(key => {
    const grid = seedData?.modifiers[key];
    if (!grid) return null;
    if (!Number.isInteger(grid.W) || !Number.isInteger(grid.H) || grid.W < 1 || grid.H < 1 ||
        grid.W * grid.H > MAX_LATTICE_CELLS || !(grid.data instanceof Float32Array) || grid.data.length !== grid.W * grid.H ||
        !validTranslation(grid.node94) || !grid.data.every(Number.isFinite))
      throw new RangeError("Invalid material modifier grid");
    return { grid, pointer: allocate(grid.data.byteLength) };
  });
  const gridCopies: { cov: number; mat: number; source: CompleteMaterialGrid }[] = [];
  function allocateGrid(grid: CompleteMaterialGrid, shaft?: CompleteMaterialShaft) {
    const cov = allocate(grid.cov.byteLength), mat = allocate(grid.mat.byteLength);
    gridCopies.push({ cov, mat, source: grid });
    return { GW: grid.GW, GH: grid.GH, cov, mat,
      shaft: shaft ? { offsetY: shaft.offsetY, originX: shaft.originX } : undefined };
  }
  const main = allocateGrid(lattice);
  const local = new Map([...shafts].map(([col, shaft]) => [col, allocateGrid(shaft.lattice, shaft)]));
  const cosinePointer = allocate(maxWidth * 8), sinePointer = allocate(maxHeight * 8);
  const count = maxWidth * maxHeight;
  const outputPointer = allocate(count * 4), statusPointer = allocate(count);
  const ownersPointer = allocate(count * 4), guardsPointer = allocate(count * 4);
  const bandCapacity = 4096;
  const bandPoints = allocate(bandCapacity * 24), bandIds = allocate(bandCapacity * 4), bandOut = allocate(bandCapacity * 4);
  const stagingBytes = local.size ? count * 13 : 0;
  const requiredBytes = Math.ceil(cursor / 65536) * 65536;
  if (requiredBytes + stagingBytes > maxBytes)
    throw new RangeError("Complete material memory budget exceeded");
  if (requiredBytes > wasm.memory.buffer.byteLength)
    wasm.memory.grow((requiredBytes - wasm.memory.buffer.byteLength) / 65536);
  const memory = wasm.memory.buffer;
  new Uint32Array(memory, colors, cells).set(input.biomePixels);
  new Uint8Array(memory, covered, cells).set(lattice.chunkCovered);
  new Uint32Array(memory, chunks, cells).set(input.hostChunks);
  const parameterTable = new DataView(memory, params, parameters.length * 16);
  parameters.forEach((p, i) => {
    parameterTable.setFloat32(i * 16, p.scale, true);
    parameterTable.setFloat32(i * 16 + 4, p.threshold, true);
    parameterTable.setInt32(i * 16 + 8, p.type, true);
    parameterTable.setInt32(i * 16 + 12, p.present === false ? 0 : 1, true);
  });
  for (const context of gridCopies) {
    new Float32Array(memory, context.cov, context.source.cov.length).set(context.source.cov);
    new Uint16Array(memory, context.mat, context.source.mat.length).set(context.source.mat);
  }
  if (tables) {
    new Float32Array(memory, hash, tables.hash.length).set(tables.hash);
    new Float64Array(memory, carveCos, tables.cosine.length).set(tables.cosine);
    new Float64Array(memory, carveSin, tables.sine.length).set(tables.sine);
    wasm.configure_topo0_immutable(hash, tables.hashMin, tables.hash.length, carveCos, tables.xMin, tables.cosine.length, carveSin, tables.yMin, tables.sine.length);
  }
  const modifierTable = new DataView(memory, descriptors, MODIFIER_KEYS.length * 24);
  modifiers.forEach((value, i) => {
    if (!value) return;
    const { grid, pointer } = value;
    new Float32Array(memory, pointer, grid.data.length).set(grid.data);
    modifierTable.setUint32(i * 24, pointer, true);
    modifierTable.setInt32(i * 24 + 4, grid.W, true);
    modifierTable.setInt32(i * 24 + 8, grid.H, true);
    modifierTable.setFloat64(i * 24 + 16, grid.node94, true);
  });
  wasm.configure_topo0_seed(seedData?.surfacePhase ?? 0, seedData?.bitmapNoiseOffset ?? 0, input.seed, descriptors);
  wasm.configure_world(colors, mapWidth, covered, ids);
  wasm.configure_host_chunks(chunks);
  const cosine = new Float64Array(memory, cosinePointer, maxWidth), sine = new Float64Array(memory, sinePointer, maxHeight);
  const native = {
    materials: new Int32Array(memory, outputPointer, count),
    classifications: new Uint8Array(memory, statusPointer, count),
    owners: new Int32Array(memory, ownersPointer, count),
    hostOwners: new Int32Array(memory, guardsPointer, count),
  };
  const pointData = new Float64Array(memory, bandPoints, bandCapacity * 3);
  const biomeIds = new Int32Array(memory, bandIds, bandCapacity);
  const bandOutput = new Int32Array(memory, bandOut, bandCapacity);
  const densityOutput = new Float32Array(memory, bandOut, bandCapacity);
  function bandQuery(points: ReadonlyArray<MaterialBandPoint | MaterialCoveragePoint>, coverage: boolean) {
    if (points.length > bandCapacity) throw new RangeError("Material band batch exceeds 4096 points");
    points.forEach((p, i) => {
      const value = coverage ? (p as MaterialCoveragePoint).coverage : (p as MaterialBandPoint).density;
      if (!Number.isInteger(p.biomeId) || p.biomeId < 0 || p.biomeId > 65535 ||
          !validTranslation(p.x) || !validTranslation(p.y) || !Number.isFinite(value) || Math.abs(value) > 65536)
        throw new RangeError("Invalid material band point");
      if (!coverage && Math.fround(value) !== value)
        throw new RangeError("Material band density must be an exact float32 value");
      pointData.set([p.x, p.y, value], i * 3);
      biomeIds[i] = p.biomeId;
    });
    (coverage ? wasm.resolve_coverage_band_points : wasm.select_band_points)(bandPoints, bandIds, points.length, bandOut);
    return bandOutput.subarray(0, points.length);
  }
  const output = local.size ? {
    materials: new Int32Array(count), classifications: new Uint8Array(count),
    owners: new Int32Array(count), hostOwners: new Int32Array(count),
  } : native;
  function run(context: typeof main, x: number, y: number, width: number, height: number) {
    const { shaft } = context;
    wasm.configure(context.GW, context.GH, context.cov, context.mat, params, parameterCount, mapWidth * 256);
    if (vertical) wasm.configure_vertical(shaft?.offsetY ?? offsetY, shaft?.originX ?? 0, shaft ? 1 : 0, offsetY);
    for (let col = 0; col < width; col++) cosine[col] = Math.cos((x + col + mapWidth * 256) * 0.005);
    for (let row = 0; row < height; row++) sine[row] = Math.sin((y + row + 7168) * 0.005);
    wasm.resolve_complete_rect(x, y, width, height, !vertical ? 0 : shaft ? 2 : 1, cosinePointer, sinePointer, outputPointer, statusPointer, ownersPointer, guardsPointer);
  }
  return {
    abi: COMPLETE_MATERIAL_ABI,
    memoryBytes: memory.byteLength + stagingBytes,
    maxWidth, maxHeight,
    generationStateDigest: imported?.digest ?? null,
    selectBandPoints(points) { return bandQuery(points, false); },
    resolveCoverageBandPoints(points) { return bandQuery(points, true); },
    computeMaterialNoiseDensityPoints(points) {
      if (points.length > bandCapacity) throw new RangeError("Material density batch exceeds 4096 points");
      points.forEach((p, i) => {
        if (!validTranslation(p.x) || !validTranslation(p.y) || !Number.isFinite(p.coverage) || Math.abs(p.coverage) > 65536)
          throw new RangeError("Invalid material density point");
        pointData.set([p.x, p.y, p.coverage], i * 3);
      });
      wasm.compute_density_points(bandPoints, points.length, bandOut);
      return densityOutput.subarray(0, points.length);
    },
    resolve(x, y, width, height) {
      if (![x, y, width, height].every(Number.isSafeInteger) ||
          Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE ||
          Math.abs(x + width) > MAX_COORDINATE || Math.abs(y + height) > MAX_COORDINATE ||
          width < 1 || height < 1 || width > maxWidth || height > maxHeight)
        throw new RangeError("Invalid complete material rectangle");
      if (!local.size) run(main, x, y, width, height);
      else for (let col = 0; col < width;) {
        const wx = x + col, physical = Math.floor((wx + mapWidth * 256) / 512);
        const column = ((physical % mapWidth) + mapWidth) % mapWidth;
        const span = Math.min(width - col, (physical + 1) * 512 - mapWidth * 256 - wx);
        run(local.get(column) ?? main, wx, y, span, height);
        for (let row = 0; row < height; row++) {
          const start = row * span, end = start + span, target = row * width + col;
          output.materials.set(native.materials.subarray(start, end), target);
          output.classifications.set(native.classifications.subarray(start, end), target);
          output.owners.set(native.owners.subarray(start, end), target);
          output.hostOwners.set(native.hostOwners.subarray(start, end), target);
        }
        col += span;
      }
      const length = width * height;
      let unresolvedCount = 0;
      for (let i = 0; i < length; i++) unresolvedCount += Number(output.classifications[i] >= MaterialClassification.legacy);
      return {
        materials: output.materials.subarray(0, length),
        classifications: output.classifications.subarray(0, length),
        owners: output.owners.subarray(0, length),
        hostOwners: output.hostOwners.subarray(0, length),
        unresolvedCount,
      };
    },
  };
}
