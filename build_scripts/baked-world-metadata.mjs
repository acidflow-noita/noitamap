/** Production generation.json writer, independently exercisable without tiles.
 * This writes metadata only: manifests and seed.txt remain the terrain baker's
 * responsibility after every requested tile tree has finished. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
