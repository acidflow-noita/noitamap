import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeEdgeReferencePlugin } from "./helpers/native-edge-reference-plugin";

it("keeps finished real tiles exact across all nine regions and unavailable edge WASM", async () => {
  const root = resolve(import.meta.dirname, "..");
  const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-native-edges-"));
  try {
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      publicDir: false,
      plugins: [nativeEdgeReferencePlugin()],
      build: {
        outDir: bundle,
        rollupOptions: {
          input: resolve(root, "tests/helpers/native-edge-runtime-fixture.ts"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "fixture.js",
            manualChunks: () => undefined,
          },
        },
      },
    });
    for (const failModule of [false, true]) {
      const result: any = await new Promise((done, reject) => {
        const worker = new Worker(
          resolve(root, "tests/helpers/native-edge-runtime-worker.mjs"),
          {
            workerData: {
              root,
              bundle,
              entry: resolve(bundle, "fixture.js"),
              failModule,
            },
            stdout: true,
            stderr: true,
          },
        );
        let result: any,
          log = "";
        for (const stream of [worker.stdout, worker.stderr])
          stream.on("data", (chunk) => {
            log = (log + chunk).slice(-12000);
          });
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new Error("Native edge test timed out\n" + log));
        }, 180000);
        worker.on("message", (message) => {
          result = message;
        });
        worker.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.on("exit", (code) => {
          clearTimeout(timer);
          if (code || !result || result.error)
            reject(new Error((result?.error ?? code) + "\n" + log));
          else done(result);
        });
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.samples).toHaveLength(11);
      expect(
        new Set(result.samples.map((s: any) => `${s.plane},${s.pw}`)).size,
      ).toBe(9);
      for (const sample of result.samples)
        expect(sample.mismatchedBytes, JSON.stringify(sample)).toBe(0);
      if (failModule) {
        expect(result.edge).toBeNull();
        expect(result.rejected).toBe(1);
      } else {
        expect(result.edge.enabled).toBe(true);
        expect(result.edge.stats).toMatchObject({
          calls: 11,
          fallbacks: 0,
          failures: 0,
        });
        expect(result.edge.memoryBytes).toBe(16777216);
      }
    }
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}, 240000);
