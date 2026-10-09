import { normalizePath, type Plugin, type ResolvedConfig } from "vite";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { archiveFiles, buildRuntimeAssets } from './runtime-assets.ts';

/** The exact shipped ZIP bytes define freshness; a cached archive needs no
 * network validation. Keep one stable CacheStorage entry per physical URL. */
export function dataArchivesPlugin(root: string): Plugin {
  let config: ResolvedConfig;
  let devAssets: Map<string, Buffer> | undefined;
  const name = "virtual:noitamap-data-archives",
    id = "\0" + name;
  const pagesName = 'virtual:noitamap-asset-pages', pagesId = '\0' + pagesName;
  const paths = Object.entries(archiveFiles).map(([key, file]) => [
    key,
    normalizePath(resolve(root, "public", file)),
  ]);
  const backgrounds = normalizePath(resolve(root, "public", "biome_bg"));
  return {
    name: "noitamap-data-archives",
    configResolved(value) { config = value; },
    buildStart() {
      // In dev, Vite treats load()'s watched paths as module dependencies.
      // A directory is not importable. Register it outside the module load
      // to retain new/deleted-image watching without creating a bogus import.
      this.addWatchFile(backgrounds);
    },
    resolveId(source) {
      if (source === name) return id;
      if (source === pagesName) return pagesId;
    },
    async load(source) {
      if (source === pagesId) {
        for (const [, path] of paths) this.addWatchFile(path);
        const prepared = await buildRuntimeAssets(root);
        if (config?.command === 'serve') devAssets = prepared.assets;
        return `export const assetManifests = ${JSON.stringify(prepared.manifests)};`;
      }
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
    async generateBundle() {
      // Deploy pages before migrating the runtime loader in a separate change.
      // Today's dev manifest does not trigger extraction or change startup.
      const { assets } = await buildRuntimeAssets(root);
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const prefix = `${config.base}game-assets/`;
        if (!pathname.startsWith(prefix)) return next();
        try {
          // Hash/extract during manifest preparation, not on every page GET.
          const assets = devAssets ??= (await buildRuntimeAssets(root)).assets;
          const file = `game-assets/${pathname.slice(prefix.length)}`;
          const bytes = assets.get(file);
          if (!bytes) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Content-Length', bytes.length);
          res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) { next(error); }
      });
    },
    hotUpdate({ file }) {
      file = normalizePath(file);
      const archiveChanged = paths.some(([, path]) => path === file);
      if (
        !archiveChanged &&
        !(dirname(file) === backgrounds && /\.png$/i.test(file))
      )
        return;
      if (archiveChanged) devAssets = undefined;
      const { moduleGraph, hot } = this.environment;
      const module = moduleGraph.getModuleById(id);
      if (module) moduleGraph.invalidateModule(module);
      if (archiveChanged) {
        const pages = moduleGraph.getModuleById(pagesId);
        if (pages) moduleGraph.invalidateModule(pages);
      }
      hot.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}
