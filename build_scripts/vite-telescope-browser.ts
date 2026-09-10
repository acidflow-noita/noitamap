import { transform } from "esbuild";
import { resolve } from "node:path";
import type { Plugin } from "vite";

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
    // The legacy fork preloads these under "general" (via OVERWORLD_SCENES),
    // but static_spawns requests biome "scale". Use the loaded cache key;
    // do not suppress its missing-scene warning or synthesize an empty scene.
    const sceneKey = "function getPixelSceneKey(biomeName, sceneName) {";
    if (!source.includes(sceneKey))
      throw new Error(`Unknown telescope scene-key implementation: ${id}`);
    source = source.replace(
      sceneKey,
      `${sceneKey}\nif (biomeName === "scale" && (sceneName === "scale" || sceneName === "scale_old")) return "general/" + sceneName;`,
    );
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
