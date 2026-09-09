import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// This runs real OpenGL ES 3 via Mesa/EGL, not a mocked renderer or a browser.
// Linux test hosts need libEGL.so.1 and libGLESv2.so.2 (Mesa supports headless use).
describe
  .skipIf(process.platform !== "linux")
  .sequential("real terrain renderer and OSD tile jobs", () => {
    const root = resolve(import.meta.dirname, "..");
    let output: string;
    const coldHashes = new Map<number, number[]>();

    beforeAll(async () => {
      output = await mkdtemp(resolve(tmpdir(), "noitamap-terrain-test-"));
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

    function render(seed: number, cached: boolean): Promise<any> {
      return new Promise((resolveResult, reject) => {
        const worker = new Worker(
          resolve(root, "tests/helpers/telescope-worker-runtime.mjs"),
          {
            workerData: {
              root,
              output,
              entry: resolve(output, "terrain.js"),
              mode: "terrain",
              seed,
              cached,
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
          if (error)
            reject(new Error(`${String(error)}\n${logs.slice(-12000)}`));
          else resolveResult(result);
        };
        const timer = setTimeout(
          () => finish("Native terrain rendering timed out"),
          120000,
        );
        worker.stdout.on("data", (data) => {
          logs += data;
        });
        worker.stderr.on("data", (data) => {
          logs += data;
        });
        worker.on("error", (error) => finish(error));
        worker.on("exit", (code) => {
          if (!settled) finish(`Renderer exited early (${code})`);
        });
        worker.on("message", (message) =>
          message.type === "fatal"
            ? finish(message.error)
            : finish(undefined, message),
        );
      });
    }

    // The second seed is the daily seed reported while investigating this failure.
    for (const seed of [42, 381776763])
      for (const cached of [false, true]) {
        it(`renders visible full-pixel and reduced tiles: seed ${seed}, ${cached ? "cached" : "cold"}`, async () => {
          const result = await render(seed, cached);
          expect(result.missing).toEqual([]);
          expect(result.graphics.draws).toBeGreaterThanOrEqual(24);
          expect(result.graphics.draws).toBeLessThan(74); // Four 1:1 leaves per biome/world; parents only reduce.
          expect(result.data).toHaveLength(12);
          for (const sample of result.data) {
            expect(
              sample.visible,
              JSON.stringify({ ...sample, png: undefined }),
            ).toBeGreaterThan(1000);
            expect(sample.colors).toBeGreaterThan(1);
            expect(sample.width).toBe(512);
            expect([511, 512]).toContain(sample.height);
            if (sample.png && !cached)
              await writeFile(
                resolve(
                  tmpdir(),
                  `noitamap-terrain-${seed}-${sample.biomeName}.png`,
                ),
                sample.png,
              );
          }
          if (!cached) {
            const first = result.data[0].firstPaint;
            expect(first.previewMs).toBeLessThan(1000);
            expect(first.shaderDraws).toBeLessThan(50);
            console.log(
              `[World-size verification] preview ${Math.round(first.previewMs)}ms, real GL refinement ${Math.round(first.refinedMs)}ms / ${first.shaderDraws} draws; overview still rendering`,
            );
          }
          const hashes = result.data.map((sample: any) => sample.hash);
          if (cached)
            expect(hashes, "cached and cold terrain pixels must match").toEqual(
              coldHashes.get(seed),
            );
          else coldHashes.set(seed, hashes);
          console.log(
            `[GL verification] seed=${seed} cached=${cached}: 12 nonblank tiles, ${result.graphics.draws} real shader draws (${result.graphics.renderer})`,
          );
        }, 180000);
      }
  });
