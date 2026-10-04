import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

describe.skipIf(process.platform !== "linux")("shared terrain resources with native GLES", () => {
  const root = resolve(import.meta.dirname, "..");
  let bundle: string;
  beforeAll(async () => {
    bundle = await mkdtemp(resolve(tmpdir(), "noitamap-shared-terrain-"));
    await build({
      configFile: resolve(root, "vite.config.ts"), logLevel: "error", publicDir: false,
      plugins: [{
        name: "count-real-lattice-builds", enforce: "pre",
        transform(source, id) {
          if (!id.replace(/\\/g, "/").endsWith("/lib/noita-telescope-vm/js/engine_resolve/lattice_builder.js")) return;
          const signature = "export function buildEngineLattice(layers, generatorConfig, mapWidth, mapHeight) {";
          if (source.split(signature).length !== 2) throw new Error("Review changed lattice builder instrumentation");
          const result = "return { GW, GH, cov, mat, chunkCovered };";
          if (source.split(result).length !== 2) throw new Error("Review changed lattice result instrumentation");
          return source.replace(signature, `${signature}\n globalThis.__sharedResourceTrace?.latticeBuilds.push(globalThis.__sharedResourceTrace.phase);`)
            .replace(result, `globalThis.__sharedResourceTrace?.coverage.push({phase:globalThis.__sharedResourceTrace.phase,covered:chunkCovered.slice()});\n${result}`);
        },
      }],
      build: { outDir: bundle, rollupOptions: {
        input: resolve(root, "tests/helpers/shared-terrain-resources-fixture.ts"),
        preserveEntrySignatures: "strict", output: { entryFileNames: "fixture.js", manualChunks: () => undefined },
      } },
    });
  }, 120000);
  afterAll(async () => { if (bundle) await rm(bundle, { recursive: true, force: true }); });

  it("preserves the three-renderer pixel reference while sharing uploads and safely replacing resources", async () => {
    const result: any = await new Promise((resolveResult, reject) => {
      const worker = new Worker(resolve(root, "tests/helpers/shared-terrain-resources-worker.mjs"), {
        workerData: { root, bundle }, stdout: true, stderr: true,
      });
      let logs = "", result: any;
      for (const stream of [worker.stdout, worker.stderr]) stream.on("data", data => { logs = (logs + data).slice(-16000); });
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(`Shared native terrain test timed out\n${logs}`)); }, 120000);
      worker.on("message", message => { result = message; });
      worker.on("error", error => { clearTimeout(timeout); reject(error); });
      worker.on("exit", code => {
        clearTimeout(timeout);
        if (code || !result || result.error) reject(new Error(`${result?.error ?? `Native worker exited ${code}`}\n${logs}`));
        else resolveResult(result);
      });
    });
    const { samples, ...statistics } = result;
    console.log("[Shared terrain native parity/resource verification]", JSON.stringify({
      ...statistics, sampleCount: samples.length, sampleFailures: samples.filter((sample: any) => sample.mismatchedBytes),
    }));
    expect(result.diagnostics).toEqual([]);
    expect(result.samples.length).toBeGreaterThanOrEqual(36);
    expect(result.comparedPixels).toBeGreaterThan(80_000);
    for (const sample of result.samples) expect(sample.mismatchedBytes, JSON.stringify(sample)).toBe(0);
    expect(result.mixedSamples).toBeGreaterThanOrEqual(6);
    expect(result.tableCellsCompared).toBe(70 * 48 * 3);
    expect(result.tableMismatches).toBe(0);
    expect(result.selectedPlaneTableMismatches).toBe(0);
    expect(result.allBiomeTableMismatches).toBe(0);
    expect(result.allBiomeColorsCompared).toBeGreaterThan(50);
    expect(result.allBiomeCoveredCases).toBe(result.allBiomeColorsCompared * 2);
    expect(result.samples.filter((sample: any) => sample.name === "temple-fallback").every((sample: any) => sample.nonAir > 0)).toBe(true);
    const islands = result.samples.filter((sample: any) => sample.name.startsWith("island-"));
    expect(islands).toHaveLength(12);
    for (const sample of islands) {
      expect(sample.nonAir, JSON.stringify(sample)).toBeGreaterThan(100);
      expect(sample.ownedPixels, JSON.stringify(sample)).toBe(sample.width * sample.height);
      expect(sample.mainOwnedPixels, JSON.stringify(sample)).toBe(0);
      expect(sample.nativePixelChanges, JSON.stringify(sample)).toBeGreaterThan(100);
    }
    const friends = result.samples.filter((sample: any) => sample.name.startsWith('friend-fill-'));
    expect(friends).toHaveLength(21);
    for (const sample of friends) {
      expect(sample.nonAir, JSON.stringify(sample)).toBe(sample.width * sample.height);
      expect(sample.ownedPixels, JSON.stringify(sample)).toBe(0);
      expect(sample.verticalOwnedPixels, JSON.stringify(sample)).toBe(0);
    }
    expect(result.materialSamples).toEqual([426, 140, 140, 426, 5, 5, 32, 279, 140, 140]);
    expect(result.referenceLatticeBuilds).toBe(3);
    expect(result.sharedLatticeBuilds).toBe(1);
    expect(result.referenceLargeUploads).toBe(result.sharedLargeUploads * 3);
    expect(result.sharedLargeUploads).toBeGreaterThanOrEqual(3);
    expect(result.sharedUploadedBytes).toBeLessThan(result.referenceUploadedBytes);
    expect(result.smallBytesPerPlane).toBeGreaterThan(0);
    expect(result.allPlaneUploadedBytes).toBe(result.smallBytesPerPlane * 3);
    expect(result.switchUploads).toBe(0);
    expect(result.switchCompiles).toBe(0);
    expect(result.switchLatticeBuilds).toBe(0);
    expect(result.sameGenerationUploads).toBe(0);
    expect(result.idempotentInvalidation).toBe(true);
    expect(result.deletedTextureTwice).toBe(false);
    expect(result.liveTexturesAfterInvalidation).toBe(0);
    expect(result.reinitializedPixelsMatch).toBe(true);
    expect(result.reinitializedLatticeBuilds).toBe(1);
    expect(result.reinitializedCompiles).toBe(0);
    expect(result.replacedSeedPixelsMatch).toBe(true);
    expect(result.replacedSeedPhaseMatches).toBe(true);
    expect(result.replacedSeedCompiles).toBe(0);
    expect(result.allOwnedTexturesReleased).toBe(true);
    expect(result.elevatorSamples).toHaveLength(9);
    for (const sample of result.elevatorSamples) {
      expect(sample.solid, JSON.stringify(sample)).toBeGreaterThan(1024);
      expect(sample.air, JSON.stringify(sample)).toBeGreaterThan(1024);
      // CPU double and GPU float noise have rare contour threshold differences.
      expect(sample.mismatches / sample.pixels, JSON.stringify(sample)).toBeLessThan(0.0005);
    }
    // One common lattice with one narrow 49-row shaft, not a second world.
    expect(result.elevatorLatticeBytes).toBeLessThan(56 * 1024 ** 2);
    // Firefox must not security-clear a large null-allocated texture on the
    // first partial upload. Observe the real resource creation calls.
    expect(result.elevatorUninitializedUploads).toBe(0);
    expect(result.elevatorPartialUploads).toBe(0);
    expect(result.packedWorldPixelsMatch).toBe(true);
    expect(result.elevatorSwitchUploads).toBe(0);
    expect(result.elevatorSwitchCompiles).toBe(0);
    expect(result.elevatorTexturesReleased).toBe(true);
  }, 150000);
});
