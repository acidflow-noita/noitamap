#!/usr/bin/env node
/** Native GLES benchmark; never launches a browser. All viewport timings wait
 * for glFinish and exclude readback. Tile timings include readback and the
 * existing CPU scene/liquid/edge finishing pass. */
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir, cpus } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const seed = Number(value("--seed", "786433191"));
const iterations = Number(value("--iterations", "7"));
const worlds = String(value("--worlds", "0")).split(",").map(Number);
if (
  !worlds.length ||
  !worlds.includes(0) ||
  worlds.some((world) => !Number.isInteger(world) || Math.abs(world) > 10) ||
  new Set(worlds).size !== worlds.length
)
  throw new Error(
    "--worlds must contain unique integer worlds including 0, between -10 and 10",
  );
const output = resolve(value("--out", "task/instant-map/benchmark.json"));
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
  throw new Error("--seed must be a uint32");
if (!Number.isInteger(iterations) || iterations < 2 || iterations > 100)
  throw new Error("--iterations must be between 2 and 100");
const bundle = await mkdtemp(resolve(tmpdir(), "noitamap-instant-bench-"));
const checkout = resolve(root, "lib/noita-telescope-vm");
const gitPointer = (await readFile(resolve(checkout, ".git"), "utf8")).trim();
const gitDir = resolve(checkout, gitPointer.replace(/^gitdir:\s*/, ""));
let telescopeRevision = (
  await readFile(resolve(gitDir, "HEAD"), "utf8")
).trim();
if (telescopeRevision.startsWith("ref: ")) {
  const ref = telescopeRevision.slice(5);
  try {
    telescopeRevision = (await readFile(resolve(gitDir, ref), "utf8")).trim();
  } catch {
    const packed = await readFile(resolve(gitDir, "packed-refs"), "utf8");
    telescopeRevision =
      packed
        .split("\n")
        .find((line) => line.endsWith(" " + ref))
        ?.split(" ")[0] || ref;
  }
}
try {
  await build({
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: bundle,
      copyPublicDir: false,
      rollupOptions: {
        input: resolve(root, "build_scripts/instant-terrain-fixture.ts"),
        preserveEntrySignatures: "strict",
        output: {
          entryFileNames: "benchmark.js",
          manualChunks: () => undefined,
        },
      },
    },
  });
  const data = await new Promise((done, reject) => {
    const worker = new Worker(
      new URL("./instant-terrain-benchmark-worker.mjs", import.meta.url),
      {
        workerData: {
          root,
          bundle,
          seed,
          iterations,
          worlds,
          requireHardware: args.includes("--require-hardware"),
        },
        stdout: true,
        stderr: true,
      },
    );
    let tail = "",
      result;
    for (const stream of [worker.stdout, worker.stderr])
      stream.on("data", (chunk) => {
        tail = (tail + chunk).slice(-16000);
      });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Native benchmark timed out\n${tail}`));
    }, 240000);
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on("message", (message) => {
      if (message.progress)
        process.stderr.write(`[instant terrain] ${message.progress}\n`);
      else result = message;
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code || !result || result.error)
        reject(new Error(`${result?.error || `Worker exit ${code}`}\n${tail}`));
      else done(result);
    });
  });
  const report = {
    measuredAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model,
      node: process.version,
    },
    telescopeRevision,
    ...data,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  await rm(bundle, { recursive: true, force: true });
}
