#!/usr/bin/env node
/** Real-artifact checks after biome-baker's entrypoint, without a browser.
 * This verifies the bake/decoder/pyramid, not general engine geometry accuracy. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { strict as assert } from "node:assert";
import JSZip from "jszip";
import { decode } from "fast-png";
import sharp from "sharp";
import { SCENE_BACKGROUNDS } from "../../lib/noita-telescope-vm/js/pixel_scene_backgrounds.js";
const root = fileURLToPath(new URL("../..", import.meta.url));
if (!process.argv[2])
  throw new Error(
    "Usage: node tests/helpers/verify-native-daily-bake.mjs /path/to/bake",
  );
const bake = resolve(process.argv[2]),
  out = resolve(bake, "verification");
await mkdir(out, { recursive: true });
const snapshot = deserialize(await readFile(resolve(bake, "generation.bin")));
const zip = await JSZip.loadAsync(
  await readFile(resolve(root, "public/data.zip")),
);
const report = {
  seed: snapshot.seed,
  version: snapshot.version,
  backgroundAssets: [],
  samples: [],
  mipTiles: 0,
  overlapPairs: 0,
  elevatorTiles: 0,
};
const normalize = (data) => {
  data = Buffer.from(data);
  for (let i = 0; i < data.length; i += 4)
    if (!data[i + 3]) data.fill(0, i, i + 4);
  return data;
};
const worldName = (pw) => ({ "-1": "left", 0: "middle", 1: "right" })[pw];
const jobs = new Map();
function addSample(x, y, reason) {
  const pw = Math.floor((x + 17920) / 35840),
    world = worldName(pw);
  assert(world, `sample outside baked parallel worlds: ${x},${y}`);
  const tx = Math.floor((x + 17920 - pw * 35840) / 512),
    ty = Math.floor((y + 31744) / 512);
  assert(ty >= 0 && ty < 144);
  const key = `${world}-${tx}_${ty}`;
  jobs.set(key, {
    kind: "render",
    id: jobs.size,
    world,
    tx,
    ty,
    reason,
    x: tx * 512 - 17920 + pw * 35840,
    y: ty * 512 - 31744,
    width: 512,
    height: 512,
    path: resolve(out, `${key}-native.png`),
  });
}
for (const [key, source] of Object.entries(snapshot.sceneData.sources)) {
  if (!source.backgroundArt) continue;
  const bgPath =
    SCENE_BACKGROUNDS[key] ??
    (key.startsWith("snowcastle_cavern/")
      ? SCENE_BACKGROUNDS[key.replace("snowcastle_cavern/", "snowcastle/")]
      : null);
  assert(bgPath, `missing background provenance: ${key}`);
  const bytes = await zip
    .file(bgPath.replace("data/backgrounds/", "data/"))
    .async("uint8array");
  // Decode authored PNG samples independently, without Photoshop ICC conversion.
  const native = await sharp(bytes, { ignoreIcc: true })
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert(
    normalize(source.backgroundArt.data).equals(normalize(native)),
    `serialized background differs from native PNG: ${key}`,
  );
  const png = decode(bytes),
    keyed = (png.transparency?.length ?? 0) > 0;
  report.backgroundAssets.push({
    key,
    keyed,
    width: source.backgroundArt.width,
    height: source.backgroundArt.height,
  });
  if (!keyed) continue;
  for (const pw of [-1, 0, 1]) {
    const scene = snapshot.sceneData.scenes.find(
      (s) =>
        s.key === key &&
        Math.floor((s.x + 17920) / 35840) === pw &&
        s.y >= -7168 &&
        s.y < 17408,
    );
    if (scene) addSample(scene.x, scene.y, key);
  }
}
assert(
  report.backgroundAssets.some((a) => a.key.includes("plantlife") && a.keyed),
  "daily fixture did not exercise the reported plantlife background",
);
for (const pw of [-1, 0, 1])
  for (const plane of [-1, 0, 1])
    addSample(pw * 35840, 512 + plane * 24576, "coalmine/vertical-plane");
for (const shaft of snapshot.planes["1"].elevatorShafts ?? []) {
  assert.equal(shaft.biomeName, "robobase");
  assert.equal(shaft.validChunks.length, 49);
  for (const pw of [-1, 0, 1])
    for (let row = 0; row < 48; row++)
      addSample(
        shaft.minX * 512 - 17920 + pw * 35840,
        17408 + row * 512,
        "elevator-continuation",
      );
}
const shaftTexture = await sharp(
  await zip
    .file("data/weather_gfx/background_robobase.png")
    .async("uint8array"),
  { ignoreIcc: true },
)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const allJobs = [...jobs.values()].map((job, id) => ({ ...job, id }));
const worker = new Worker(
  new URL("../../build_scripts/native-terrain-worker.mjs", import.meta.url),
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
    let next = 0,
      done = false;
    const timer = setTimeout(
      () => finish(new Error("Native verification timed out")),
      180000,
    );
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? rej(error) : res();
    };
    worker.on("error", finish);
    worker.on("exit", (code) => {
      if (!done) finish(new Error(`Native renderer exited early: ${code}`));
    });
    worker.on("message", (m) => {
      if (m.type === "error") {
        finish(new Error(m.error));
        return;
      }
      if (!["ready", "done"].includes(m.type)) return;
      if (next === allJobs.length) finish();
      else worker.postMessage(allJobs[next++]);
    });
  });
} finally {
  await worker.terminate();
}
async function tile(world, level, tx, ty) {
  const bytes = await readFile(
    resolve(bake, world, `map_files/${level}/${tx}_${ty}.webp`),
  );
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  // Lossless WebP contains VP8L, never the lossy VP8 image chunk.
  let lossless = false;
  for (let i = 12; i + 8 <= bytes.length;) {
    const chunk = bytes.toString("ascii", i, i + 4),
      len = bytes.readUInt32LE(i + 4);
    assert.notEqual(chunk, "VP8 ", `lossy tile ${world}/${level}/${tx}_${ty}`);
    if (chunk === "VP8L") lossless = true;
    i += 8 + len + (len & 1);
  }
  assert(lossless);
  const scale = 2 ** (17 - level),
    w = Math.ceil(35840 / scale),
    h = Math.ceil(73728 / scale);
  const coreWidth = Math.min(512, w - tx * 512),
    coreHeight = Math.min(512, h - ty * 512);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const left = tx ? 2 : 0,
    top = ty ? 2 : 0;
  assert.equal(
    info.width,
    coreWidth + left + (tx * 512 + coreWidth < w ? 2 : 0),
  );
  assert.equal(
    info.height,
    coreHeight + top + (ty * 512 + coreHeight < h ? 2 : 0),
  );
  const core = Buffer.alloc(coreWidth * coreHeight * 4);
  for (let y = 0; y < coreHeight; y++)
    data.copy(
      core,
      y * coreWidth * 4,
      ((y + top) * info.width + left) * 4,
      ((y + top) * info.width + left + coreWidth) * 4,
    );
  return {
    core: normalize(core),
    data: normalize(data),
    width: info.width,
    height: info.height,
    coreWidth,
    coreHeight,
    left,
    top,
  };
}
for (const job of allJobs) {
  const image = await tile(job.world, 17, job.tx, job.ty),
    expected = await sharp(job.path).ensureAlpha().raw().toBuffer();
  assert(
    image.core.equals(normalize(expected)),
    `published final pixels differ from native renderer: ${job.reason} ${job.world}/${job.tx}_${job.ty}`,
  );
  if (job.reason === "elevator-continuation") {
    let solid = 0;
    const tw = shaftTexture.info.width,
      th = shaftTexture.info.height;
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const i = (y * 512 + x) * 4;
        const tx = (((job.x + x + 17920) % tw) + tw) % tw,
          ty = (((job.y + y - 17408) % th) + th) % th;
        const t = (ty * tw + tx) * 4;
        if (
          image.core[i + 3] &&
          (image.core[i] !== shaftTexture.data[t] ||
            image.core[i + 1] !== shaftTexture.data[t + 1] ||
            image.core[i + 2] !== shaftTexture.data[t + 2])
        )
          solid++;
      }
    assert(
      solid > 1024,
      `Background-only elevator chunk ${job.world}/${job.tx}_${job.ty}: ${solid} terrain pixels`,
    );
    report.elevatorTiles++;
  }
  report.samples.push({
    world: job.world,
    tile: [job.tx, job.ty],
    reason: job.reason,
  });
  if (job.tx < 69) {
    const right = await tile(job.world, 17, job.tx + 1, job.ty);
    for (let y = 0; y < image.height; y++)
      assert(
        image.data
          .subarray(
            (y * image.width + image.width - 4) * 4,
            (y * image.width + image.width) * 4,
          )
          .equals(
            right.data.subarray(y * right.width * 4, (y * right.width + 4) * 4),
          ),
        `overlap mismatch ${job.world}/${job.tx}_${job.ty}`,
      );
    report.overlapPairs++;
  }
}
// Verify selected published parents against the actual four lossless leaves.
for (const world of ["left", "middle", "right"])
  for (const ty of [7, 31, 55]) {
    const tx = 17,
      parent = await tile(world, 16, tx, ty),
      children = [];
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        children.push(await tile(world, 17, tx * 2 + dx, ty * 2 + dy));
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const child = children[Math.floor(y / 256) * 2 + Math.floor(x / 256)],
          sx = (x % 256) * 2,
          sy = (y % 256) * 2;
        const sums = [0, 0, 0];
        let alpha = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const p = ((sy + dy) * 512 + sx + dx) * 4,
              a = child.core[p + 3];
            alpha += a;
            for (let c = 0; c < 3; c++) sums[c] += child.core[p + c] * a;
          }
        const i = (y * 512 + x) * 4,
          outAlpha = Math.round(alpha / 4);
        assert.equal(
          parent.core[i + 3],
          outAlpha,
          "parent alpha does not preserve final pixels",
        );
        for (let c = 0; c < 3; c++)
          assert.equal(
            parent.core[i + c],
            outAlpha ? Math.round(sums[c] / alpha) : 0,
            "parent color does not preserve final pixels",
          );
      }
    report.mipTiles++;
  }
await writeFile(
  resolve(out, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Verified seed ${snapshot.seed} ${snapshot.version}: ${report.backgroundAssets.length} native-decoded backgrounds, ${allJobs.length} published final-pixel tiles, ${report.mipTiles} mip tiles, ${report.overlapPairs} overlap pairs, ${report.elevatorTiles} continuous elevator tiles`,
);
