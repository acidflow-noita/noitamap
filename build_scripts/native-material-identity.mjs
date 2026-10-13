import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const nativeMaterialAbi = 2;
export const nativeMaterialInputs = [
  "build_scripts/build-native-materials.mjs",
  "build_scripts/generate-native-material-tables.mjs",
  "src/native-map/materials/topo2.c",
  "src/native-map/materials/bands.c",
  "src/native-map/materials/ownership.c",
  "src/native-map/materials/vertical.c",
  "src/native-map/materials/index.ts",
  "src/telescope/plane-material-field.ts",
  "src/native-map/materials/constants.h",
  "src/native-map/materials/bands-data.h",
  ...[
    "engine_data.js",
    "topo2_resolve.js",
    "perlin_noise.js",
    "carve_noise.js",
    "simplex_noise.js",
    "band_select.js",
    "chunk_wobble.js",
    "material_field.js",
    "lattice_builder.js",
  ].map((name) => `lib/noita-telescope-vm/js/engine_resolve/${name}`),
];
export const nativeMaterialArtifact =
  "src/native-map/materials/owned-materials.wasm";
export const nativeMaterialManifest =
  "src/native-map/materials/build-identity.json";
export async function nativeMaterialHashes(root) {
  return Object.fromEntries(
    await Promise.all(
      [...nativeMaterialInputs, nativeMaterialArtifact].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
}
export async function verifyNativeMaterialBuild(root) {
  const message =
    "Native material WASM is stale; set WASI_SDK_PATH and run node build_scripts/build-native-materials.mjs";
  let recorded, actual;
  try {
    recorded = JSON.parse(
      await readFile(resolve(root, nativeMaterialManifest), "utf8"),
    );
    actual = await nativeMaterialHashes(root);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (
    recorded.abi !== nativeMaterialAbi ||
    Object.keys(actual).some((file) => actual[file] !== recorded.sha256?.[file])
  )
    throw new Error(message);
}
