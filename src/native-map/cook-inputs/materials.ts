import { buildEngineLattice } from "./lattice.mjs";
import { BIOME_ENGINE, WANG_PARAMS_BY_ID } from "../complete-materials/engine-data.mjs";
import type { CompleteMaterialInputs, CompleteMaterialLattice, CompleteMaterialShaft } from "../complete-materials/index.ts";
import type { NativeTerrainDescription } from "../world.ts";

export interface CookBiomeConfig {
  color: number;
  wangFile?: string | null;
  fillMaterial?: string;
  sceneOnly?: boolean;
  [key: string]: unknown;
}
export type CookGeneratorConfig = Readonly<Record<string, CookBiomeConfig>>;
export type VerticalPlane = -1 | 0 | 1;
export interface MaterialInputPolicy {
  generatorConfig: CookGeneratorConfig;
  /** Current CPU uses legacy-fill for its authored empty-topology0 stand-ins.
   * engine-air preserves those empty engine fields. This choice is required. */
  emptyTopology0: "engine-air" | "legacy-fill";
}
export interface PreparedMaterialInputs {
  mapWidth: number;
  worldWidth: number;
  worldStride: number;
  centerPx: number;
  sourceBiomePixels: Uint32Array;
  lattice: CompleteMaterialLattice;
  inputs: ReadonlyMap<VerticalPlane, CompleteMaterialInputs>;
  forPlane(plane: VerticalPlane): CompleteMaterialInputs;
}
const slots = new Map<number, number>(BIOME_ENGINE.map((b, i) => [b.color, i]));

export function validateMaterialLayers(layers: readonly any[]): void {
  for (const layer of layers) {
    if (!layer.buffer) continue;
    if (!(layer.buffer instanceof Uint8Array || layer.buffer instanceof Uint8ClampedArray) ||
        ![layer.width, layer.mapH, layer.minX, layer.minY, layer.w, layer.h].every(Number.isSafeInteger) ||
        layer.width < 1 || layer.mapH < 1 || layer.w < 1 || layer.h < 1 ||
        layer.buffer.length < (layer.mapH + 4) * layer.width * 3)
      throw new Error(`Invalid material layer: ${layer.biomeName}`);
  }
}

/** Exact source lattice population, including snapshot neighbor-majority order,
 * strict running-max ties, toroidal neighbors and truncating chunk coordinates. */
export function buildMaterialLattice(
  layers: readonly any[], config: CookGeneratorConfig, width: number, height = 48,
): CompleteMaterialLattice {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      Math.trunc(width * 51.2) * Math.trunc(height * 51.2) > 3584 * 5018)
    throw new RangeError("Invalid material lattice dimensions");
  validateMaterialLayers(layers);
  return buildEngineLattice(Array.from(layers), config, width, height);
}

export function fillMaterialsByBiome(config: CookGeneratorConfig): Map<number, string> {
  const result = new Map<number, string>();
  for (const biome of Object.values(config))
    if (biome.fillMaterial && !biome.sceneOnly)
      result.set(biome.color & 0xffffff, biome.fillMaterial);
  return result;
}

/** Pure buildEngineResources host-policy port; no graphics resources. */
export function buildHostChunks(
  pixels: ArrayLike<number>, lattice: CompleteMaterialLattice, mapWidth: number,
  policy: MaterialInputPolicy,
): Uint32Array {
  if (!["engine-air", "legacy-fill"].includes(policy.emptyTopology0))
    throw new Error("Explicit empty-topology0 host policy is required");
  if (pixels.length !== mapWidth * 48 || lattice.chunkCovered.length !== pixels.length)
    throw new Error("Host chunk dimensions do not match the material lattice");
  const fills = fillMaterialsByBiome(policy.generatorConfig), chunk = new Uint32Array(pixels.length);
  for (let i = 0; i < chunk.length; i++) {
    const color = pixels[i] & 0xffffff, slot = slots.get(color);
    const b = slot === undefined ? null : BIOME_ENGINE[slot];
    const paintsNothing = !!b && (b.paintsNothing || (b.topo === 0 && b.bands.length === 0));
    const deferToFill = policy.emptyTopology0 === "legacy-fill" && paintsNothing && !b!.paintsNothing && fills.has(color);
    let mode = 2;
    if (b && b.supported && !deferToFill)
      mode = b.topo === 2 ? lattice.chunkCovered[i] ? 1 : 2 : 0;
    chunk[i] = (slot ?? 0) | (mode << 8) | (b?.noiseBiomeEdges ? 1 << 10 : 0) |
      (paintsNothing && !deferToFill ? 1 << 11 : 0);
  }
  return chunk;
}

/** The three planes share original Wang geometry. Only biome lookup broadcasts
 * the top/bottom rows. Hell shafts receive independent rebased local lattices. */
export function prepareWorldMaterialInputs(
  world: NativeTerrainDescription, policy: MaterialInputPolicy,
): PreparedMaterialInputs {
  const width = world.biomeData.pixels.length / 48;
  if (![64, 70].includes(width) || world.worldSize !== width || world.worldCenter * 2 !== width)
    throw new Error("Invalid native world geometry dimensions");
  const pixels = Uint32Array.from(world.biomeData.pixels);
  const lattice = buildMaterialLattice(world.tileLayers, policy.generatorConfig, width);
  const shafts: CompleteMaterialShaft[] = [];
  for (const shaft of world.elevatorShafts ?? []) {
    if (!Number.isSafeInteger(shaft.minX) || shaft.minX < 0 || shaft.minX >= width)
      throw new Error("Invalid shaft column");
    const local = { ...shaft, minX: 0, minY: 0, chunkBasePos: { x: 0, y: 0 }, validChunks: undefined };
    shafts.push({
      column: shaft.minX,
      lattice: buildMaterialLattice([local], policy.generatorConfig, Math.ceil(shaft.w / 512), Math.ceil(shaft.h / 512)),
      offsetY: Math.trunc(shaft.minY * 512 / 10) * 10,
      originX: Math.trunc(shaft.minX * 512 / 10),
    });
  }
  const parameters = WANG_PARAMS_BY_ID.map(([scale, threshold, type]) => ({ scale, threshold, type }));
  const inputs = new Map<VerticalPlane, CompleteMaterialInputs>();
  for (const plane of [-1, 0, 1] as const) {
    let biomePixels = pixels;
    if (plane !== 0) {
      biomePixels = new Uint32Array(width * 48);
      const row = plane < 0 ? 0 : 47;
      for (let y = 0; y < 48; y++) biomePixels.set(pixels.subarray(row * width, (row + 1) * width), y * width);
    }
    inputs.set(plane, {
      seed: world.seed, mapWidth: width, lattice, parameters, biomePixels,
      hostChunks: buildHostChunks(biomePixels, lattice, width, policy),
      ...(plane === 0 ? {} : { plane: { offsetY: plane * 24576, ...(plane === 1 ? { shafts } : {}) } }),
    });
  }
  return {
    mapWidth: width, worldWidth: width * 512,
    worldStride: world.ngPlus > 0 || world.gameMode === "nightmare" ? 64 * 512 - 8 : 70 * 512,
    centerPx: width * 256, sourceBiomePixels: pixels, lattice, inputs,
    forPlane(plane) {
      const input = inputs.get(plane);
      if (!input) throw new Error("Unknown material plane");
      return input;
    },
  };
}
