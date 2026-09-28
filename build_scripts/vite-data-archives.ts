import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
    resolve(root, "public", file),
  ]);
  return {
    name: "noitamap-data-archives",
    resolveId(source) {
      if (source === name) return id;
    },
    async load(source) {
      if (source !== id) return;
      const entries = await Promise.all(
        paths.map(async ([key, path]) => {
          this.addWatchFile(path);
          return [
            key,
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ];
        }),
      );
      return `export const archiveRevisions = ${JSON.stringify(Object.fromEntries(entries))};`;
    },
    handleHotUpdate({ file, server }) {
      if (!paths.some(([, path]) => path === file)) return;
      const module = server.moduleGraph.getModuleById(id);
      if (module) server.moduleGraph.invalidateModule(module);
      server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}
