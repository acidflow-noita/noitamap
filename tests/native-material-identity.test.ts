import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeMaterialAbi,
  nativeMaterialInputs,
  nativeMaterialArtifact,
  nativeMaterialManifest,
  nativeMaterialHashes,
  verifyNativeMaterialBuild,
} from "../build_scripts/native-material-identity.mjs";

it("rejects stale C, tables, borrowed source and compiled WASM before a build", async () => {
  const root = await mkdtemp(join(tmpdir(), "noitamap-material-identity-"));
  try {
    for (const file of [...nativeMaterialInputs, nativeMaterialArtifact]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "original");
    }
    await writeFile(
      join(root, nativeMaterialManifest),
      JSON.stringify({
        abi: nativeMaterialAbi,
        sha256: await nativeMaterialHashes(root),
      }),
    );
    await expect(verifyNativeMaterialBuild(root)).resolves.toBeUndefined();
    for (const file of [
      "src/native-map/materials/topo2.c",
      "src/native-map/materials/vertical.c",
      "src/native-map/materials/index.ts",
      "src/telescope/plane-material-field.ts",
      "src/native-map/materials/constants.h",
      "lib/noita-telescope-vm/js/engine_resolve/engine_data.js",
      nativeMaterialArtifact,
    ]) {
      await writeFile(join(root, file), "modified");
      await expect(verifyNativeMaterialBuild(root)).rejects.toThrow(
        "Native material WASM is stale",
      );
      await writeFile(join(root, file), "original");
    }
    await expect(verifyNativeMaterialBuild(root)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
