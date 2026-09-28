import { normalizePath, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const files = {
  main: "data.zip",
  pixel_scenes: "pixel_scenes.zip",
  wang_tiles: "wang_tiles.zip",
};

/** The exact shipped ZIP bytes define freshness; a cached archive needs no
 * network validation. Keep one stable CacheStorage entry per physical URL. */
export function dataArchivesPlugin(root: string): Plugin {
  const name = "virtual:noitamap-data-archives",
    id = "\0" + name;
  const paths = Object.entries(files).map(([key, file]) => [
    key,
    normalizePath(resolve(root, "public", file)),
  ]);
  const backgrounds = normalizePath(resolve(root, "public", "biome_bg"));
  return {
    name: "noitamap-data-archives",
    buildStart() {
      // In dev, Vite treats load()'s watched paths as module dependencies.
      // A directory is not importable. Register it outside the module load
      // to retain new/deleted-image watching without creating a bogus import.
      this.addWatchFile(backgrounds);
    },
    resolveId(source) {
      if (source === name) return id;
    },
    async load(source) {
      if (source !== id) return;
      // Hash these small standalone downloads independently of data.zip. The
      // browser receives only this manifest and never hashes/downloads the ZIP
      // merely to check a background image's freshness.
      const backgroundPaths = (
        await readdir(backgrounds, { withFileTypes: true })
      )
        .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
        .map((entry) => [entry.name, normalizePath(resolve(backgrounds, entry.name))])
        .sort(([a], [b]) => a.localeCompare(b));
      const hashEntries = (entries: string[][]) =>
        Promise.all(
          entries.map(async ([key, path]) => {
            this.addWatchFile(path);
            return [
              key,
              createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
            ];
          }),
        );
      const [entries, backgroundEntries] = await Promise.all([
        hashEntries(paths),
        hashEntries(backgroundPaths),
      ]);
      return `export const archiveRevisions = ${JSON.stringify(Object.fromEntries(entries))};\nexport const biomeBackgroundRevisions = ${JSON.stringify(Object.fromEntries(backgroundEntries))};`;
    },
    hotUpdate({ file }) {
      file = normalizePath(file);
      if (
        !paths.some(([, path]) => path === file) &&
        !(dirname(file) === backgrounds && /\.png$/i.test(file))
      )
        return;
      const { moduleGraph, hot } = this.environment;
      const module = moduleGraph.getModuleById(id);
      if (module) moduleGraph.invalidateModule(module);
      hot.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}
