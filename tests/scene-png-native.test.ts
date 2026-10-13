import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

it("preserves native display and persisted scene pixels when PNG encoding moves after paint", async () => {
  const root = resolve(import.meta.dirname, ".."),
    bundle = await mkdtemp(resolve(tmpdir(), "noitamap-scene-png-"));
  try {
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      publicDir: false,
      plugins: [
        {
          name: "scene-png-parity-hooks",
          enforce: "pre",
          transform(code, id) {
            if (
              !id
                .replace(/\\/g, "/")
                .endsWith("/src/telescope/telescope-osd-bridge.ts")
            )
              return;
            return (
              code +
              `\nexport { compositeSceneBitmap as __encodingComposite };\nexport async function __encodingSceneInputs(result) { await ensureTelescopeModules(); const scenes=renderableScenes(result); return {scenes:[...capturedGoldRepairs(scenes,result.worldSize),...scenes],index:await getScenePngIndex()}; }\n`
            );
          },
        },
      ],
      build: {
        outDir: bundle,
        rollupOptions: {
          input: resolve(root, "tests/helpers/scene-png-native-fixture.ts"),
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
        resolve(root, "tests/helpers/watercave-scene-worker.mjs"),
        {
          workerData: { root, bundle, fullPixels: true },
          stdout: true,
          stderr: true,
        },
      );
      let report: any,
        logs = "";
      for (const stream of [worker.stdout, worker.stderr])
        stream.on("data", (chunk) => {
          logs = (logs + chunk).slice(-14000);
        });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Native scene encoding timed out\n" + logs));
      }, 90000);
      worker.on("message", (message) => {
        report = message;
      });
      worker.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.on("exit", (code) => {
        clearTimeout(timeout);
        if (code || !report || report.error)
          reject(
            new Error((report?.error ?? "Worker exit " + code) + "\n" + logs),
          );
        else done(report);
      });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.samples).toHaveLength(7);
    expect(
      result.samples.reduce(
        (sum: number, sample: any) => sum + sample.bytes,
        0,
      ),
    ).toBeGreaterThan(3_000_000);
    for (const sample of result.samples) {
      expect(sample.displayDifferences, sample.name).toBe(0);
      expect(sample.persistedDifferences, sample.name).toBe(0);
      expect(sample.sourceReleased, sample.name).toBe(true);
      expect(sample.remaining, sample.name).toEqual({
        bytes: 0,
        queued: 0,
        active: 0,
      });
    }
    expect(result.queue).toEqual({ bytes: 0, queued: 0, active: 0 });
    console.log("[Scene PNG native parity]", result.samples);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}, 120000);
