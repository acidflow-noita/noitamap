import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe.sequential("real parallel final-pixel workers (no browser)", () => {
  const root = resolve(import.meta.dirname, "..");
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(resolve(tmpdir(), "noitamap-worker-pool-"));
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      build: {
        outDir: output,
        rollupOptions: {
          input: resolve(root, "tests/helpers/render-terrain-fixture.ts"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "terrain.js",
            manualChunks: () => undefined,
          },
        },
      },
    });
  }, 120000);
  afterAll(async () => {
    if (output) await rm(output, { recursive: true, force: true });
  });
  function measure(hardwareConcurrency: number): Promise<any> {
    return new Promise((resolveResult, reject) => {
      const worker = new Worker(
        resolve(root, "tests/helpers/telescope-worker-runtime.mjs"),
        {
          workerData: {
            root,
            output,
            entry: resolve(output, "terrain.js"),
            mode: "cpu-terrain",
            poolBenchmark: true,
            hardwareConcurrency,
            seed: 786433191,
          },
          stdout: true,
          stderr: true,
        },
      );
      let logs = "",
        settled = false;
      const finish = (error?: unknown, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(new Error(`${String(error)}\n${logs.slice(-8000)}`));
        else resolveResult(result);
      };
      const timer = setTimeout(
        () => finish("Native pool benchmark timed out"),
        180000,
      );
      worker.stdout.on("data", (b) => (logs += b));
      worker.stderr.on("data", (b) => (logs += b));
      worker.on("error", (error) => finish(error));
      worker.on("exit", (code) => {
        if (!settled) finish(`Native pool worker exited (${code})`);
      });
      worker.on("message", (message) =>
        message.type === "fatal"
          ? finish(message.error)
          : finish(undefined, message),
      );
    });
  }
  it("keeps all pixels identical with 1 vs 4 concurrent workers", async () => {
    // Sequential A/B: the two runs must not compete for the test host's CPUs.
    const serial = await measure(2),
      parallel = await measure(8);
    for (const result of [serial, parallel]) {
      expect(result.missing).toEqual([]);
      expect(result.data.tiles).toBe(12);
      expect(result.data.cold.hashes).toEqual(result.data.warm.hashes);
      expect(result.data.pool.completed).toBe(24);
    }
    expect(serial.data.pool).toMatchObject({
      limit: 1,
      workers: 1,
      peakRendering: 1,
    });
    expect(parallel.data.pool).toMatchObject({
      limit: 4,
      workers: 4,
      peakRendering: 4,
    });
    expect(parallel.data.cold.hashes).toEqual(serial.data.cold.hashes);
    console.log(
      `[Native pool A/B] 12 final tiles: single cold=${Math.round(serial.data.cold.ms)}ms warm=${Math.round(serial.data.warm.ms)}ms; 4 workers cold=${Math.round(parallel.data.cold.ms)}ms warm=${Math.round(parallel.data.warm.ms)}ms. All pixel hashes match.`,
    );
    // Timing is evidence, not a flaky CI pass threshold on shared test hosts.
  }, 240000);
});
