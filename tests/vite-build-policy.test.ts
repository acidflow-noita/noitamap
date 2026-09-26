import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, createLogger } from "vite";
import { browserTelescopeSource } from "../build_scripts/vite-telescope-browser";
import { partitionAtlas } from "../build_scripts/vite-atlas-chunks";

const root = resolve(import.meta.dirname, "..");

afterEach(() => vi.unstubAllEnvs());

describe("browser build boundaries", () => {
  it("preserves asynchronous atlas initialization instead of adding a static dependency cycle", async () => {
    const path = resolve(
      root,
      "lib/noita-telescope-vm/js/pixel_scene_generation.js",
    );
    const { code } = await browserTelescopeSource(
      await readFile(path, "utf8"),
      path,
    );
    expect(code).toMatch(/import\([^)]*material-atlas-entry\.ts/);
    expect(code).not.toContain("__noitamapAtlas");
    expect(code).not.toMatch(/import[^;]*from\s*["'][^"']*material_atlas/);
  });
  it.each(["noita-telescope", "noita-telescope-vm"])(
    "keeps the upstream general-scene lookup in %s without rewriting its private function",
    async (fork) => {
      const path = resolve(root, `lib/${fork}/js/pixel_scene_generation.js`);
      const original = await readFile(path, "utf8");
      const { code } = await browserTelescopeSource(original, path);
      const keyFunction = code.match(
        /function getPixelSceneKey\([\s\S]*?\n\}/,
      )?.[0];
      expect(keyFunction).toBeTruthy();
      // Execute only the actual transformed pure key function; no mocked scene
      // image can make a missing cache lookup appear to succeed.
      const config = await readFile(resolve(root, `lib/${fork}/js/pixel_scene_config.js`), "utf8");
      const general = config.match(/export const GENERAL_SCENES\s*=\s*({[\s\S]*?})\s*;?\s*export const OVERWORLD_SCENES/)?.[1];
      expect(general).toBeTruthy();
      const names = new Function(`return (${general}).extras.map(scene => scene.name);`)();
      expect(names).toEqual(expect.arrayContaining(["scale", "scale_old"]));
      const key = new Function(
        "GENERATOR_CONFIG",
        "GENERAL_SCENE_NAMES",
        `return (${keyFunction});`,
      )({ scale: {}, coalmine: {} }, names);
      expect(key("scale", "scale")).toBe("general/scale");
      expect(key("scale", "scale_old")).toBe("general/scale_old");
      expect(key("coalmine", "scale")).toBe("general/scale");
      expect(key("coalmine", "ordinary_scene")).toBe("coalmine/ordinary_scene");
      expect(code).toContain("Pixel scene data not found for key");
    },
  );
  it("does not fail when an upstream private scene-key helper is renamed", async () => {
    const result = await browserTelescopeSource("export const value = 1;", "/fork/pixel_scene_generation.js");
    expect(result.code).toContain("value");
  });
  it.each(["png_sanitizer.js", "utils.js"])(
    "removes Node-only imports from %s without suppressing warnings",
    async (file) => {
      const path = resolve(root, "lib/noita-telescope-vm/js", file);
      const original = await readFile(path, "utf8");
      expect(original).toContain("node:fs/promises");
      const result = await browserTelescopeSource(original, path);
      expect(result.code).not.toMatch(/node:(fs|url)|readPngBufferNode/);
      expect(result.code).toContain(
        file === "utils.js" ? "fetch(" : "createImageBitmap(",
      );
      expect(await readFile(path, "utf8")).toBe(original);
    },
  );

  it("preserves every atlas entry and animation field in bounded lazy chunks", async () => {
    const atlas = JSON.parse(
      await readFile(resolve(root, "src/data/atlas.json"), "utf8"),
    );
    const parts = partitionAtlas(atlas);
    expect(parts.length).toBeGreaterThan(1);
    expect(Object.assign({}, ...parts)).toEqual(atlas);
    for (const part of parts)
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(180_000);
    expect(
      partitionAtlas(Object.fromEntries(Object.entries(atlas).reverse())),
    ).toEqual(parts);
  });

  it("builds without bundle warnings or eager telescope/sprite-atlas imports", async () => {
    // Vitest sets NODE_ENV=test, which makes Vite's DEV flag true even with
    // mode=production. Exercise the actual npm run build environment instead.
    vi.stubEnv("NODE_ENV", "production");
    const warnings: string[] = [];
    const logger = createLogger("warn");
    const recordWarning = (message: string) => {
      // Vite 8.2 adds hardware/load-dependent plugin timing diagnostics.
      // Those are not bundle/import warnings; keep every actual warning fatal.
      if (!message.includes("[PLUGIN_TIMINGS]")) warnings.push(message);
    };
    logger.warn = recordWarning;
    logger.warnOnce = recordWarning;
    const result: any = await build({
      configFile: resolve(root, "vite.config.ts"),
      customLogger: logger,
      plugins: [{
        name: "assert-production-test-build",
        configResolved(config) {
          expect(config.isProduction).toBe(true);
          expect(config.env.DEV).toBe(false);
        },
      }],
      build: {
        write: false,
        outDir: resolve(tmpdir(), "noitamap-build-policy-dry-run"),
      },
    });
    expect(warnings).toEqual([]);
    const output = result.output as any[];
    const html = String(output.find(file => file.fileName === 'index.html')?.source);
    // The entry accesses OSD while evaluating imports. Its deferred global
    // must stay earlier in the document's deferred execution order.
    expect(html.indexOf('openseadragon.min.js')).toBeGreaterThan(-1);
    expect(html.indexOf('openseadragon.min.js')).toBeLessThan(html.indexOf('type="module"'));
    expect(html).toMatch(/<script\s+defer\s+src="[^\"]*openseadragon/);
    const localStyles = [...html.matchAll(/<link\b[^>]*>/g)]
      .map(match => match[0]).filter(tag => tag.includes('rel="stylesheet"') && tag.includes('href="/build/'));
    expect(localStyles).toHaveLength(1);
    expect(html).not.toMatch(/href="(?:\/?css\/|\/src\/styles\/)/);
    // Even when a private checkout exists locally, public production builds
    // must load hosted Pro on demand, never bundle the local private entry.
    for (const file of output.filter((file) => file.type === "chunk")) {
      expect(Object.keys(file.modules).some((id) => id.includes("/noitamap-pro/")), file.fileName).toBe(false);
    }
    for (const file of output) {
      if (file.fileName.endsWith(".js")) {
        const code = file.type === "chunk" ? file.code : file.source;
        expect(Buffer.byteLength(code), file.fileName).toBeLessThan(500_000);
      }
    }
    const chunks = new Map(
      output
        .filter((file) => file.type === "chunk")
        .map((file) => [file.fileName, file]),
    );
    const entry = output.find(
      (file) =>
        file.type === "chunk" &&
        file.isEntry &&
        file.facadeModuleId?.endsWith("index.html"),
    );
    expect(entry).toBeTruthy();
    const eager = new Set<string>();
    const visit = (name: string) => {
      if (eager.has(name)) return;
      eager.add(name);
      for (const dependency of chunks.get(name)?.imports ?? [])
        visit(dependency);
    };
    visit(entry.fileName);
    for (const name of eager) {
      const modules = Object.keys(chunks.get(name)?.modules ?? {});
      expect(
        modules.some((id) => /\/lib\/noita-telescope[^/]*\/js\//.test(id)),
        name,
      ).toBe(false);
      expect(
        modules.some((id) => id.includes("noitamap-sprite-atlas")),
        name,
      ).toBe(false);
      expect(
        modules.some(id => /\/node_modules\/(?:fast-png|jszip|pako)\//.test(id)
          || /\/src\/(?:dev\/console|telescope\/(?:png-decode|bake-export|gl-terrain-tile-source))\.ts$/.test(id)),
        name,
      ).toBe(false);
    }
    const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="\/([^\"]+)"[^>]*>/g)]
      .map(match => match[1]);
    expect(preloads.length).toBeGreaterThan(0);
    for (const name of preloads) expect(eager.has(name), name).toBe(true);
    expect(
      output.filter((file) => file.fileName.includes("sprite-atlas-part-"))
        .length,
    ).toBeGreaterThan(1);
  }, 120000);
});
