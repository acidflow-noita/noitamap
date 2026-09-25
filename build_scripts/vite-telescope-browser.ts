import { transform } from "esbuild";
import { resolve } from "node:path";
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
        `Telescope PNG startup boundary changed (${boundary}): ${id}; expected one match, found ${matches?.length ?? 0}`,
      );
    source = source.replace(pattern, replacement);
  };
  if (id.endsWith("/png_sanitizer.js") && source.includes("const IS_NODE =")) {
    // The seed generator consumes RGBA bytes; eagerly decoding a second copy
    // into an ImageBitmap for every scene/template only to discard it delays
    // startup. Keep upstream's bitmap default for its actual bitmap consumers.
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
    // Inline this private environment flag before Vite resolves imports, so
    // unreachable fs/url imports never become browser-external stubs.
    source = source
      .replace(/^const IS_NODE = [^\n]+;\r?$/m, "")
      .replace(/\bIS_NODE\b/g, "false");
  }
  if (id.endsWith("/pixel_scene_generation.js")) {
    if (source.includes("export async function loadPixelSceneData"))
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
      ["png_sanitizer.js", "utils.js", "pixel_scene_generation.js"].map(
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
