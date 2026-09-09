import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe.sequential(
  "automatic full-pixel CPU fallback (WebGL explicitly refused)",
  () => {
    const root = resolve(import.meta.dirname, "..");
    let output: string;
    beforeAll(async () => {
      output = await mkdtemp(resolve(tmpdir(), "noitamap-cpu-terrain-"));
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
              mode: "cpu-terrain",
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
            reject(new Error(`${String(error)}\n${logs.slice(-10000)}`));
          else resolveResult(result);
        };
        const timer = setTimeout(
          () => finish("CPU renderer integration timed out"),
          180000,
        );
        worker.stdout.on("data", (data) => {
          logs += data;
        });
        worker.stderr.on("data", (data) => {
          logs += data;
        });
        worker.on("error", (error) => finish(error));
        worker.on("exit", (code) => {
          if (!settled) finish(`Renderer exited (${code})`);
        });
        worker.on("message", (message) =>
          message.type === "fatal"
            ? finish(message.error)
            : finish(undefined, message),
        );
      });
    }

    const hashes = new Map<number, number[]>();
    for (const seed of [38177673, 381773])
      for (const cached of [false, true]) {
        it(`renders seed ${seed}, ${cached ? "cache reload" : "cold load"}, without a WebGL context`, async () => {
          const result = await render(seed, cached);
          expect(result.graphics.renderer).toBe("CPU worker; WebGL disabled");
          expect(result.graphics.refusedContexts).toBe(cached ? 2 : 4);
          expect(result.missing).toEqual([]);
          expect(result.data).toHaveLength(12);
          for (const sample of result.data) {
            expect(
              sample.visible,
              JSON.stringify({ ...sample, png: undefined }),
            ).toBeGreaterThan(1000);
            expect(sample.colors).toBeGreaterThan(1);
          }
          const rendered = result.data.map((sample: any) => sample.hash);
          if (cached) expect(rendered).toEqual(hashes.get(seed));
          else hashes.set(seed, rendered);
          console.log(
            `[CPU verification] seed=${seed} cached=${cached}: 12 visible terrain tiles from the actual CPU worker; WebGL refused`,
          );
        }, 240000);
      }
  },
);
