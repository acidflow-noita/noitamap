import { it, expect } from "vitest";
import { build } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

it("matches direct upstream generation through the emitted persistent worker pool", async () => {
  const root = resolve(import.meta.dirname, "..");
  const bundle = await mkdtemp(
    resolve(tmpdir(), "noitamap-generation-interface-"),
  );
  let worker: Worker | undefined;
  try {
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      build: {
        outDir: bundle,
        rollupOptions: {
          input: resolve(root, "tests/helpers/terrain-generation-interface.ts"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "generation.js",
            manualChunks: () => undefined,
          },
        },
      },
    });
    const result: any = await new Promise((resolveResult, reject) => {
      worker = new Worker(
        resolve(root, "tests/helpers/terrain-generation-interface.mjs"),
        {
          workerData: { root, bundle, entry: resolve(bundle, "generation.js") },
        },
      );
      worker.on("message", resolveResult);
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code) reject(new Error(`Generation harness exited ${code}`));
      });
    });
    expect(result.error).toBeUndefined();
    expect(result.backgrounds).toContain("data/pixel_scenes/spliced/moon_background.png");
    expect(result.backgrounds.length).toBeGreaterThan(30);
    expect(result.superseded).toBe(true);
    expect(result.latestMatches).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.host.biome).toBe(result.results[0].actual.biome);
    expect(result.host.layers).toBeGreaterThan(20);
    expect(result.host.pois).toBeGreaterThan(100);
    expect(result.host.scenes).toBeGreaterThan(100);
    expect(result.host.elevator).toBeGreaterThan(0);
    for (const { seed, ms, actual, expected } of result.results) {
      expect(actual, `seed ${seed}`).toEqual(expected);
      expect(actual.layers.length).toBeGreaterThan(20);
      console.log(
        `[Terrain interface] seed ${seed}: ${Math.round(ms)}ms; biome, layer bytes and spawns match direct generation`,
      );
    }
  } finally {
    await worker?.terminate();
    await rm(bundle, { recursive: true, force: true });
  }
}, 90000);
