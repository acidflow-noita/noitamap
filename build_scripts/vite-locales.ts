import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const PUBLIC_ID = "virtual:noitamap-locales";
const RESOLVED_ID = "\0noitamap-locales";

/** Emit complete, compact dictionaries with content hashes. Only the active
 * language and its fallback are requested; source dictionaries stay readable. */
export function localeAssetsPlugin(root: string) {
  const directory = resolve(root, "src/locales");
  let production = false;
  let base = "/";
  return {
    name: "locale-assets",
    configResolved(this: void, config: { command: 'build' | 'serve'; base: string }) {
      production = config.command === "build";
      base = config.base;
    },
    resolveId(this: void, id: string) {
      if (id === PUBLIC_ID) return RESOLVED_ID;
    },
    load(this: {
      addWatchFile(path: string): void;
      emitFile(asset: { type: 'asset'; name: string; source: string }): string;
    }, id: string) {
      if (id !== RESOLVED_ID) return null;
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const urls = entries.map(({ name: language }) => {
        const path = resolve(directory, language, "translation.json");
        this.addWatchFile(path);
        if (!production) {
          // Vite serves a plain JSON request directly from its source file.
          return `${JSON.stringify(language)}:${JSON.stringify(`${base}src/locales/${language}/translation.json`)}`;
        }
        const reference = this.emitFile({
          type: "asset",
          name: `locale-${language}.json`,
          source: JSON.stringify(JSON.parse(readFileSync(path, "utf8"))),
        });
        return `${JSON.stringify(language)}:import.meta.ROLLUP_FILE_URL_${reference}`;
      });
      return `export default {${urls.join(",")}};`;
    },
  } satisfies Plugin;
}
