import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

it("keeps completed 512px CPU terrain tiles identical with owned WASM materials", async () => {
  const root = resolve(import.meta.dirname, "..");
  const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-native-materials-"));
  try {
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      publicDir: false,
      build: {
        outDir: bundle,
        rollupOptions: {
          input: resolve(root, "tests/helpers/native-materials-fixture.ts"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "fixture.js",
            manualChunks: () => undefined,
          },
        },
      },
    });
    const run = (failNative = false): Promise<any> =>
      new Promise((done, reject) => {
        const worker = new Worker(
          resolve(root, "tests/helpers/native-materials-worker.mjs"),
          {
            workerData: {
              root,
              bundle,
              entry: resolve(bundle, "fixture.js"),
              failNative,
            },
            stdout: true,
            stderr: true,
          },
        );
        let logs = "",
          result: any;
        for (const stream of [worker.stdout, worker.stderr])
          stream.on("data", (chunk) => {
            logs = (logs + chunk).slice(-12000);
          });
        const timeout = setTimeout(() => {
          void worker.terminate();
          reject(new Error(`Native material test timed out\n${logs}`));
        }, 180000);
        worker.on("message", (message) => {
          result = message;
        });
        worker.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        worker.on("exit", (code) => {
          clearTimeout(timeout);
          if (code || !result || result.error)
            reject(
              new Error(`${result?.error || `Worker exit ${code}`}\n${logs}`),
            );
          else done(result);
        });
      });
    const result = await run();
    result.initializationFailure = await run(true);
    // Opt-in evidence output keeps normal test runs free of repository writes.
    if (process.env.NOITAMAP_NATIVE_MATERIAL_BENCHMARK)
      await writeFile(
        process.env.NOITAMAP_NATIVE_MATERIAL_BENCHMARK,
        JSON.stringify(result, null, 2) + "\n",
      );
    expect(result.diagnostics).toEqual([]);
    expect(result.cases).toHaveLength(2);
    // Pre-bulk completed-tile bytes, captured by the existing native fixture.
    // Both material backends share finishing, so their mutual agreement alone
    // would not catch a common background/scene/decal regression.
    const expectedHashes: Record<string, string> = {
      "mines-with-force-air":
        "f4d0c0b74e52313132ccdc9b4ab74efdf218eb6e0abb139a7072f2e334271f1a",
      "mixed-topology":
        "743dda1210a7efd6980752d8db08c7aaf018b9e1c0d7bf6f4cad24464823ae4d",
      "west-world-boundary":
        "30e14955ebf1352266dc2ff8067e68104607e750abb9d3b36582b8af909fcb58",
      "west-parallel-chunk-seam":
        "7916e8dcb928ab3f917e0fe35d54fe9774901cd96d5eeda297d5dce4047916fc",
      "authored-mana-pool":
        "bc6b2bca315684018814b44a38c13d26a500b06e4f5bc985bdccdb526b1de36d",
    };
    for (const item of result.cases) {
      expect(item.lazyUnowned).toEqual({
        resolved: 0,
        changedOutsideRows: false,
        nonzeroInsideRows: false,
      });
      expect(item.splitRowDifferences).toBe(0);
      expect(item.nativeMaterialStats.enabled).toBe(true);
      expect(item.nativeMaterialStats.failures).toBe(0);
      expect(item.nativeMaterialStats.batches).toBeGreaterThan(0);
      expect(item.nativeMaterialStats.pixels).toBeGreaterThan(512 * 512);
      for (const sample of item.samples) {
        expect(sample.comparedBytes).toBe(512 * 512 * 4);
        expect(
          sample.mismatchedBytes,
          JSON.stringify(sample.firstDifferences),
        ).toBe(0);
        expect(sample.native.hash).toBe(sample.baseline.hash);
        expect(sample.native.hash).toBe(expectedHashes[sample.name]);
        if (sample.name === "west-world-boundary") {
          expect(sample.hasContent).toBe(false);
          expect(sample.visible).toBe(0);
        } else expect(sample.visible).toBeGreaterThan(1000);
        if (sample.name === "mines-with-force-air")
          expect(sample.forceAirBackgroundPixels).toBe(32 * 32);
      }
    }
    const failed = result.initializationFailure.cases[0];
    expect(failed.nativeMaterialStats.enabled).toBe(false);
    expect(failed.nativeMaterialStats.batches).toBe(0);
    for (const sample of failed.samples) {
      expect(
        sample.mismatchedBytes,
        JSON.stringify(sample.firstDifferences),
      ).toBe(0);
      expect(sample.native.hash).toBe(sample.baseline.hash);
      expect(sample.forceAirBackgroundPixels).toBe(32 * 32);
    }
    // Captured from the explicit JS backend and independently matched with
    // native initialization disabled, including final backgrounds and decals.
    const expectedVerticalHashes: Record<string, string> = {
      "-1/warped-main":
        "1263ef2418f33687f1c87710a95d7c229cd38665479554b7121e6504638f5246",
      "-1/mixed-west":
        "ff6e11011724f9f8e16d36b1f17a97a9ebcac8abe5555f2ee51ee7c794072424",
      "-1/bottom-seam":
        "b4305bf27b779c3d34ca114af23392767c5067ce02498c2294b1abb25173ed91",
      "1/warped-main":
        "59663e0cbe1d5b4c0139c35becf7fc88d87f68816587af15b6687a363a0a56c5",
      "1/mixed-west":
        "8d809f781960d657a2082e3d2766759b797d293de3891ab97a011c727fb2b18b",
      "1/bottom-seam":
        "9d12e6ebfbd087dae4265e718f5d8c9e5cfbcd37c98060436ef9455798c92b49",
      "1/elevator-0":
        "f09777415a65c4584f4b4906ec1a1bad90c7915b7d9139e5406e42d7420767ca",
      "1/elevator-23":
        "1a5fcdaf24a70e01e4eb28c464b09d04d930bf32aee89aff28067a3bd6de49d7",
      "1/elevator-47":
        "d4bdb13affb270b6bb20d12fd96be538071a1ed84f8f59102c93fb36c0ec27d4",
      "1/elevator-west-seam":
        "0398e6bb4c053502cf4b0b301a7272a5e9d8eff142bc118ae49d50d3990bc0d7",
    };
    for (const [report, enabled] of [
      [result, true],
      [result.initializationFailure, false],
    ] as const) {
      expect(report.verticalCases.map((item: any) => item.plane)).toEqual([
        -1, 1,
      ]);
      for (const item of report.verticalCases) {
        const names = ["warped-main", "mixed-west", "bottom-seam"];
        if (item.plane === 1) {
          expect(item.elevatorCount).toBeGreaterThan(0);
          names.push(
            "elevator-0",
            "elevator-23",
            "elevator-47",
            "elevator-west-seam",
          );
        } else expect(item.elevatorCount).toBe(0);
        expect(
          item.samples.map((sample: any) => `${sample.name}:${sample.pass}`),
        ).toEqual(names.flatMap((name) => [`${name}:first`, `${name}:cached`]));
        expect(item.nativeMaterialStats.enabled).toBe(enabled);
        expect(item.nativeMaterialStats.failures).toBe(0);
        if (enabled) {
          expect(item.nativeMaterialStats.batches).toBe(names.length);
          expect(item.nativeMaterialStats.pixels).toBeGreaterThan(512 * 512);
        } else expect(item.nativeMaterialStats.batches).toBe(0);
        for (const sample of item.samples) {
          expect(sample.hasContent).toBe(true);
          expect(sample.visible).toBeGreaterThan(1000);
          expect(sample.comparedBytes).toBe(512 * 512 * 4);
          expect(
            sample.mismatchedBytes,
            JSON.stringify({
              plane: item.plane,
              name: sample.name,
              first: sample.firstDifferences,
            }),
          ).toBe(0);
          expect(sample.native.hash).toBe(sample.baseline.hash);
          expect(sample.native.hash).toBe(
            expectedVerticalHashes[`${item.plane}/${sample.name}`],
          );
        }
      }
    }
    console.log(
      "[Completed native-material tiles]",
      JSON.stringify(
        [...result.cases, ...result.verticalCases].map((item: any) => ({
          seed: item.seed,
          plane: item.plane ?? 0,
          native: item.nativeMaterialStats,
          samples: item.samples.map((s: any) => ({
            name: s.name,
            pass: s.pass,
            jsMs: s.baseline.completedMs,
            wasmMs: s.native.completedMs,
            mismatchedBytes: s.mismatchedBytes,
          })),
        })),
      ),
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}, 240000);
