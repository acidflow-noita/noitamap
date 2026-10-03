import { transform } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import { hostTerrainShader, hostDecalDetail } from "./telescope-host-rendering.ts";

/** Telescope's runtime parser uses only the first two comma-separated fields.
 * Keep those exact fields (including its existing CSV quirks) for every row. */
export function compactTelescopeTranslations(csv: string): string {
  return csv
    .split("\n")
    .flatMap((line) => {
      const fields = line.split(",");
      return fields.length < 2 ? [] : [`${fields[0]},${fields[1]}`];
    })
    .join("\n");
}

/** Vite builds browser APIs, including the native baker's browser facade. Leave
 * the upstream Node entrypoints intact for tools importing them outside Vite. */
export async function browserTelescopeSource(
  code: string,
  id: string,
  assetTable?: string,
) {
  let source = code;
  if (id.endsWith('/gl/shaders.js')) source = hostTerrainShader(source);
  if (id.endsWith('/edge_decal_layer.js')) source = hostDecalDetail(source);
  if (id.endsWith("/png_sanitizer.js") && source.includes("const IS_NODE =")) {
    // Inline this private environment flag before Vite resolves imports, so
    // unreachable fs/url imports never become browser-external stubs.
    source = source
      .replace(/^const IS_NODE = [^\n]+;\r?$/m, "")
      .replace(/\bIS_NODE\b/g, "false");
  }
  if (id.endsWith("/pixel_scene_generation.js")) {
    source = source.replace(
      "PIXEL_SCENE_META_URL.protocol === 'file:'",
      "false",
    );
    const atlasImport = /import\(['"]\.\/gl\/material_atlas\.js['"]\)/g;
    if (atlasImport.test(source)) {
      // This import MUST stay dynamic. utils -> pixel_scene_generation ->
      // material_atlas -> potion_config otherwise forms a static cycle, and
      // the atlas iterates MATERIAL_DATA before its top-level await completes.
      // A separate lazy entry preserves that boundary even when other callers
      // already import the underlying atlas statically.
      const entry = resolve(
        import.meta.dirname,
        "../src/telescope/material-atlas-entry.ts",
      );
      source = source.replace(atlasImport, `import(${JSON.stringify(entry)})`);
    }
  }
  if (id.endsWith("/icon_sheets.js")) {
    // Explicit assets keep Vite from expanding the upstream dynamic URL into
    // a glob over the entire Telescope checkout.
    const sheetUrl =
      /(?:assetUrl\(new URL\(`\.\.\/\$\{sheet\.url\}`, import\.meta\.url\)\)|new URL\(`\.\.\/\$\{sheet\.url\}`, import\.meta\.url\)\.href)/g;
    if (source.match(sheetUrl)?.length !== 1)
      throw new Error(`Unknown telescope sprite sheet URL in ${id}`);
    const perk = resolve(dirname(id), "../data/perk_sprites.sheet.png");
    const spell = resolve(dirname(id), "../data/spell_sprites.sheet.png");
    source =
      `import __perkSheet from ${JSON.stringify(perk + "?url")};\n` +
      `import __spellSheet from ${JSON.stringify(spell + "?url")};\n` +
      source.replace(
        sheetUrl,
        "({ perk_sprites: __perkSheet, spell_sprites: __spellSheet })[folder]",
      );
  }
  if (id.endsWith("/asset_url.js") && assetTable) {
    const anchor = "const href = new URL(url, root).href;";
    if (!source.includes(anchor))
      throw new Error(`Unknown telescope asset resolver in ${id}`);
    // Keep literals INSIDE the hoisted function. An imported table's top-level
    // initializer may not have run when the cyclic graph first fetches JSON.
    source = source.replace(
      anchor,
      anchor +
        `\nconst packaged = (${assetTable})[href.match(/(?:^|\\/)data\\/([^?#]+)(?:[?#].*)?$/)?.[1]]; if (packaged) return { href: packaged, gzip: null };`,
    );
  }
  if (id.endsWith("/prespawn.js")) {
    const original =
      "new Worker(assetUrl(new URL(k.file, import.meta.url)), { type: 'module', name: k.name(index) })";
    if (!source.includes(original))
      throw new Error(`Unknown telescope worker factory in ${id}`);
    source = source.replace(
      original,
      `(kind === 'terrain'
      ? new Worker(new URL('./terrain_worker.js', import.meta.url), { type: 'module', name: k.name(index) })
      : new Worker(new URL('./overlay_worker.js', import.meta.url), { type: 'module', name: k.name(index) }))`,
    );
  } else {
    // Vite must see the literal constructor to bundle each worker's imports.
    source = source.replace(
      /new Worker\(assetUrl\((new URL\(['"][^'"]+_worker\.js['"], import\.meta\.url\))\),/g,
      "new Worker($1,",
    );
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
  // Directory bases are runtime URL arithmetic, not files for Vite to emit.
  const output = result.code.replace(
    /new URL\((['"]\.\.\/(?:data\/)?['"]), import\.meta\.url\)/g,
    "new URL(/* @vite-ignore */ $1, import.meta.url)",
  );
  return { code: output, map: result.map };
}

export function telescopeBrowserPlugin(directories: string[]): Plugin {
  let production = false;
  const files = new Set(
    directories.flatMap((dir) =>
      [
        "png_sanitizer.js",
        "utils.js",
        "pixel_scene_generation.js",
        "translations.js",
        "icon_sheets.js",
        "asset_pack.js",
        "asset_url.js",
        "prespawn.js",
        "world_scan_pool.js",
        "bitmap_loader.js",
        "overlay_manager.js",
        "search_manager.js",
        "gl/shaders.js",
        "edge_decal_layer.js",
      ].map((name) => resolve(dir, name).replace(/\\/g, "/")),
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
      if (production && id.endsWith("/translations.js")) {
        const path = resolve(dirname(id), "../data/translations.csv");
        const original =
          /new URL\(['"]\.\.\/data\/translations\.csv['"],\s*import\.meta\.url\)/g;
        if (!original.test(code))
          throw new Error(`Unknown telescope translation URL in ${id}`);
        this.addWatchFile(path);
        const reference = this.emitFile({
          type: "asset",
          name: "translations-en.csv",
          source: compactTelescopeTranslations(await readFile(path, "utf8")),
        });
        code = code.replace(
          original,
          `new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url)`,
        );
      }
      let assetTable: string | undefined;
      if (id.endsWith("/asset_url.js")) {
        const entries = await Promise.all(
          [
            "packs/terrain.pack",
            "packs/pixel_scenes.pack",
            "packs/backgrounds.pack",
            "packs/biome_maps.pack",
            "pixel_scene_meta.json",
            "sprite_distributions/wand_sprite_rates.json",
            "material_atlas.bin",
            "material_atlas.json",
            "edge_atlas.bin",
            "biome_flags.json",
            "material_data.json",
          ].map(async (file) => {
            const path = resolve(dirname(id), "../data", file);
            this.addWatchFile(path);
            const value = production
              ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: "asset", name: file.split("/").pop(), source: await readFile(path) })}`
              : JSON.stringify("/@fs/" + path.replace(/\\/g, "/"));
            return `${JSON.stringify(file)}: ${value}`;
          }),
        );
        assetTable = `{${entries.join(",")}}`;
      }
      return browserTelescopeSource(code, id, assetTable);
    },
  };
}
