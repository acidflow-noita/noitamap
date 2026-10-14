import { expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeEdgeReferencePlugin } from "./helpers/native-edge-reference-plugin";
import { nativeCompositionReferencePlugin } from "./helpers/native-composition-reference-plugin";

it("builds the production composer without Telescope runtime, assets, application or DOM modules", async () => {
  const root = resolve(import.meta.dirname, ".."),
    modules = new Set<string>();
  await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    plugins: [
      {
        name: "composition-module-boundary",
        transform(_source, id) {
          modules.add(id);
        },
      },
    ],
    build: {
      write: false,
      lib: {
        entry: resolve(root, "src/native-map/composition/index.ts"),
        formats: ["es"],
      },
    },
  });
  expect(
    [...modules].filter((id) =>
      /\/src\/telescope\/|\/lib\/noita-telescope|\/src\/(?:renderer_settings|data-archive|app_|main\.)/.test(
        id,
      ),
    ),
  ).toEqual([]);
  expect(
    [...modules].some((id) => id.endsWith("/composition/strict-edges.ts")),
  ).toBe(true);
});

it("matches completed reference pages across all nine regions, shaft, liquid, scenes and static masks", async () => {
  const root = resolve(import.meta.dirname, "..");
  const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-composition-"));
  try {
    await build({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      publicDir: false,
      plugins: [
        nativeEdgeReferencePlugin(),
        nativeCompositionReferencePlugin(),
      ],
      build: {
        outDir: bundle,
        rollupOptions: {
          input: resolve(
            root,
            "tests/helpers/native-composition-runtime-fixture.ts",
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
        resolve(root, "tests/helpers/native-composition-runtime-worker.mjs"),
        {
          workerData: { root, bundle, entry: resolve(bundle, "fixture.js") },
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
        reject(new Error("Composition parity timed out\n" + log));
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
    expect(
      new Set(result.samples.map((s: any) => `${s.plane},${s.pw}`)).size,
    ).toBe(9);
    expect(new Set(result.samples.map((s: any) => s.name))).toEqual(
      new Set([
        "region",
        "vault",
        "liquid-cave",
        "pool",
        "scene",
        "partial-scene",
        "static-mask",
        "shaft",
      ]),
    );
    for (const sample of result.samples)
      expect(sample.mismatchedBytes, JSON.stringify(sample)).toBe(0);
    expect(result.edge.stats).toEqual({
      calls: result.samples.length,
      failures: 0,
    });
    expect(result.edge.memoryBytes).toBe(16777216);
    expect(result.sceneStats.instances).toBeGreaterThan(20);
    expect(result.sceneStats.comparedColorBytes).toBeGreaterThan(1_000_000);
    expect(result.sceneStats.comparedMaterialBytes).toBeGreaterThan(500_000);
    expect(result.sceneStats.positionVariants.instances).toBeGreaterThan(1);
    expect(result.sceneStats.positionVariants.distinct).toBeGreaterThan(1);
    expect(result.sceneStats.sourceCount).toBeGreaterThan(10);
    expect(result.sceneStats.sourceBytes).toBeGreaterThan(1_000_000);
    expect(result.sceneStats.sourceCacheBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024,
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}, 240000);
