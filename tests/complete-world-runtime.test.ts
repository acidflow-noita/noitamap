import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeEdgeReferencePlugin } from "./helpers/native-edge-reference-plugin";

it("bundles the complete page source without a Telescope or application runtime", async () => {
  const root = resolve(import.meta.dirname, ".."), modules = new Set<string>();
  await build({ configFile: false, logLevel: "error", publicDir: false,
    plugins: [{ name: "complete-world-boundary", transform(_source, id) { modules.add(id); } }],
    build: { write: false, lib: { entry: resolve(root, "src/native-map/complete-world/index.ts"), formats: ["es"] } } });
  expect([...modules].filter(id => /\/src\/telescope\/|\/lib\/noita-telescope|\/src\/(?:renderer_settings|data-archive|app_|main\.)/.test(id))).toEqual([]);
});

it("assembles a new owned world into exact all-nine sample pages and stored mip bytes", async () => {
  const root = resolve(import.meta.dirname, ".."), bundle = await mkdtemp(resolve(tmpdir(), "noitamap-complete-world-"));
  try {
    await build({ configFile: resolve(root, "vite.config.ts"), logLevel: "error", publicDir: false,
      plugins: [nativeEdgeReferencePlugin()], build: { outDir: bundle, rollupOptions: {
        input: resolve(root, "tests/helpers/complete-world-runtime-fixture.ts"), preserveEntrySignatures: "strict",
        output: { entryFileNames: "fixture.js", manualChunks: () => undefined },
      } } });
    const result: any = await new Promise((done, reject) => {
      const worker = new Worker(resolve(root, "tests/helpers/complete-world-runtime-worker.mjs"), {
        workerData: { root, bundle, entry: resolve(bundle, "fixture.js") }, stdout: true, stderr: true,
      });
      let output: any, log = "";
      for (const stream of [worker.stdout, worker.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-14000); });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`Complete world parity timed out\n${log}`)); }, 240000);
      worker.on("message", value => { output = value; });
      worker.on("error", error => { clearTimeout(timer); reject(error); });
      worker.on("exit", code => { clearTimeout(timer); if (code || !output || output.error) reject(new Error(`${output?.error ?? code}\n${log}`)); else done(output); });
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.scope).toBe("terrain-scenes-layer");
    expect(new Set(result.samples.map((s: any) => `${s.horizontal},${s.vertical}`)).size).toBe(9);
    expect(result.samples.every((s: any) => s.mismatchedBytes === 0)).toBe(true);
    expect(result.storedMipCount).toBe(result.samples.length * 10);
    expect(result.cancelledAsExpected).toBe(true); expect(result.disposedRejected).toBe(true);
    expect(result.invalidAddressRejected).toBe(true); expect(result.disposedIteratorRejected).toBe(true);
    expect(result.stats.resolverPeakBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(result.stats.preparedScenePeakBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.stats.sourceSceneBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.stats.resolverEvictions).toBeGreaterThan(0);
    if (process.env.NOITAMAP_COMPLETE_WORLD_EVIDENCE)
      await writeFile(process.env.NOITAMAP_COMPLETE_WORLD_EVIDENCE, JSON.stringify(result, null, 2) + "\n");
    console.log("[Complete world source]", JSON.stringify(result));
  } finally { await rm(bundle, { recursive: true, force: true }); }
}, 300000);
