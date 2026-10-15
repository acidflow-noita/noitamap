import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Identity of the source and asset inputs used by a resumable native bake. */
export async function bakeCodeHash(root) {
  const fingerprint = createHash("sha256");
  for (const directory of [
    "src/telescope",
    "src/telescope/starting-equipment",
    "src/native-map",
    "src/native-map/materials",
    "src/native-map/edges",
    "lib/noita-telescope-vm/js",
    "lib/noita-telescope-vm/js/engine_resolve",
    "lib/noita-telescope-vm/js/gl",
    "build_scripts",
  ]) {
    for (const name of (await readdir(resolve(root, directory))).sort()) {
      if (!/\.(ts|js|mjs|cjs|c|h|wasm)$/.test(name)) continue;
      fingerprint.update(directory + "/" + name);
      fingerprint.update(await readFile(resolve(root, directory, name)));
    }
  }
  for (const file of [
    "src/report-inventory.ts",
    "package-lock.json",
    "public/data.zip",
    "public/wang_tiles.zip",
    "public/pixel_scenes.zip",
    "lib/noita-telescope-vm/data/material_atlas.bin",
    "lib/noita-telescope-vm/data/material_atlas.json",
    "lib/noita-telescope-vm/data/edge_atlas.bin",
  ])
    fingerprint.update(await readFile(resolve(root, file)));
  return fingerprint.digest("hex").slice(0, 16);
}
