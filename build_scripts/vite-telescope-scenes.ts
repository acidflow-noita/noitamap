import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sceneInputFingerprint } from "./telescope-scene-provenance.mjs";
import { createBuildCache } from "./vite-build-cache.ts";

export function createSceneInputs(root: string) {
  return createBuildCache(async () => {
    const files: string[] = [];
    const fingerprint = await sceneInputFingerprint(root, (file: string) => files.push(file));
    return { fingerprint, files };
  });
}

/** The runtime asset URL and source provenance are compiled together. A changed
 * fork/archive cannot accidentally consume an older seed-independent cache. */
export function telescopeScenesPlugin(root: string, inputs = createSceneInputs(root)): Plugin {
  const name = "virtual:noitamap-scene-assets",
    internal = "\0" + name,
    identity = "virtual:noitamap-telescope-asset-identity";
  let command = "build";
  let worker = false;
  return {
    name: "noitamap-prepared-scenes",
    configResolved(config) {
      command = config.command;
      worker = config.isWorker;
    },
    buildStart() { if (!worker) inputs.invalidate(); },
    watchChange() { inputs.invalidate(); },
    resolveId(id) {
      if (id === name) return internal;
      if (id === identity) return "\0" + identity;
    },
    async load(id) {
      // Scene preparation itself imports the data bridge. This identity must
      // be available before the prepared pack/manifest exists.
      if (id !== internal && id !== "\0" + identity) return;
      const { fingerprint, files } = await inputs.read();
      for (const file of files) this.addWatchFile(file);
      if (id === "\0" + identity)
        return `export const provenance = ${JSON.stringify(fingerprint)};`;
      const dir = resolve(root, "build_data/telescope-scenes");
      let manifest: any;
      try {
        manifest = JSON.parse(
          await readFile(resolve(dir, "manifest.json"), "utf8"),
        );
      } catch {
        throw new Error(
          "Prepared Telescope scene assets are missing. Run npm run prepare-telescope-scenes.",
        );
      }
      if (
        manifest.version !== 1 ||
        manifest.provenance !== fingerprint
      )
        throw new Error(
          "Prepared Telescope scene assets are stale. Run npm run prepare-telescope-scenes.",
        );
      const urls: string[] = [];
      for (const key of ["full", "approx", "pixels"]) {
        const pack = manifest.packs[key];
        if (!pack || pack.file !== `${key}.bin.gz`)
          throw new Error("Invalid prepared scene asset manifest");
        const path = resolve(dir, pack.file),
          source = await readFile(path);
        if (createHash("sha256").update(source).digest("hex") !== pack.sha256)
          throw new Error("Prepared scene asset checksum mismatch");
        this.addWatchFile(path);
        const url =
          command === "serve"
            ? JSON.stringify(`/@fs/${path}`)
            : `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: "asset", name: `telescope-scenes-${key}.bin.gz`, source })}`;
        urls.push(
          `${JSON.stringify(key)}: { url: ${url}, scenes: ${pack.scenes}, bytes: ${pack.packedBytes} }`,
        );
      }
      return `export const provenance = ${JSON.stringify(manifest.provenance)}; export const packs = { ${urls.join(",")} };`;
    },
  };
}
