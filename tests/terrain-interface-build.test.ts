import { describe, expect, it } from "vitest";
import { build } from "vite";
import { resolve, posix } from "node:path";
import { readFile } from "node:fs/promises";
import {
  browserTelescopeSource,
  telescopeBrowserPlugin,
} from "../build_scripts/vite-telescope-browser";

const root = resolve(import.meta.dirname, "..");
const fork = resolve(root, "lib/noita-telescope-vm/js");

describe("Telescope host interface in Vite", () => {
  it("rewrites current sprite sheet URLs and rejects unrecognized upstream syntax", async () => {
    const file = resolve(fork, "icon_sheets.js");
    const original = await readFile(file, "utf8");
    const { code } = await browserTelescopeSource(original, file);
    expect(code).toContain("perk_sprites.sheet.png?url");
    expect(code).not.toContain("${sheet.url}");
    await expect(
      browserTelescopeSource("export const changed = true;", file),
    ).rejects.toThrow("Unknown telescope sprite sheet URL");
  });

  it("bundles the app-free interface, worker imports, and versioned packs", async () => {
    const entry = "\0terrain-interface-check";
    const seen = new Set<string>();
    const result: any = await build({
      configFile: false,
      resolve: { alias: { "noita-telescope-full-pixels": fork } },
      logLevel: "error",
      plugins: [
        telescopeBrowserPlugin([fork]),
        {
          name: "terrain-interface-check",
          resolveId(id) {
            if (id === entry) return entry;
          },
          load(id) {
            if (id !== entry) return;
            return [
              "terrain_view",
              "terrain_world",
              "terrain_workers",
              "world_scan_pool",
              "overlay_worker_pool",
              "bitmap_loader",
            ]
              .map(
                (name) =>
                  `export * from ${JSON.stringify(resolve(fork, name + ".js"))};`,
              )
              .join("\n");
          },
          transform(_code, id) {
            seen.add(id);
          },
        },
      ],
      worker: { format: "es", plugins: () => [telescopeBrowserPlugin([fork])] },
      build: {
        write: false,
        assetsInlineLimit: 0,
        rollupOptions: { input: entry, preserveEntrySignatures: "strict" },
      },
    });
    expect([...seen].filter((id) => id.endsWith("/app.js"))).toEqual([]);
    const output: any[] = result.output;
    for (const worker of [
      "terrain_worker",
      "overlay_worker",
      "world_worker",
      "bitmap_loader_worker",
    ]) {
      const asset = output.find((file) =>
        new RegExp(`/${worker}-.*\\.js$`).test(file.fileName),
      );
      expect(asset, worker).toBeTruthy();
      for (const match of String(asset.source).matchAll(
        /(?:from\s*|import\s*\()(['"`])(\.\/[^'"`]+)\1/g,
      )) {
        const dependency = posix.join(posix.dirname(asset.fileName), match[2]);
        expect(
          output.some((file) => file.fileName === dependency),
          dependency,
        ).toBe(true);
      }
    }
    for (const pack of [
      "terrain",
      "pixel_scenes",
      "backgrounds",
      "biome_maps",
    ]) {
      expect(
        output.some((file) =>
          new RegExp(`/${pack}-.*\\.pack$`).test(file.fileName),
        ),
        pack,
      ).toBe(true);
    }
  }, 30000);
});
