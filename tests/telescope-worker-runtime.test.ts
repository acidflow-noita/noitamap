import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bootstrap = resolve(root, "tests/helpers/telescope-worker-runtime.mjs");
let directory: string;
let output: string;
let fixtureOutput: string;
let workerEntry: string;
let fixtureEntry: string;
const fixtures = new Map<string, any>();

function execute(
  workerData: Record<string, unknown>,
  input?: unknown,
): Promise<any> {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(bootstrap, {
      workerData: { root, ...workerData },
      stdout: true,
      stderr: true,
    });
    let logs = "";
    let settled = false;
    const stop = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new Error(`${error.message}\n${logs.slice(-16000)}`));
      else resolveResult(result);
    };
    worker.stdout.on("data", (data) => {
      logs += data.toString();
    });
    worker.stderr.on("data", (data) => {
      logs += data.toString();
    });
    const timer = setTimeout(
      () => stop(new Error("Real Telescope worker timed out")),
      60000,
    );
    worker.on("error", (error) =>
      stop(error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", (code) => {
      if (!settled) stop(new Error(`Worker exited early (${code})`));
    });
    worker.on("message", (message) => {
      if (message.type === "ready") worker.postMessage(input);
      else if (message.type === "fatal") stop(new Error(message.error));
      else if (message.type === "result" && !message.data.success) {
        stop(
          new Error(
            `${message.data.phase}: ${message.data.error}\n${message.data.stack ?? ""}`,
          ),
        );
      } else stop(undefined, message);
    });
  });
}

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "noitamap-worker-test-"));
  output = resolve(directory, "app");
  fixtureOutput = resolve(directory, "fixtures");
  // Build the actual app worker using the deployment aliases and worker plugin.
  // Do NOT mock modules or polyfill Image; those would hide the reported crash.
  await build({
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: { outDir: output },
  });
  workerEntry = resolve(
    output,
    "assets",
    (await readdir(resolve(output, "assets"))).find((f) =>
      /^pw-worker-.*\.js$/.test(f),
    )!,
  );
  const fixture = resolve(root, "tests/helpers/generate-worker-fixture.ts");
  await build({
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    publicDir: false,
    build: {
      outDir: fixtureOutput,
      minify: false,
      rollupOptions: {
        input: fixture,
        preserveEntrySignatures: "strict",
        output: { entryFileNames: "fixture.js", manualChunks: () => undefined },
      },
    },
  });
  fixtureEntry = resolve(fixtureOutput, "fixture.js");
}, 120000);

afterAll(async () => {
  fixtures.clear();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.sequential(
  "production PW worker with real seed generation and native rasterization (no browser)",
  () => {
    it("returns the original worker stack and generation phase on failure", async () => {
      await expect(
        execute(
          { entry: workerEntry, output },
          {
            fullPixels: true,
            seed: 1,
            pw: 1,
            ngPlus: 0,
            gameMode: "normal",
            perks: {},
            unlocks: null,
            dailySeed: false,
            skipCosmeticScenes: false,
          },
        ),
      ).rejects.toThrow(/scanning main-plane spawns[\s\S]*TypeError/);
    }, 60000);
    for (const fullPixels of [false, true])
      for (const seed of [1, 42])
        for (const pw of [-1, 1]) {
          it(`${fullPixels ? "full-pixel" : "standard"}, seed ${seed}, PW ${pw}`, async () => {
            const key = `${fullPixels}/${seed}`;
            if (!fixtures.has(key)) {
              const generated = await execute({
                mode: "fixture",
                entry: fixtureEntry,
                output: fixtureOutput,
                fullPixels,
                seed,
              });
              expect(
                generated.missing,
                "fixture requests must resolve to shipped assets",
              ).toEqual([]);
              expect(generated.data.biomeData.pixels).toHaveLength(70 * 48);
              fixtures.set(key, generated.data);
            }
            const result = await execute(
              { entry: workerEntry, output },
              { ...fixtures.get(key), pw },
            );
            expect(result.imageGlobal).toBe("undefined");
            expect(
              result.missing,
              "worker requests must resolve to shipped assets",
            ).toEqual([]);
            expect(result.data.success).toBe(true);
            expect(result.data.pw).toBe(pw);
            expect(result.data.pois.length).toBeGreaterThan(100);
            const located = result.data.pois.filter(
              (poi: any) => "x" in poi && "y" in poi,
            );
            expect(located.length).toBeGreaterThan(100);
            expect(
              located.every(
                (poi: any) => Number.isFinite(poi.x) && Number.isFinite(poi.y),
              ),
            ).toBe(true);
            expect(result.data.pixelScenes.length).toBeGreaterThan(20);
            expect(
              result.data.pois.some(
                (poi: any) => poi.item === "wand" || poi.type === "wand",
              ),
            ).toBe(true);
            expect(
              result.data.pixelScenes.every(
                (scene: any) => !scene || !("imgElement" in scene),
              ),
            ).toBe(true);
            expect(
              result.requests.some((url: string) =>
                url.includes("eye_message"),
              ),
            ).toBe(false);
            console.log(
              `[Worker verification] ${key}, PW ${pw}: ${result.data.pois.length} POIs, ${result.data.pixelScenes.length} scenes`,
            );
          }, 120000);
        }
  },
);
