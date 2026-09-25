import { it, expect } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

it.skipIf(process.platform !== "linux")(
  "runs production GPU resources and draws in a native worker, matching the direct shader",
  async () => {
    const root = resolve(import.meta.dirname, "..");
    const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-instant-worker-"));
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
              "tests/helpers/instant-terrain-worker-fixture.ts",
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
          resolve(root, "tests/helpers/instant-terrain-native-worker.mjs"),
          {
            workerData: { root, bundle, entry: resolve(bundle, "fixture.js") },
            stdout: true,
            stderr: true,
            env: { ...process.env, MESA_SHADER_CACHE_DISABLE: "true" },
          },
        );
        let result: any,
          logs = "";
        for (const stream of [worker.stdout, worker.stderr])
          stream.on("data", (chunk) => {
            logs = (logs + chunk).slice(-12000);
          });
        const timeout = setTimeout(() => {
          void worker.terminate();
          reject(new Error(`Native GPU worker timed out\n${logs}`));
        }, 120000);
        worker.on("message", (message) => {
          result = message;
          if (message.error) {
            clearTimeout(timeout);
            void worker.terminate();
            reject(new Error(`${message.error}\n${logs}`));
          }
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
      expect(result.backend).toBe("worker");
      expect(result.diagnostics).toEqual([]);
      expect(result.comparedBytes).toBe(3 * 128 * 128 * 4);
      expect(result.mismatches).toBe(0);
      expect(result.visible).toBeGreaterThan(100);
      console.log(
        "[Native GPU worker, shader cache disabled]",
        JSON.stringify(result),
      );
    } finally {
      await rm(bundle, { recursive: true, force: true });
    }
  },
  150000,
);
