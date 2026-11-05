/** Production generation metadata and sparse liquid-mask publication helpers.
 * Manifests and seed.txt remain the terrain baker's responsibility after every
 * requested tile tree and companion mask has finished. */
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LIQUID_MASK_VERSION, maskBlock, encodeLiquidMask, decodeLiquidMask } from "../src/liquids/mask-codec.ts";

export { LIQUID_MASK_VERSION };

export const REPORT_INVENTORY_VERSION = 3;
const worlds = { left: -1, middle: 0, right: 1 };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function worldId(world) {
  if (!Object.hasOwn(worlds, world)) throw new Error(`Unknown bake world: ${world}`);
  return worlds[world];
}
function assertGeneration(metadata, seed) {
  if (!object(metadata) || metadata.version !== 1 || metadata.seed !== seed
    || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
    || !Number.isSafeInteger(metadata.ngPlus) || metadata.ngPlus < 0 || typeof metadata.isNGP !== "boolean"
    || !Number.isSafeInteger(metadata.worldSize) || metadata.worldSize <= 0
    || !Number.isFinite(metadata.worldCenter)
    || !Number.isSafeInteger(metadata.biomeDataW) || metadata.biomeDataW <= 0
    || !Number.isSafeInteger(metadata.biomeDataH) || metadata.biomeDataH <= 0
    || typeof metadata.biomeDataPixels !== "string"
    || Buffer.from(metadata.biomeDataPixels, "base64").byteLength !== metadata.biomeDataW * metadata.biomeDataH * 4
    || !Array.isArray(metadata.parallelWorlds) || !metadata.parallelWorlds.every(Number.isSafeInteger))
    throw new Error(`Invalid generation metadata for seed ${seed}`);
  for (const field of ["poisByPW", "pixelScenesByPW"]) {
    if (!object(metadata[field]) || Object.entries(metadata[field]).some(([key, records]) =>
      !/^-?\d+,-?\d+$/.test(key) || !Array.isArray(records)))
      throw new Error(`Invalid ${field} for seed ${seed}`);
  }
}
function assertInventory(inventory, seed, pw) {
  if (!object(inventory) || inventory.version !== REPORT_INVENTORY_VERSION || inventory.seed !== seed
    || !object(inventory.worlds) || !Object.hasOwn(inventory.worlds, pw) || !object(inventory.worlds[pw]))
    throw new Error(`Missing or invalid report inventory for seed ${seed}, world ${pw}`);
  for (const kind of ["spells", "materials", "ukkos"]) {
    const counts = inventory.worlds[pw][kind];
    if (!object(counts) || Object.values(counts).some(count => !Array.isArray(count) || count.length !== 2
      || count.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)))
      throw new Error(`Invalid ${kind} report inventory for seed ${seed}, world ${pw}`);
  }
}

/** Verify a published file is exactly one horizontal world's metadata. */
export function assertBakedWorldMetadata(metadata, world, seed) {
  const pw = worldId(world);
  assertGeneration(metadata, seed);
  assertInventory(metadata.reportInventory, seed, pw);
  if (metadata.parallelWorlds.length !== 1 || metadata.parallelWorlds[0] !== pw
    || Object.keys(metadata.reportInventory.worlds).length !== 1)
    throw new Error(`Unexpected world scope in ${world} generation metadata`);
  for (const field of ["poisByPW", "pixelScenesByPW"])
    if (!Object.keys(metadata[field]).length || Object.keys(metadata[field]).some(key => Number(key.split(",")[0]) !== pw))
      throw new Error(`Unexpected world scope in ${world} ${field}`);
  return metadata;
}

export function createBakedWorldMetadata(metadata, world, seed) {
  const pw = worldId(world);
  assertGeneration(metadata, seed);
  if (!metadata.parallelWorlds.includes(pw)) throw new Error(`Missing ${world} generation metadata`);
  assertInventory(metadata.reportInventory, seed, pw);
  const slice = records => Object.fromEntries(Object.entries(records).filter(([key]) => Number(key.split(",")[0]) === pw));
  return assertBakedWorldMetadata({
    ...metadata,
    parallelWorlds: [pw],
    reportInventory: { ...metadata.reportInventory, worlds: { [pw]: metadata.reportInventory.worlds[pw] } },
    poisByPW: slice(metadata.poisByPW),
    pixelScenesByPW: slice(metadata.pixelScenesByPW),
  }, world, seed);
}

