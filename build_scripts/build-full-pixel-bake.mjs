#!/usr/bin/env node
/** Complete GPU-independent daily bake. One seed generation, bounded native
 * workers, exact RGBA mip reduction, lossless tiles and validated publication. */
import { build } from "vite";
import { Worker } from "node:worker_threads";
import { resolve, join } from "node:path";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import {
  TILE,
  OVERLAP,
  maxLevel,
  levelSize,
  coreShape,
  corePath,
  completeFile,
  atomicWrite,
} from "./terrain-pyramid.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const out = resolve(String(args.out || "optional_data/full-pixel-bake"));
let seed = Number(args.seed);
if (!Number.isInteger(seed))
  seed = Number(
    (
      await (
        await fetch("https://daily-seed.acidflow.stream/current_seed.txt")
      ).text()
    ).trim(),
  );
if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
  throw new Error("Invalid seed");
const requested = Number(
  args.concurrency ||
    process.env.TERRAIN_CONCURRENCY ||
    Math.max(1, availableParallelism() - 2),
);
if (!Number.isSafeInteger(requested) || requested < 1)
  throw new Error("concurrency must be a positive integer");
const limit = Math.max(
  1,
  Math.min(
    availableParallelism(),
    Math.floor(totalmem() / 1024 ** 3 / 1.5),
    requested,
  ),
);
const start = Date.now();
const log = (message) =>
  console.log(
    `[full-pixel bake +${((Date.now() - start) / 1000).toFixed(1)}s] ${message}`,
  );
await mkdir(out, { recursive: true });
const bundle = resolve(out, "runtime"),
  snapshot = resolve(out, "generation.bin");
await build({
  configFile: resolve(root, "vite.config.ts"),
  logLevel: "error",
  build: {
    outDir: bundle,
    minify: true,
    rollupOptions: {
      input: resolve(root, "src/telescope/bake-entry.ts"),
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "bake.js",
        manualChunks: (id) => {
          if (/upng|UPNG|pako/.test(id)) return "png-codecs";
          if (id.includes("preload-helper")) return "bootstrap";
          if (
            id.includes("/src/") &&
            /telescope-data-bridge|telescope-asset|telescope-dom-shim|zip-extraction-shim|data-archive|png-decode|full-pixel-data|renderer_settings/.test(
              id,
            )
          )
            return "data-runtime";
          if (id.includes("/lib/noita-telescope-vm/js/"))
            return "telescope-full-pixels";
          if (id.includes("/lib/noita-telescope/js/"))
            return "telescope-legacy";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
});
const entry = resolve(bundle, "bake.js");
const workerFile = new URL("./native-terrain-worker.mjs", import.meta.url);
async function prepare() {
  log(`preparing seed ${seed} once (no browser/GPU)`);
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { role: "prepare", root, bundle, entry, seed, snapshot },
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(error);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!settled)
        fail(new Error(`Preparation exited without a result (${code})`));
    });
    worker.on("message", (m) => {
      if (m.type === "prepared") {
        settled = true;
        resolveResult(m);
        void worker.terminate();
      } else if (m.type === "error") fail(new Error(m.error));
    });
  });
}
const fingerprint = createHash("sha256");
for (const directory of [
  "src/telescope",
  "lib/noita-telescope-vm/js",
  "lib/noita-telescope-vm/js/engine_resolve",
  "lib/noita-telescope-vm/js/gl",
  "build_scripts",
]) {
  for (const name of (await readdir(resolve(root, directory))).sort()) {
    if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
    fingerprint.update(directory + "/" + name);
    fingerprint.update(await readFile(resolve(root, directory, name)));
  }
}
for (const file of [
  "package-lock.json",
  "public/data.zip",
  "public/wang_tiles.zip",
  "public/pixel_scenes.zip",
  "lib/noita-telescope-vm/data/material_atlas.bin",
  "lib/noita-telescope-vm/data/material_atlas.json",
])
  fingerprint.update(await readFile(resolve(root, file)));
const codeHash = fingerprint.digest("hex").slice(0, 16);
let prepared;
if (args.resume) {
  try {
    prepared = JSON.parse(
      await readFile(resolve(out, "prepared.json"), "utf8"),
    );
    if (
      prepared.seed !== seed ||
      prepared.codeHash !== codeHash ||
      !(await completeFile(snapshot))
    )
      prepared = null;
  } catch {}
}
if (!prepared) {
  prepared = { ...(await prepare()), codeHash };
  await atomicWrite(
    resolve(out, "prepared.json"),
    JSON.stringify(prepared, null, 2),
  );
}
log(
  `prepared all three vertical planes, ${prepared.width} x ${prepared.height} per world`,
);
if (args["prepare-only"]) process.exit(0);
const data = deserialize(await readFile(snapshot));
const renderId = `${seed}-${data.version}-${codeHash}`;
const work = resolve(out, ".work", renderId),
  cores = resolve(work, "cores"),
  publish = resolve(work, "publish");
