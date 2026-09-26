import { transform } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** Telescope's runtime parser uses only the first two comma-separated fields.
 * Keep those exact fields (including its existing CSV quirks) for every row. */
export function compactTelescopeTranslations(csv: string): string {
  return csv.split('\n').flatMap(line => {
    const fields = line.split(',');
    return fields.length < 2 ? [] : [`${fields[0]},${fields[1]}`];
  }).join('\n');
}

/** Vite builds browser APIs, including the native baker's browser facade. Leave
 * the upstream Node entrypoints intact for tools importing them outside Vite. */
export async function browserTelescopeSource(code: string, id: string) {
  let source = code;
  if (id.endsWith("/png_sanitizer.js") && source.includes("const IS_NODE =")) {
    // Inline this private environment flag before Vite resolves imports, so
    // unreachable fs/url imports never become browser-external stubs.
    source = source
      .replace(/^const IS_NODE = [^\n]+;\r?$/m, "")
      .replace(/\bIS_NODE\b/g, "false");
  }
  if (id.endsWith("/pixel_scene_generation.js")) {
    const atlasImport = /import\(['"]\.\/gl\/material_atlas\.js['"]\)/g;
    if (atlasImport.test(source)) {
      // This import MUST stay dynamic. utils -> pixel_scene_generation ->
      // material_atlas -> potion_config otherwise forms a static cycle, and
      // the atlas iterates MATERIAL_DATA before its top-level await completes.
      // A separate lazy entry preserves that boundary even when other callers
      // already import the underlying atlas statically.
      const entry = resolve(import.meta.dirname, "../src/telescope/material-atlas-entry.ts");
      source = source.replace(atlasImport, `import(${JSON.stringify(entry)})`);
    }
  }
  const result = await transform(source, {
    sourcefile: id,
    format: "esm",
    define: { process: "undefined" },
    treeShaking: true,
    minifySyntax: true,
    sourcemap: true,
  });
  if (/import\s*\(['"]node:/.test(result.code)) {
    throw new Error(
      `Unpruned Node-only import in telescope browser module: ${id}`,
    );
  }
  return { code: result.code, map: result.map };
}

export function telescopeBrowserPlugin(directories: string[]): Plugin {
  let production = false;
  const files = new Set(
    directories.flatMap((dir) =>
      ["png_sanitizer.js", "utils.js", "pixel_scene_generation.js", "translations.js"].map(
        (name) => resolve(dir, name).replace(/\\/g, "/"),
      ),
    ),
  );
  return {
    name: "telescope-browser-entrypoints",
    enforce: "pre",
    configResolved(config) {
      production = config.command === "build";
    },
    async transform(code, id) {
      if (!files.has(id)) return null;
      if (production && id.endsWith('/translations.js')) {
        const path = resolve(dirname(id), '../data/translations.csv');
        const original = /new URL\(['"]\.\.\/data\/translations\.csv['"],\s*import\.meta\.url\)/g;
        if (!original.test(code)) throw new Error(`Unknown telescope translation URL in ${id}`);
        this.addWatchFile(path);
        const reference = this.emitFile({
          type: 'asset',
          name: 'translations-en.csv',
          source: compactTelescopeTranslations(await readFile(path, 'utf8')),
        });
        code = code.replace(original, `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`);
      }
      return browserTelescopeSource(code, id);
    },
  };
}
