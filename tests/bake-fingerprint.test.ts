import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bakeCodeHash } from "../build_scripts/bake-fingerprint.mjs";

it("invalidates a resumed bake when owned geometry changes and is stable otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "noitamap-bake-fingerprint-"));
  try {
    const files = [
      "src/telescope/terrain-policy.ts",
      "src/native-map/biomes.js",
      "src/native-map/materials/topo2.c",
      "src/native-map/materials/constants.h",
      "src/native-map/materials/owned-materials.wasm",
      "src/native-map/edges/core.c",
      "src/native-map/edges/core.ts",
      "src/native-map/edges/data.ts",
      "src/native-map/edges/core.wasm",
      "lib/noita-telescope-vm/js/generator_config.js",
      "lib/noita-telescope-vm/js/engine_resolve/engine_data.js",
      "lib/noita-telescope-vm/js/gl/shaders.js",
      "build_scripts/bake-fingerprint.mjs",
      "src/report-inventory.ts",
      "package-lock.json",
      "public/data.zip",
      "public/wang_tiles.zip",
      "public/pixel_scenes.zip",
      "lib/noita-telescope-vm/data/material_atlas.bin",
      "lib/noita-telescope-vm/data/material_atlas.json",
      "lib/noita-telescope-vm/data/edge_atlas.bin",
    ];
    for (const file of files) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        file === "src/native-map/biomes.js" ? "geometry-a" : file,
      );
    }
    const original = await bakeCodeHash(root);
    expect(await bakeCodeHash(root)).toBe(original);
    for (const file of ["topo2.c", "constants.h", "owned-materials.wasm"]) {
      const path = join(root, "src/native-map/materials", file);
      const content = "src/native-map/materials/" + file;
      await writeFile(path, "changed-native-input");
      expect(await bakeCodeHash(root)).not.toBe(original);
      await writeFile(path, content);
      expect(await bakeCodeHash(root)).toBe(original);
    }
    for (const file of [
      "src/native-map/edges/core.c",
      "src/native-map/edges/core.ts",
      "src/native-map/edges/data.ts",
      "src/native-map/edges/core.wasm",
      "lib/noita-telescope-vm/data/edge_atlas.bin",
    ]) {
      await writeFile(join(root, file), "changed-edge-input");
      expect(await bakeCodeHash(root)).not.toBe(original);
      await writeFile(join(root, file), file);
      expect(await bakeCodeHash(root)).toBe(original);
    }
    // Same-length source edits must invalidate even when no asset/version changes.
    await writeFile(join(root, "src/native-map/biomes.js"), "geometry-b");
    expect(await bakeCodeHash(root)).not.toBe(original);
    await writeFile(join(root, "src/native-map/biomes.js"), "geometry-a");
    expect(await bakeCodeHash(root)).toBe(original);
    await writeFile(
      join(root, "src/native-map/geometry.ts"),
      "new-owned-input",
    );
    expect(await bakeCodeHash(root)).not.toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