const width = data.width,
  height = data.height,
  top = data.worldTop,
  max = maxLevel(width, height);
const worlds = [
  ["middle", 0],
  ["left", -1],
  ["right", 1],
];
if (args.world && !worlds.some(([name]) => name === args.world))
  throw new Error("world must be middle, left or right");
const selected = args.world
  ? worlds.filter(([name]) => name === args.world)
  : worlds;
let serial = 0;
if (selected.length === 3) {
  const ready = await Promise.all(
    selected.map(async ([world]) => {
      try {
        const m = JSON.parse(
          await readFile(resolve(out, world, "manifest.json"), "utf8"),
        );
        return m.complete && m.renderId === renderId;
      } catch {
        return false;
      }
    }),
  );
  if (ready.every(Boolean)) {
    let verified = 0;
    for (const [world] of selected)
      for (let level = 0; level <= max; level++) {
        const size = levelSize(width, height, max, level);
        for (let y = 0; y < Math.ceil(size.height / TILE); y++)
          for (let x = 0; x < Math.ceil(size.width / TILE); x++) {
            if (
              !(await completeFile(
                resolve(
                  out,
                  world,
                  "map_files",
                  String(level),
                  `${x}_${y}.webp`,
                ),
              ))
            )
              throw new Error(
                `Completed bake lost a tile: ${world}/${level}/${x}/${y}`,
              );
            verified++;
          }
      }
    log(
      `already complete: ${verified} verified cached tiles, no generation or rendering`,
    );
    process.exit(0);
  }
}
class Pool {
  constructor(role) {
    this.role = role;
    this.workers = [];
    this.waiting = [];
    this.done = 0;
    this.total = 0;
  }
  async start() {
    await Promise.all(
      Array.from(
        { length: limit },
        () =>
          new Promise((resolveReady, reject) => {
            const worker = new Worker(workerFile, {
              workerData: { role: this.role, root, bundle, entry, snapshot },
              stdout: true,
              stderr: true,
            });
            const state = { worker, logs: "", task: null, ready: false };
            this.workers.push(state);
            for (const stream of [worker.stdout, worker.stderr])
              stream.on("data", (chunk) => {
                state.logs = (state.logs + chunk).slice(-10000);
              });
            const fail = (error) => {
              const e = new Error(`${error}\n${state.logs}`);
              state.task?.reject(e);
              reject(e);
              this.error = e;
              for (const t of this.waiting.splice(0)) t.reject(e);
            };
            worker.on("error", fail);
            worker.on("exit", (code) => {
              if (!this.closing) fail(`Native worker exited (${code})`);
            });
            worker.on("message", (m) => {
              if (m.type === "ready") {
                state.ready = true;
                resolveReady();
                this.pump();
              } else if (m.type === "error") fail(m.error);
              else if (m.type === "done") {
                state.task?.resolve();
                state.task = null;
                this.done++;
                if (this.done % 100 === 0 || this.done === this.total)
                  log(`${this.phase}: ${this.done}/${this.total}`);
                this.pump();
              }
            });
          }),
      ),
    );
  }
  pump() {
    if (this.error) return;
    for (const state of this.workers) {
      if (state.ready && !state.task && this.waiting.length) {
        state.task = this.waiting.shift();
        state.worker.postMessage(state.task.job);
      }
    }
  }
  async run(phase, jobs) {
    this.phase = phase;
    this.done = 0;
    this.total = jobs.length;
    log(`${phase}: ${jobs.length} jobs, ${limit} CPU workers`);
    await Promise.all(
      jobs.map(
        (job) =>
          new Promise((resolve, reject) => {
            this.waiting.push({ job, resolve, reject });
            this.pump();
          }),
      ),
    );
  }
  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((s) => s.worker.terminate()));
  }
}
async function pending(jobs) {
  const checks = await Promise.all(
    jobs.map(async (j) => ((await completeFile(j.path)) ? null : j)),
  );
  return checks.filter(Boolean);
}
let pool = new Pool("render");
try {
  await pool.start();
  const tasks = [];
  for (const [world, pw] of selected)
    for (let ty = 0; ty < Math.ceil(height / TILE); ty++)
      for (let tx = 0; tx < Math.ceil(width / TILE); tx++) {
        const shape = coreShape(width, height, tx, ty);
        tasks.push({
          kind: "render",
          id: serial++,
          world,
          pw,
          tx,
          ty,
          level: max,
          x: -width / 2 + pw * width + tx * TILE,
          y: top + ty * TILE,
          ...shape,
          path: corePath(cores, world, max, tx, ty),
        });
      }
  await pool.run(
    "full-resolution terrain + backgrounds + decorations",
    await pending(tasks),
  );
  await pool.close();
  pool = new Pool("pyramid");
  await pool.start();
  for (let level = max - 1; level >= 0; level--) {
    const size = levelSize(width, height, max, level),
      child = levelSize(width, height, max, level + 1),
      tasks = [];
    for (const [world] of selected)
      for (let ty = 0; ty < Math.ceil(size.height / TILE); ty++)
        for (let tx = 0; tx < Math.ceil(size.width / TILE); tx++)
          tasks.push({
            kind: "parent",
            id: serial++,
            world,
            cores,
            tx,
            ty,
            level,
            ...coreShape(size.width, size.height, tx, ty),
            childWidth: child.width,
            childHeight: child.height,
            path: corePath(cores, world, level, tx, ty),
          });
    await pool.run(`mip level ${level}`, await pending(tasks));
  }
  let totalFiles = 0;
  for (let level = max; level >= 0; level--) {
    const size = levelSize(width, height, max, level),
      tasks = [];
    for (const [world] of selected)
      for (let ty = 0; ty < Math.ceil(size.height / TILE); ty++)
        for (let tx = 0; tx < Math.ceil(size.width / TILE); tx++)
          tasks.push({
            kind: "overlap",
            id: serial++,
            world,
            cores,
            tx,
            ty,
            level,
            levelWidth: size.width,
            levelHeight: size.height,
            path: resolve(
              publish,
              world,
              "map_files",
              String(level),
              `${tx}_${ty}.webp`,
            ),
          });
    totalFiles += tasks.length;
    await pool.run(`lossless DZI level ${level}`, await pending(tasks));
  }
  for (const [world, pw] of selected) {
    let verified = 0;
    for (let level = 0; level <= max; level++) {
      const size = levelSize(width, height, max, level);
      for (let ty = 0; ty < Math.ceil(size.height / TILE); ty++)
        for (let tx = 0; tx < Math.ceil(size.width / TILE); tx++) {
          if (
            !(await completeFile(
              resolve(
                publish,
                world,
                "map_files",
                String(level),
                `${tx}_${ty}.webp`,
              ),
            ))
          )
            throw new Error(`Incomplete ${world} tile ${level}/${tx}/${ty}`);
          verified++;
        }
    }
    const minX = -width / 2 + pw * width;
    const descriptor = {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Format: "webp",
        Overlap: OVERLAP,
        TileSize: TILE,
        Size: { Width: width, Height: height },
        TopLeft: { X: minX, Y: top },
      },
    };
    const manifest = {
      seed,
      world,
      renderId,
      baked: true,
      terrainVersion: data.version,
      complete: true,
      tileCount: verified,
      generatedAt: new Date().toISOString(),
      regions: [
        { pw, dzi: "map.dzi", minX, minY: top, fullW: width, fullH: height },
      ],
    };
    const metadata = {
      ...data.metadata,
      parallelWorlds: [pw],
      poisByPW: Object.fromEntries(
        Object.entries(data.metadata.poisByPW).filter(
          ([key]) => Number(key.split(",")[0]) === pw,
        ),
      ),
      pixelScenesByPW: Object.fromEntries(
        Object.entries(data.metadata.pixelScenesByPW).filter(
          ([key]) => Number(key.split(",")[0]) === pw,
        ),
      ),
    };
    await atomicWrite(
      resolve(publish, world, "map.dzi"),
      JSON.stringify(descriptor),
    );
    await atomicWrite(
      resolve(publish, world, "generation.json"),
      JSON.stringify(metadata),
    );
    await atomicWrite(
      resolve(publish, world, "manifest.json"),
      JSON.stringify(manifest),
    );
  }
  // No deployable files are replaced until ALL requested tile trees validate.
  for (const [world] of selected) {
    const target = resolve(out, world);
    await rm(target, { recursive: true, force: true });
    await rename(resolve(publish, world), target);
  }
  if (selected.length === 3)
    await atomicWrite(resolve(out, "seed.txt"), String(seed) + "\n");
  log(
    `COMPLETE: ${selected.length} worlds, all vertical planes, ${totalFiles} lossless DZI tiles; seed ${seed}`,
  );
} finally {
  await pool.close();
}
