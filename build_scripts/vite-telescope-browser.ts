import { transform } from "esbuild";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  if (id.endsWith('/tile_generator.js')) {
    // Preserve the pinned algorithms and their ordering. Only the host's
    // serialized main-thread generator opts into cooperative scheduling.
    const pattern = /export async function generateBiomeTiles\([\s\S]*?\n\}/;
    const original = source.match(pattern)?.[0];
    const audited = new Set([
      'b1e3f2999d60ab9a7c6f7aeb9e9168db1d05daee67e443380e8ffe0327c67040',
      'f7e4e9ad9c7727faa0b0de1f4d89cd7c956cece22e8bfacf15abd23fd392b9ef',
    ]);
    if (!original || !audited.has(createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex')))
      throw new Error(`Review changed Telescope tile generation scheduling: ${id}`);
    const checkpoint = '\n            const resume = yieldControl?.(); if (resume) await resume;';
    const scheduled = original
      .replace("gameMode = 'normal') {", "gameMode = 'normal', yieldControl = null) {")
      .replace('for (let biomeName of Object.keys(biomeConfig)) {', '$&' + checkpoint)
      .replace('for (let i = 0; i < regions.length; i++) {', '$&' + checkpoint)
      .replace('while (!valid && attempts < MAX_PATHFINDING_ATTEMPTS) {', '$&' + checkpoint);
    source = source.replace(original, scheduled);
  }
  if (id.endsWith('/poi_scanner.js')) {
    const pattern = /export function prescanSpawnFunctions\([\s\S]*?\n\}/;
    const original = source.match(pattern)?.[0];
    const audited = new Set([
      '568295f063fe77bf4198fc7f323dae561bda5ad4ad62fdec08de601c70d11545',
      '259cdf984e7e1c1ac53dcc628b32640c231215be24d06e012a7431182b52fbf2',
    ]);
    if (!original || !audited.has(createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex')))
      throw new Error(`Review changed Telescope spawn prescan: ${id}`);
    // The replacement also depends on the lookup's first-match semantics.
    // Audit that dependency rather than silently bypassing a future change.
    const lookupSource = await readFile(resolve(dirname(id), 'spawn_functions.js'), 'utf8');
    const lookup = lookupSource.match(/export function getSpawnFunctionIndex\([\s\S]*?\n\}/)?.[0];
    if (!lookup || createHash('sha256').update(lookup.replace(/\r\n/g, '\n')).digest('hex') !==
      'd7a397fb8046fcfb1c226ea2d35a804c752d01fd5e6d9393cfb2d4420d5a6b7e')
      throw new Error(`Review changed Telescope spawn-function lookup: ${id}`);
    // Build once per layer, not once per opaque pixel. No persistent memo:
    // later seeds/settings must see the current table, including inactive and
    // duplicate entries (the first occurrence always wins).
    const indexed = original
      .replace('if (sourceSpawnFunctions.length === 0) continue;', `$&
        const indexByColor = new Map();
        for (let i = 0; i < sourceSpawnFunctions.length; i++) {
            const color = sourceSpawnFunctions[i].color;
            if (!indexByColor.has(color)) indexByColor.set(color, i);
        }`)
      .replace('const index = getSpawnFunctionIndex(sourceBiome, colorInt);',
        'const index = indexByColor.get(colorInt) ?? null;');
    source = source.replace(original, indexed);
  }
  if (id.endsWith("/engine_resolve/lattice_builder.js")) {
    // Keep the submodule intact. Audit again if upstream changes the vote's
    // semantics; applying an old replacement to a new implementation is unsafe.
    const pattern = /function neighbourMajority\(cov, mat, w, h\) \{[\s\S]*?\n\}/;
    const original = source.match(pattern)?.[0];
    if (!original || createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex') !==
        'f1b5b558c4c78a4b6860c90fcec946677f2995c9ff5f60c3226959c509555d7a')
      throw new Error(`Review changed Telescope lattice neighbour vote: ${id}`);
    replaceExpected(pattern, 'function neighbourMajority(cov, mat, w, h) { applyTerrainLatticeMajority(cov, mat, w, h); }',
      'lattice neighbour vote');
    const helper = resolve(import.meta.dirname, '../src/telescope/terrain-lattice-majority.ts');
    source = `import { applyTerrainLatticeMajority } from ${JSON.stringify(helper)};\n` + source;
    return { code: source, map: null };
  }
  if (id.endsWith("/gl/terrain_renderer.js")) {
    // Partial viewport draws retain the parent's camera/pixel origin. Merely
    // moving camX/camY changes float rounding at cell and texture boundaries.
    replaceExpected(/camX - \(width \/ 2\) \/ camZ/,
      'camX - ((view.sampleWidth ?? width) / 2) / camZ', 'cropped terrain camera X');
    replaceExpected(/camY - \(height \/ 2\) \/ camZ/,
      'camY - ((view.sampleHeight ?? height) / 2) / camZ', 'cropped terrain camera Y');
    replaceExpected(/gl\.uniform2i\(u\.u_vpOrigin, 0, 0\);\n        gl\.uniform1i\(u\.u_materialIdOut, 0\);/,
      'gl.uniform2i(u.u_vpOrigin, -(view.sampleOffsetX ?? 0), view.sampleOffsetY ?? 0);\n        gl.uniform1i(u.u_materialIdOut, 0);', 'cropped terrain pixel origin');
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
    if (/import\(['"]\.\/gl\/material_atlas\.js['"]\)/.test(source)) {
      // This import MUST stay dynamic. utils -> pixel_scene_generation ->
      // material_atlas -> potion_config otherwise forms a static cycle, and
      // the atlas iterates MATERIAL_DATA before its top-level await completes.
      // Load the atlas and band selector through one feature entry. Their
      // underlying modules are also static dependencies of terrain rendering;
      // separate dynamic imports cannot split them into independent chunks.
      const entry = resolve(
        import.meta.dirname,
        "../src/telescope/scene-texture-entry.ts",
      );
      replaceExpected(
        /const \[atlas, bands\] = await Promise\.all\(\[\s*import\(['"]\.\/gl\/material_atlas\.js['"]\),\s*import\(['"]\.\/engine_resolve\/band_select\.js['"]\),?\s*\]\);/,
        `const { atlas, bands } = await import(${JSON.stringify(entry)});`,
        "scene texture imports",
      );
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
      ["png_sanitizer.js", "utils.js", "pixel_scene_generation.js", "icon_sheets.js", "tile_generator.js", "poi_scanner.js", "gl/terrain_renderer.js", "engine_resolve/lattice_builder.js"].map(
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
