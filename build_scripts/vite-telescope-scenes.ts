import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sceneInputFingerprint } from "./telescope-scene-provenance.mjs";

/** The runtime asset URL and source provenance are compiled together. A changed
 * fork/archive cannot accidentally consume an older seed-independent cache. */
export function telescopeScenesPlugin(root: string): Plugin {
  const name = "virtual:noitamap-scene-assets",
    internal = "\0" + name;
  let command = "build";
  return {
    name: "noitamap-prepared-scenes",
    configResolved(config) {
      command = config.command;
    },
    resolveId(id) {
      if (id === name) return internal;
    },
    async load(id) {
      if (id !== internal) return;
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
        manifest.provenance !== (await sceneInputFingerprint(root))
      )
        throw new Error(
          "Prepared Telescope scene assets are stale. Run npm run prepare-telescope-scenes.",
        );
      const urls: string[] = [];
      for (const key of ["full", "approx"]) {
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
