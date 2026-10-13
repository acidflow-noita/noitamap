import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeEdgeAbi,
  nativeEdgeInputs,
  nativeEdgeArtifact,
  nativeEdgeManifest,
  nativeEdgeHashes,
  verifyNativeEdgeBuild,
} from "../build_scripts/native-edge-identity.mjs";

it("rejects stale C, tables, borrowed source and compiled WASM before a build", async () => {
  const root = await mkdtemp(join(tmpdir(), "noitamap-edge-identity-"));
  try {
    for (const file of [...nativeEdgeInputs, nativeEdgeArtifact]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "original");
    }
    await writeFile(
      join(root, nativeEdgeManifest),
      JSON.stringify({
        abi: nativeEdgeAbi,
        sha256: await nativeEdgeHashes(root),
      }),
    );
    await expect(verifyNativeEdgeBuild(root)).resolves.toBeUndefined();
    for (const file of [
      "src/native-map/edges/core.c",
      "src/native-map/edges/core.ts",
      "src/native-map/edges/index.ts",
      "src/native-map/edges/types.ts",
      "src/native-map/edges/data.ts",
      "lib/noita-telescope-vm/js/edge_decals.js",
      "lib/noita-telescope-vm/data/edge_atlas.bin",
      "src/native-map/edges/data.ts",
      nativeEdgeArtifact,
    ]) {
      await writeFile(join(root, file), "modified");
      await expect(verifyNativeEdgeBuild(root)).rejects.toThrow(
        "Native edge WASM is stale",
      );
      await writeFile(join(root, file), "original");
    }
    await expect(verifyNativeEdgeBuild(root)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
