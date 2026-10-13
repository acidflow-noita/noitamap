import { it, expect } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { standaloneTerrainShaders } from "../build_scripts/vite-terrain-shaders";

it.skipIf(process.platform !== "linux")(
  "preserves terrain color and material bytes after reducing shader call duplication",
  async () => {
    const root = resolve(import.meta.dirname, "..");
    const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-shader-parity-"));
    const variants: any[] = [false, true].map((optimize) => {
      const source = standaloneTerrainShaders(
        resolve(root, "lib/noita-telescope-vm/js"),
        undefined,
        { optimize },
      );
      const shaders = new Function(
        source.replace(/export (?=const |function )/g, "") +
          "\nreturn { TERRAIN_FS, TERRAIN_VS };",
      )();
      return { name: optimize ? "optimized" : "reference", ...shaders };
    });
    variants.push({ name: 'native' });
    try {
      await build({
        configFile: resolve(root, "vite.config.ts"),
        logLevel: "error",
        publicDir: false,
        build: {
          outDir: bundle,
          rollupOptions: {
            input: resolve(
              root,
              "tests/helpers/terrain-shader-parity-fixture.ts",
            ),
            preserveEntrySignatures: "strict",
            output: {
              entryFileNames: "fixture.js",
              manualChunks: () => undefined,
            },
          },
        },
      });
      const result: any = await new Promise((done, reject) => {
        const worker = new Worker(
          resolve(root, "tests/helpers/terrain-shader-parity-worker.mjs"),
          {
            workerData: { root, bundle, variants },
            env: { ...process.env, MESA_SHADER_CACHE_DISABLE: "true" },
            stdout: true,
            stderr: true,
          },
        );
        let report: any,
          logs = "";
        for (const stream of [worker.stdout, worker.stderr])
          stream.on("data", (chunk) => {
            logs = (logs + chunk).slice(-16000);
          });
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new Error("Terrain shader parity timed out\n" + logs));
        }, 180000);
        worker.on("message", (message) => {
          if (!message.progress) report = message;
        });
        worker.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.on("exit", (code) => {
          clearTimeout(timer);
          if (code || report?.error || !report)
            reject(
              new Error(
                (report?.error ?? "Native worker exit " + code) + "\n" + logs,
              ),
            );
          else done(report);
        });
      });
      expect(result.diagnostics).toEqual([]);
      expect(
        result.cases.map((entry: any) => [
          entry.seed,
          entry.ngPlus,
          entry.gameMode,
        ]),
      ).toEqual([
        [786433191, 0, "normal"],
        [195331, 0, "normal"],
        [100199613, 0, "normal"],
        [92, 1, "normal"],
        [1, 0, "nightmare"],
      ]);
      expect(result.comparisonCount).toBeGreaterThan(1500);
      expect(result.comparedBytes).toBeGreaterThan(40_000_000);
      expect(result.failures).toEqual([]);
      expect(result.mismatchedBytes).toBe(0);
      const samples = result.comparisons;
      for (const ids of [false, true])
        for (const plane of [-1, 0, 1])
          for (const pw of [-1, 0, 1])
            expect(
              samples.some(
                (sample: any) =>
                  sample.ids === ids &&
                  sample.plane === plane &&
                  sample.pw === pw &&
                  sample.visible > 100,
              ),
            ).toBe(true);
      expect(
        samples.filter((sample: any) => sample.name === "reported-pool" && sample.variant === 'native'),
      ).toHaveLength(36);
      expect(
        samples.filter((sample: any) => sample.name === "overview-filter" && sample.variant === 'native'),
      ).toHaveLength(10);
      console.log("[Terrain shader byte parity]", {
        comparisons: result.comparisonCount,
        bytes: result.comparedBytes,
        programs: result.programs,
        warm1080pDrawsMs: result.warmFrames,
      });
    } finally {
      await rm(bundle, { recursive: true, force: true });
    }
  },
  240000,
);
