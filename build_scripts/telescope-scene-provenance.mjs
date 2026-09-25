import { createHash } from "node:crypto";
import { readdir, readFile, access } from "node:fs/promises";
import { resolve, relative } from "node:path";

export async function sceneInputFingerprint(root) {
  let approximateFork = process.env.NOITAMAP_TELESCOPE || "lib/noita-telescope";
  try {
    await access(resolve(root, approximateFork, "js"));
  } catch {
    approximateFork = "lib/noita-telescope";
  }
  const files = [
    "public/data.zip",
    "public/pixel_scenes.zip",
    "build_scripts/telescope-scene-fixture.ts",
    "build_scripts/vite-telescope-browser.ts",
    "src/telescope/scene-pack.ts",
    "src/telescope/worker-scenes.ts",
    "src/telescope/telescope-asset-paths.ts",
    "src/telescope/telescope-assets.ts",
    "src/telescope/telescope-data-bridge.ts",
    "src/telescope/zip-extraction-shim.ts",
    "src/telescope/telescope-dom-shim.ts",
    "src/telescope/full-pixel-data.ts",
  ];
  async function walk(path) {
    for (const entry of await readdir(resolve(root, path), {
      withFileTypes: true,
    })) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.(js|json|bin|png|csv)$/.test(next)) files.push(next);
    }
  }
  for (const fork of new Set([approximateFork, "lib/noita-telescope-vm"]))
    for (const directory of ["js", "data"]) await walk(`${fork}/${directory}`);
  const hash = createHash("sha256");
  hash.update(`approximate-fork:${approximateFork}\0`);
  for (const path of files.sort()) {
    const data = await readFile(resolve(root, path));
    hash
      .update(relative(root, resolve(root, path)))
      .update("\0")
      .update(String(data.length))
      .update("\0")
      .update(data);
  }
  return hash.digest("hex");
}
