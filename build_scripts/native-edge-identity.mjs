import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const nativeEdgeAbi = 1;
export const nativeEdgeArtifact = "src/native-map/edges/core.wasm";
export const nativeEdgeManifest = "src/native-map/edges/build-identity.json";
export const nativeEdgeInputs = [
  "build_scripts/build-native-edges.mjs",
  "build_scripts/native-edge-identity.mjs",
  "src/native-map/edges/core.c",
  "src/native-map/edges/core.ts",
  "src/native-map/edges/data.ts",
  "src/native-map/edges/types.ts",
  "src/native-map/edges/index.ts",
  "lib/noita-telescope-vm/js/edge_decals.js",
  "lib/noita-telescope-vm/js/engine_resolve/edge_data.js",
  "lib/noita-telescope-vm/js/engine_resolve/engine_data.js",
  "lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js",
  "lib/noita-telescope-vm/js/engine_resolve/simplex_noise.js",
  "lib/noita-telescope-vm/js/pixel_scene_edge_flags.js",
  "lib/noita-telescope-vm/data/edge_atlas.bin",
];
export async function nativeEdgeHashes(root) {
  return Object.fromEntries(
    await Promise.all(
      [...nativeEdgeInputs, nativeEdgeArtifact].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
}
export async function verifyNativeEdgeBuild(root) {
  const message =
    "Native edge WASM is stale; set WASI_SDK_PATH and run node build_scripts/build-native-edges.mjs";
  let recorded, actual;
  try {
    recorded = JSON.parse(
      await readFile(resolve(root, nativeEdgeManifest), "utf8"),
    );
    actual = await nativeEdgeHashes(root);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (
    recorded.abi !== nativeEdgeAbi ||
    Object.keys(actual).some((file) => actual[file] !== recorded.sha256?.[file])
  )
    throw new Error(message);
}