export async function writeBakedWorldMetadata(directory, world, metadata, seed) {
  const sliced = createBakedWorldMetadata(metadata, world, seed);
  const root = join(directory, world), path = join(root, "generation.json"), temporary = `${path}.tmp`;
  await mkdir(root, { recursive: true });
  await writeFile(temporary, JSON.stringify(sliced));
  await rename(temporary, path);
  return sliced;
}

export async function readBakedWorldMetadata(directory, world, seed) {
  worldId(world);
  const metadata = JSON.parse(await readFile(join(directory, world, "generation.json"), "utf8"));
  return assertBakedWorldMetadata(metadata, world, seed);
}

// Private checkpoints include a valid empty-mask header for known-empty tiles.
// A legacy core PNG without this versioned sibling must be rendered again.
export const liquidMaskCheckpointPath = core => `${core}.liquid-v${LIQUID_MASK_VERSION}.bin`;
export function encodeLiquidMaskCheckpoint(tile, pixels) {
  const block = maskBlock(tile.x, tile.y, tile.width, tile.height, pixels);
  return encodeLiquidMask(block ? [block] : []);
}
export async function readLiquidMaskCheckpoint(tile) {
  const path = liquidMaskCheckpointPath(tile.path), size = (await stat(path)).size;
  if (size < 12 || size > 28 + tile.width * tile.height * 6)
    throw new Error(`Invalid liquid mask checkpoint size: ${path}`);
  const bytes = await readFile(path);
  const blocks = decodeLiquidMask(bytes);
  if (blocks.length > 1 || blocks.some(b => b.x !== tile.x || b.y !== tile.y ||
    b.width !== tile.width || b.height !== tile.height))
    throw new Error(`Liquid mask checkpoint does not match tile ${tile.x},${tile.y}`);
  return blocks[0] ?? null;
}
export async function completeLiquidMaskCheckpoint(tile) {
  try { await readLiquidMaskCheckpoint(tile); return true; } catch { return false; }
}

/** Publish exactly one bounded sparse file after every leaf checkpoint validates.
 * No mask is inferred from a rendered image or an absent checkpoint. */
export async function writeBakedWorldLiquidMask(directory, world, seed, renderId, region, tiles) {
  worldId(world);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !renderId ||
    ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
    region.width <= 0 || region.height <= 0)
    throw new Error("Invalid baked liquid mask scope");
  const cols = Math.ceil(region.width / 512), rows = Math.ceil(region.height / 512);
  if (tiles.length !== cols * rows) throw new Error("Incomplete liquid mask tile inventory");
  const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x), blocks = [];
  let encodedBytes = 12;
  for (let n = 0; n < ordered.length; n++) {
    const tile = ordered[n], col = n % cols, row = Math.floor(n / cols);
    if (tile.x !== region.x + col * 512 || tile.y !== region.y + row * 512 ||
      tile.width !== Math.min(512, region.width - col * 512) ||
      tile.height !== Math.min(512, region.height - row * 512))
      throw new Error("Incomplete or duplicate liquid mask tile coverage");
    if (!(await stat(tile.path)).size) throw new Error(`Missing core for liquid mask: ${tile.path}`);
    const block = await readLiquidMaskCheckpoint(tile);
    if (block) {
      encodedBytes += 16 + block.runs.byteLength;
      // Keep a single published file inside the existing Pages asset limit,
      // and bound accumulation before allocating the final encoded buffer.
      if (encodedBytes > 25 * 1024 * 1024) throw new Error("Baked liquid mask exceeds public file limit");
      blocks.push(block);
    }
  }
  const bytes = encodeLiquidMask(blocks), root = join(directory, world);
  const path = join(root, "liquid-mask.bin"), temporary = `${path}.tmp`;
  await mkdir(root, { recursive: true });
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return {
    version: LIQUID_MASK_VERSION, path: "liquid-mask.bin", bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), seed, renderId,
  };
}

export async function readBakedWorldLiquidMask(directory, world, seed, renderId, descriptor) {
  worldId(world);
  if (!object(descriptor) || descriptor.version !== LIQUID_MASK_VERSION ||
    descriptor.path !== "liquid-mask.bin" || descriptor.seed !== seed || descriptor.renderId !== renderId ||
    !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 12 || descriptor.bytes > 25 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/.test(descriptor.sha256))
    throw new Error(`Missing or invalid ${world} liquid mask descriptor`);
  const path = join(directory, world, descriptor.path);
  if ((await stat(path)).size !== descriptor.bytes) throw new Error(`Invalid ${world} liquid mask length`);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256)
    throw new Error(`Invalid ${world} liquid mask digest`);
  return decodeLiquidMask(bytes);
}
