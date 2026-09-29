import { transform } from "esbuild";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** Vite builds browser APIs, including the native baker's browser facade. Leave
 * the upstream Node entrypoints intact for tools importing them outside Vite. */
export async function browserTelescopeSource(code: string, id: string) {
  let source = code;
  const replaceExpected = (
    pattern: RegExp,
    replacement: string,
    boundary: string,
  ) => {
    const matches = source.match(new RegExp(pattern.source, "g"));
    if (matches?.length !== 1)
      throw new Error(
        `Telescope browser boundary changed (${boundary}): ${id}; expected one match, found ${matches?.length ?? 0}`,
      );
    source = source.replace(pattern, replacement);
  };
  if (id.endsWith("/gl/terrain_renderer.js")) {
    // This host replaces Telescope's app and never enables its standalone HUD.
    // Upstream's permanent poller captures each renderer, retaining contexts
    // and lattices after our seed lifecycle releases them. Keep host metrics
    // and renderer lifetime independent of that unused global subscription.
    replaceExpected(
      /renderHud\.addPoller\(\(\) => this\.pollGpuTimers\(\)\);/,
      "",
      "standalone terrain HUD subscription",
    );
  }
  if (id.endsWith("/png_sanitizer.js") && source.includes("const IS_NODE =")) {
    // The seed generator consumes RGBA bytes; eagerly decoding a second copy
    // into an ImageBitmap for every scene/template only to discard it delays
    // startup. Keep upstream's bitmap default for its actual bitmap consumers.
    if (!source.includes("bitmap: wantBitmap")) {
      replaceExpected(
      /export async function loadPNG\(url\) \{/,
      "export async function loadPNG(url, options = {}) {",
      "loadPNG declaration",
    );
    replaceExpected(
      /if \(!IS_NODE\) \{(\s*const blob = new Blob\(\[sanitizedUint8\])/,
      "if (!IS_NODE && options.bitmap !== false) {$1",
      "optional bitmap decode",
    );
    }
    // Inline this private environment flag before Vite resolves imports, so
    // unreachable fs/url imports never become browser-external stubs.
    source = source
      .replace(/^const IS_NODE = [^\n]+;\r?$/m, "")
      .replace(/\bIS_NODE\b/g, "false");
    const atlas = resolve(import.meta.dirname, '../src/telescope/scene-source-atlas.ts');
    const wantBitmap = source.includes('bitmap: wantBitmap') ? 'wantBitmap' : 'options.bitmap !== false';
    replaceExpected(
      /export async function loadPNG\(url,[^\n]+\) \{/,
      `$&\n    const atlas = await readTelescopeAtlasPNG(url, ${wantBitmap});\n    if (atlas) return atlas;`,
      'source scene atlas loader',
    );
    source = `import { readTelescopeAtlasPNG } from ${JSON.stringify(atlas)};\n` + source;
  }
  if (id.endsWith("/pixel_scene_generation.js")) {
    source = source.replace(
      /PIXEL_SCENE_META_URL\.protocol === ['"]file:['"]/g,
      "false",
    );
    if (source.includes("export async function loadPixelSceneData") &&
        !source.includes("export function ensureScenePixels"))
      replaceExpected(
        /import \{ loadPNG \} from (['"]\.\/png_sanitizer\.js['"]);/,
        "import { loadPNG as loadPNGWithBitmap } from $1;\nconst loadPNG = url => loadPNGWithBitmap(url, { bitmap: false });",
        "scene PNG import",
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
    // Vite cannot resolve upstream's table-driven URL at build time. Literal
    // imports ensure the sprite sheets ship with the tooltip module.
    source = ["perk", "spell"].map((name) =>
      `import __${name}Sheet from ${JSON.stringify(resolve(dirname(id), `../data/${name}_sprites.sheet.png`) + "?url")};`,
    ).join("\n") + "\n" + source.replace(
      'new URL(`../${sheet.url}`, import.meta.url).href',
      '({ perk_sprites: __perkSheet, spell_sprites: __spellSheet })[folder]',
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
  return { code: result.code, map: result.map };
}

export function telescopeBrowserPlugin(directories: string[]): Plugin {
  const files = new Set(
    directories.flatMap((dir) =>
      ["png_sanitizer.js", "utils.js", "pixel_scene_generation.js", "icon_sheets.js", "gl/terrain_renderer.js"].map(
        (name) => resolve(dir, name).replace(/\\/g, "/"),
      ),
    ),
  );
  return {
    name: "telescope-browser-entrypoints",
    enforce: "pre",
    transform(code, id) {
      if (!files.has(id)) return null;
      return browserTelescopeSource(code, id);
    },
  };
}
