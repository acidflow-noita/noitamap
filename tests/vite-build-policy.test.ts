import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, createLogger } from "vite";
import { browserTelescopeSource } from "../build_scripts/vite-telescope-browser";
import { partitionAtlas } from "../build_scripts/vite-atlas-chunks";

const root = resolve(import.meta.dirname, "..");

describe("browser build boundaries", () => {
  it.each(["noita-telescope", "noita-telescope-vm"])(
    "repairs the real scale scene cache key in %s without muting diagnostics",
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
      const key = new Function(
        "GENERATOR_CONFIG",
        "GENERAL_SCENE_NAMES",
        `return (${keyFunction});`,
      )({ scale: {}, coalmine: {} }, []);
      expect(key("scale", "scale")).toBe("general/scale");
      expect(key("scale", "scale_old")).toBe("general/scale_old");
      expect(key("coalmine", "scale")).toBe("coalmine/scale");
      expect(code).toContain("Pixel scene data not found for key");
    },
  );
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

  it("builds warning-free without eagerly importing telescope or the sprite atlas", async () => {
    const warnings: string[] = [];
    const logger = createLogger("warn");
    logger.warn = (message) => {
      warnings.push(message);
    };
    logger.warnOnce = (message) => {
      warnings.push(message);
    };
    const result: any = await build({
      configFile: resolve(root, "vite.config.ts"),
      customLogger: logger,
      build: {
        write: false,
        outDir: resolve(tmpdir(), "noitamap-build-policy-dry-run"),
      },
    });
    expect(warnings).toEqual([]);
    const output = result.output as any[];
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
    }
    expect(
      output.filter((file) => file.fileName.includes("sprite-atlas-part-"))
        .length,
    ).toBeGreaterThan(1);
  }, 120000);
});
