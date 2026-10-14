#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = new URL("./", import.meta.url);
const files = [
  "index.ts", "materials.ts", "atlas.ts", "legacy.ts", "foreground.ts",
  "lattice.mjs", "legacy-biome.mjs", "legacy-edge-noise.mjs", "NOTICE.txt",
  "LICENSE-telescope.txt", "parity.mjs", "verify.mjs",
  "../complete-materials/engine-data.mjs", "../complete-materials/build-identity.json", "../png.ts",
];
const reference = [
  "lib/noita-telescope-vm/js/engine_resolve/lattice_builder.js",
  "lib/noita-telescope-vm/js/gl/engine_resources.js",
  "lib/noita-telescope-vm/js/gl/material_atlas.js",
  "lib/noita-telescope-vm/js/gl/chunk_textures.js",
  "lib/noita-telescope-vm/js/gl/indirection.js",
  "lib/noita-telescope-vm/js/gl/palette.js",
  "lib/noita-telescope-vm/js/edge_noise.js",
  "lib/noita-telescope-vm/js/utils.js",
  "lib/noita-telescope-vm/js/image_processing.js",
  "lib/noita-telescope-vm/js/potion_config.js",
  "src/telescope/cpu-terrain-core.ts",
  "src/telescope/terrain-planes.ts",
];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const local = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(new URL(file, base)))])));
if (process.argv.includes("--record")) {
  const referenceSha256 = Object.fromEntries(await Promise.all(reference.map(async file => [file, digest(await readFile(new URL("../../../" + file, base)))])));
  await writeFile(new URL("provenance.json", base), JSON.stringify({
    referenceCommit: "9c587750c361e88583fe8df406d74136bbcc1dde",
    attribution: "Copyright (c) 2026 Lymm; MIT, see LICENSE-telescope.txt",
    scope: "Owned geometry/material input preparation, explicit host policy, atlas and source raw foreground",
    sourceSha256: referenceSha256, sha256: local,
  }, null, 2) + "\n");
}
const saved = JSON.parse(await readFile(new URL("provenance.json", base), "utf8"));
for (const [file, hash] of Object.entries(local))
  if (saved.sha256[file] !== hash) throw new Error(`Cook-input identity changed: ${file}`);
console.log("Cook-input implementation and owned dependency identity verified.");
