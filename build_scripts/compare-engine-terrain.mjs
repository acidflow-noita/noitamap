#!/usr/bin/env node
/** Offline native-vs-capture comparison. No browser and no capture rescaling.
 * Raw RGB differences are recorded, not excused. This is a diagnostic, not an
 * accuracy pass: the captured engine geometry is the authoritative reference. */
import { Worker } from "node:worker_threads";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import sharp from "sharp";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [key, ...values] = a.replace(/^--/, "").split("=");
    return [key, values.length ? values.join("=") : true];
  }),
);
if (!args.bake)
  throw new Error(
    "Usage: node build_scripts/compare-engine-terrain.mjs --bake=/path/to/prepared-bake [--out=/path/to/report]",
  );
const bake = resolve(String(args.bake));
const out = resolve(String(args.out || resolve(bake, "engine-comparison")));
const manifest = JSON.parse(
  await readFile(
    resolve(root, "tests/fixtures/terrain/engine-reference.json"),
    "utf8",
  ),
);
const snapshot = deserialize(await readFile(resolve(bake, "generation.bin")));
if (snapshot.seed !== manifest.seed)
  throw new Error(
    `The reference capture uses seed ${manifest.seed}, not ${snapshot.seed}`,
  );
await mkdir(out, { recursive: true });
const jobs = manifest.samples.flatMap((sample) =>
  sample.planes.map((plane) => {
    const [cx, cy] = sample.chunk;
    return {
      kind: "render",
      name: `${sample.name}-${plane}`,
      plane,
      chunk: sample.chunk,
      x: cx * 512 - 17920,
      y: cy * 512 - 7168 + plane * 24576,
      width: 512,
      height: 512,
      tileX: cx,
      tileY: 48 + cy + plane * 48,
    };
  }),
);
if (args.published) {
  const manifest = JSON.parse(
    await readFile(resolve(bake, "middle/manifest.json"), "utf8"),
  );
  if (
    !manifest.complete ||
    manifest.seed !== snapshot.seed ||
    manifest.terrainVersion !== snapshot.version
  )
    throw new Error(
      "Published DZI manifest is incomplete or does not match this generation",
    );
  for (const job of jobs) {
    await sharp(
      resolve(bake, `middle/map_files/17/${job.tileX}_${job.tileY}.webp`),
    )
      .extract({
        left: job.tileX ? 2 : 0,
        top: job.tileY ? 2 : 0,
        width: 512,
        height: 512,
      })
      .png()
      .toFile(resolve(out, `${job.name}-generated.png`));
  }
} else {
  // One renderer process; tiles use the EXACT same code and decorations as bake.
  const worker = new Worker(
    new URL("./native-terrain-worker.mjs", import.meta.url),
    {
      workerData: {
        role: "render",
        root,
        bundle: resolve(bake, "runtime"),
        entry: resolve(bake, "runtime/bake.js"),
        snapshot: resolve(bake, "generation.bin"),
      },
    },
  );
  try {
    await new Promise((res, rej) => {
      let next = 0;
      const timer = setTimeout(
        () => rej(new Error("Native sample rendering timed out")),
        180000,
      );
      worker.on("error", rej);
      worker.on("exit", (code) => {
        if (next <= jobs.length)
          rej(new Error(`Renderer exited unexpectedly (${code})`));
      });
      worker.on("message", (message) => {
        if (message.type === "error") {
          clearTimeout(timer);
          rej(new Error(message.error));
          return;
        }
        if (message.type !== "ready" && message.type !== "done") return;
        if (next === jobs.length) {
          next++;
          clearTimeout(timer);
          res();
          return;
        }
        const job = jobs[next];
        worker.postMessage({
          ...job,
          id: next++,
          path: resolve(out, `${job.name}-generated.png`),
        });
      });
    });
  } finally {
    await worker.terminate();
  }
}
async function reference(base, kind, job) {
  const path = resolve(
    out,
    "reference",
    `${kind}-${job.tileX}_${job.tileY}.webp`,
  );
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    const url = `${base}_files/${manifest.maxLevel}/${job.tileX}_${job.tileY}.webp`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return sharp(bytes)
    .extract({
      left: job.tileX ? 2 : 0,
      top: job.tileY ? 2 : 0,
      width: 512,
      height: 512,
    })
    .ensureAlpha()
    .png()
    .toBuffer();
}
const report = {
  seed: snapshot.seed,
  terrainVersion: snapshot.version,
  testedOutput: args.published
    ? "published DZI pixels"
    : "native renderer samples",
  reference: manifest,
  samples: [],
};
for (const job of jobs) {
  const [engine, underlay] = await Promise.all([
    reference(manifest.regular, "engine", job),
    reference(manifest.staticUnderlay, "static", job),
  ]);
  const generated = await sharp(underlay)
    .composite([{ input: resolve(out, `${job.name}-generated.png`) }])
    .png()
    .toBuffer();
  const a = await sharp(engine).raw().toBuffer(),
    b = await sharp(generated).raw().toBuffer(),
    diff = Buffer.alloc(a.length);
  let different = 0,
    totalError = 0,
    maxError = 0;
  for (let i = 0; i < a.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 3; c++) {
      const error = Math.abs(a[i + c] - b[i + c]);
      changed ||= error > 0;
      totalError += error;
      maxError = Math.max(maxError, error);
      diff[i + c] = error;
    }
    if (changed) different++;
    diff[i + 3] = 255;
  }
  const difference = await sharp(diff, {
    raw: { width: 512, height: 512, channels: 4 },
  })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 1536, height: 512, channels: 4, background: "black" },
  })
    .composite([
      { input: engine, left: 0, top: 0 },
      { input: generated, left: 512, top: 0 },
      { input: difference, left: 1024, top: 0 },
    ])
    .png()
    .toFile(resolve(out, `${job.name}-comparison.png`));
  report.samples.push({
    name: job.name,
    world: [job.x, job.y],
    differentRGBPixels: different,
    totalPixels: 512 * 512,
    exactRGBFraction: 1 - different / (512 * 512),
    meanAbsoluteRGBError: totalError / (512 * 512 * 3),
    maxChannelError: maxError,
  });
  console.log(
    `${job.name}: ${different}/262144 RGB pixels differ; engine | generated+static | absolute difference`,
  );
}
await writeFile(
  resolve(out, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Comparison saved to ${out}. No geometry-accuracy claim is implied by this diagnostic.`,
);
