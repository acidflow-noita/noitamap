import { it, expect } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

it("exports matching actual CPU/GPU bake masks without changing pixels, across vertical planes", async () => {
  const root = resolve(import.meta.dirname, ".."), bundle = await mkdtemp(resolve(tmpdir(), "noitamap-liquid-native-"));
  try {
    await build({ configFile: resolve(root, "vite.config.ts"), logLevel: "error", build: { outDir: bundle,
      rollupOptions: { input: resolve(root, "tests/helpers/generated-liquid-mask-fixture.ts"),
        preserveEntrySignatures: "strict", output: { entryFileNames: "verify.js", manualChunks: () => undefined } } } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, "tests/helpers/generated-liquid-mask-worker.mjs"), {
        workerData: { root, bundle, entry: resolve(bundle, "verify.js") }, stdout: true, stderr: true });
      let logs = "", received = false;
      for (const stream of [worker.stdout!, worker.stderr!]) stream.on("data", c => logs = (logs + c).slice(-12000));
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`Liquid mask native test timed out\n${logs}`)); }, 180000);
      worker.on("error", error => { clearTimeout(timeout); void worker.terminate(); reject(error); });
      worker.on("exit", code => { if (!received) { clearTimeout(timeout); reject(new Error(`Native mask worker exited ${code}\n${logs}`)); } });
      worker.on("message", message => {
        received = true;
        clearTimeout(timeout);
        if (message.error) { void worker.terminate(); reject(new Error(`${message.error}\n${logs}`)); return; }
        const shutdown = setTimeout(() => { void worker.terminate(); reject(new Error("Native mask cleanup timed out")); }, 5000);
        worker.once("exit", () => { clearTimeout(shutdown); done(message); });
      });
    });
    expect(result.samples.map((sample: any) => sample.seed)).toEqual([195331, 2100611341]);
    for (const sample of result.samples) {
      expect(sample.results).toHaveLength(5);
      for (const region of sample.results) {
        expect(region.pixelDifferences).toBe(0);
        expect(region.maskDifferences).toBe(0);
        expect(region.invalid).toBe(false);
      }
      expect(sample.results[0].liquidPixels).toBeGreaterThan(0);
      expect(sample.results[0].liquidPixels).toBeLessThan(200 * 120);
      expect(sample.results[4].opaquePixels).toBeLessThanOrEqual(184); // unfilled half of first surface row only
      expect(sample.results[4].liquidPixels).toBe(0); // static mask owns these pixels
    }
    console.log("[liquid mask native]", JSON.stringify(result));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 240000);
