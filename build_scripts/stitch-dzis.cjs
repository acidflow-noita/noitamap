#!/usr/bin/env node
/**
 * Drive the noita-mapcap `stitch` Go binary over the full-resolution biome
 * region images produced by build-daily-seed-images.cjs, producing ONE merged
 * DZI per parallel world (heaven+main+hell on a single canvas; regions are
 * padded to exact 24576-tall slots so they abut gap-free). One TiledImage per
 * world in OSD = no internal seams to shimmer at zoom. Each world's subdir is
 * a self-contained deploy root for one CF Static Assets worker.
 *
 * INPUT
 *   <in>/manifest.json                          (per-region bounds + filenames)
 *   <in>/full/dynamic-daily-<minX>-<minY>.png
 *   <in>/generation.json                        (optional; POIs/scenes/biome map)
 *
 * OUTPUT (overwritten each run; same paths every day so URLs stay stable)
 *   <out>/<world>/dynamic-daily-<world>.dzi
 *   <out>/<world>/dynamic-daily-<world>_files/<level>/<iX>_<iY>.webp
 *   <out>/<world>/manifest.json                 (one region entry: the merged DZI)
 *   <out>/<world>/generation.json               (per-world POI/scene slice)
 *
 * <world> is derived from `pw`: 0 -> middle, <0 -> left, >0 -> right.
 * A merged world pyramid is ~12.5k files, comfortably under the 20k Static
 * Assets per-worker file limit.
 *
 * stitch CONTRACT
 *   - Filename regex inside <input>: ^(-?\d+),(-?\d+)\.png$ (COMMA). Each
 *     world's regions are linked/copied into a private temp dir under their
 *     world-coordinate comma names.
 *   - A tile occupies world rect [X, X+w) x [Y, Y+h), where w/h are the PNG's
 *     pixel dimensions. Our 10x fulls are 1:1 with world units; bounds are the
 *     exact union of the world's slot-padded regions, so no canvas pixel is
 *     left uncovered (uncovered = zero-filled = renders black).
 *
 * USAGE
 *   node build_scripts/stitch-dzis.cjs --out /out
 *   Flags:
 *     --in=<dir>      input dir (default ../optional_data; expects manifest.json + full/)
 *     --out=<dir>     output dir (default <in>/dzi)
 *     --stitch=<bin>  path to stitch (default "stitch" on PATH)
 *     --webp-level=N  WebP lossless effort 0-9 (default 0; output is always lossless,
 *                     N controls encode speed vs file size: 0 = fast/largest, 9 = slow/smallest)
 *     --concurrency=N worlds stitched in parallel (default 3, or env STITCH_CONCURRENCY).
 *                     Each merged-world stitch peaks at ~10-12 GB; size to host RAM.
 *     --force         re-stitch worlds whose .dzi already exists
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const fmt = (ms) => (ms / 1000).toFixed(1) + "s";

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) { out[a] = "true"; continue; }
    const key = m[1];
    if (m[2] !== undefined) { out[key] = m[2]; continue; }
    // --key (no =): consume next arg as value if it isn't another flag.
    const next = argv[i + 1];
    if (next !== undefined && !/^--/.test(next)) { out[key] = next; i++; }
    else { out[key] = "true"; }
  }
  return out;
}

async function main() {
  const START = Date.now();
  const args = parseArgs();
  const inDir = args.in ? path.resolve(args.in) : path.join(ROOT, "optional_data");
  const outDir = args.out ? path.resolve(args.out) : path.join(inDir, "dzi");
  const stitchBin = args.stitch || "stitch";
  // WebP lossless effort. 0 = fast/largest, 9 = slow/smallest. Output is
  // bit-exact lossless at every level — only encode time and file size differ.
  const webpLevel = args["webp-level"] !== undefined ? String(parseInt(args["webp-level"], 10)) : "0";
  // World-level parallelism. Each merged-world stitch holds the full
  // 32770x73728 RGBA canvas (~9.7 GB) plus encode overhead, so budget
  // ~10-12 GB per process. Default 3 = all worlds in parallel (~35 GB peak),
  // which fits saas-linux-2xlarge (128 GB) easily and saas-linux-large
  // (32 GB) tightly. On 16 GB hosts run 1 at a time.
  const concurrency = Math.max(1, parseInt(args.concurrency || process.env.STITCH_CONCURRENCY || "3", 10));

  const manifestPath = path.join(inDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`[stitch] missing ${manifestPath}. Run build-daily-seed-images.cjs first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const fullDir = path.join(inDir, "full");
  if (!fs.existsSync(fullDir)) {
    console.error(`[stitch] missing ${fullDir}.`);
    process.exit(1);
  }

  // Verify the binary exists / is callable up front (clearer than per-region failure).
  try {
    execFileSync(stitchBin, ["-h"], { stdio: "pipe" });
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error(`[stitch] '${stitchBin}' not found on PATH. Pass --stitch=<path> or install the binary.`);
      process.exit(1);
    }
    // stitch -h returns non-zero on some builds; tolerate as long as it ran.
    if (e.status === undefined && e.signal === undefined) {
      console.error(`[stitch] failed to execute '${stitchBin}': ${e.message}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  const force = !!args["force"];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));

  // One task per WORLD: the world's heaven/main/hell region PNGs (padded to
  // exact 24576-tall slots by build-daily-seed-images) are stitched into a
  // SINGLE DZI. One TiledImage per world in OSD means no internal seams to
  // shimmer at zoom and a third of the layer count. World is decided by `pw`:
  // 0=middle, <0=left, >0=right. Each world subdir is a self-contained deploy
  // root for one CF Static Assets worker.
  const worldFor = (pw) => (pw === 0 ? "middle" : pw < 0 ? "left" : "right");
  const byWorldRegions = { left: [], middle: [], right: [] };
  for (const r of manifest.regions) byWorldRegions[worldFor(r.pw)].push(r);
  const tasks = Object.entries(byWorldRegions)
    .filter(([, rs]) => rs.length > 0)
    .map(([world, rs]) => ({ world, regions: rs, baseName: `dynamic-daily-${world}` }));

  const runWorld = async ({ world, regions, baseName }) => {
    const present = regions.filter((r) => {
      if (fs.existsSync(path.join(fullDir, r.file))) return true;
      console.warn(`[stitch] missing ${r.file}; ${world} will have a hole at pvt=${r.pvt}`);
      return false;
    });
    if (present.length === 0) {
      console.warn(`[stitch] no region PNGs for ${world}; skipping`);
      return { ok: false, skipped: true };
    }
    const worldDir = path.join(outDir, world);
    fs.mkdirSync(worldDir, { recursive: true });
    const outPath = path.join(worldDir, `${baseName}.dzi`);
    const filesDir = path.join(worldDir, `${baseName}_files`);

    // Resumability: skip worlds whose DZI already exists from a prior run.
    if (!force && fs.existsSync(outPath) && fs.existsSync(filesDir)) {
      console.log(`[stitch] checkpoint: ${baseName}.dzi exists, skipping (pass --force to redo)`);
      return { ok: true, checkpoint: true };
    }

    // stitch's input glob expects "<X>,<Y>.png" (comma). One private dir per
    // world; each region links in under its world coordinates so the stitcher
    // composes all three onto one canvas.
    const worldTmp = path.join(tmpRoot, `w_${world}`);
    fs.mkdirSync(worldTmp, { recursive: true });
    for (const r of present) {
      const tileName = `${r.minX},${r.minY}.png`;
      const src = path.join(fullDir, r.file);
      try { fs.linkSync(src, path.join(worldTmp, tileName)); }
      catch { fs.copyFileSync(src, path.join(worldTmp, tileName)); }
    }

    fs.rmSync(filesDir, { recursive: true, force: true });

    // Bounds = exact union of the slot-padded region PNGs. Regions abut
    // exactly (24576-tall slots), so the canvas has zero uncovered
    // (zero-filled -> renders black) pixels.
    const minX = Math.min(...present.map((r) => r.minX));
    const minY = Math.min(...present.map((r) => r.minY));
    const maxX = Math.max(...present.map((r) => r.minX + r.fullW));
    const maxY = Math.max(...present.map((r) => r.minY + r.fullH));
    const stitchArgs = [
      "--input", worldTmp,
      "--output", outPath,
      "--blend-tile-limit", "1",
      "--dzi-tile-size", "512",
      "--webp-level", webpLevel,
      "--xmin", String(minX),
      "--ymin", String(minY),
      "--xmax", String(maxX),
      "--ymax", String(maxY),
    ];

    const t = Date.now();
    // Stream each child's stdout/stderr live, prefixed with a per-world tag,
    // so we get progress visibility during the stitch instead of one batch
    // dump on completion. Concurrent worlds interleave but each line is
    // complete (the stitch patch already terminates lines with \n), so it's
    // grep-friendly: e.g. `grep "[middle]" log` to follow one world.
    const tag = `[${world}]`;
    const child = spawn(stitchBin, stitchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const prefixStream = (stream) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) process.stdout.write(`${tag} ${line}\n`);
      });
      stream.on("end", () => {
        if (pending) process.stdout.write(`${tag} ${pending}\n`);
      });
    };
    prefixStream(child.stdout);
    prefixStream(child.stderr);

    const result = await new Promise((res) => {
      child.on("error", (e) => res({ error: e }));
      child.on("close", (code, sig) => res({ status: code, signal: sig }));
    });

    if (result.error) {
      console.error(`${tag} [stitch] failed to spawn on ${baseName}: ${result.error.message}`);
      return { ok: false };
    }
    if (result.status !== 0) {
      const sig = result.signal ? ` signal=${result.signal}` : "";
      const code = result.status === null ? "null" : String(result.status);
      const hint = result.signal === "SIGKILL" ? " (likely OOM-killed by host kernel; lower STITCH_CONCURRENCY)" : "";
      console.error(`${tag} [stitch] failed on ${baseName}: status=${code}${sig}${hint}`);
      return { ok: false };
    }
    console.log(`${tag} [stitch] ${baseName} done in ${fmt(Date.now() - t)}`);
    return { ok: true };
  };

  // Concurrency-limited pool. Pulls off the queue as workers free up.
  let count = 0;
  const queue = tasks.slice();
  console.log(`[stitch] running ${queue.length} worlds with concurrency=${concurrency}, webp-level=${webpLevel}`);
  try {
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        const r = await runWorld(task);
        if (r.ok) count++;
      }
    });
    await Promise.all(workers);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (count === 0) {
    console.error(`[stitch] produced 0 DZIs (total ${fmt(Date.now() - START)})`);
    process.exit(1);
  }

  // Per-world manifest: each CF Static Assets worker carries its own pointer
  // file listing the DZI it serves + its OSD bounds, so the map fetches one
  // small JSON per world instead of stitching together a global view itself.
  // One merged DZI per world = one region entry spanning heaven+main+hell.
  const byWorld = { left: [], middle: [], right: [] };
  for (const { world, regions, baseName } of tasks) {
    const dziPath = path.join(outDir, world, `${baseName}.dzi`);
    if (!fs.existsSync(dziPath)) continue;
    // Publish the dims the DZI actually has (this run's, or whatever a
    // checkpoint-reused older DZI was built with) -- OSD scales the image
    // to the manifest width, so a mismatch would shrink/misalign the layer.
    const img = JSON.parse(fs.readFileSync(dziPath, "utf8")).Image;
    byWorld[world].push({
      pw: regions[0].pw,
      dzi: `${baseName}.dzi`,
      minX: Math.min(...regions.map((r) => r.minX)),
      minY: Math.min(...regions.map((r) => r.minY)),
      fullW: Number(img.Size.Width), fullH: Number(img.Size.Height),
    });
  }
  for (const [world, regions] of Object.entries(byWorld)) {
    if (regions.length === 0) continue;
    const m = { seed: manifest.seed, generatedAt: manifest.generatedAt, world, regions };
    fs.writeFileSync(path.join(outDir, world, "manifest.json"), JSON.stringify(m, null, 2));
  }

  // Per-world generation.json (POIs, pixel scenes, biome map) so the live map
  // renders the daily without running telescope. Keys in poisByPW /
  // pixelScenesByPW are "pw,pvt"; slice by which world that pw belongs to.
  const genPath = path.join(inDir, "generation.json");
  if (fs.existsSync(genPath)) {
    const gen = JSON.parse(fs.readFileSync(genPath, "utf8"));
    const sliceByWorld = (obj, world) =>
      Object.fromEntries(Object.entries(obj || {}).filter(([k]) => worldFor(parseInt(k, 10)) === world));
    for (const [world, regions] of Object.entries(byWorld)) {
      if (regions.length === 0) continue;
      fs.writeFileSync(
        path.join(outDir, world, "generation.json"),
        JSON.stringify({
          ...gen,
          parallelWorlds: (gen.parallelWorlds || []).filter((pw) => worldFor(pw) === world),
          poisByPW: sliceByWorld(gen.poisByPW, world),
          pixelScenesByPW: sliceByWorld(gen.pixelScenesByPW, world),
        }),
      );
    }
    console.log(`[stitch] wrote per-world generation.json (baked POIs)`);
  } else {
    console.warn(`[stitch] no ${genPath} — POIs will fall back to client-side telescope`);
  }

  console.log(`[stitch] done: ${count} DZIs -> ${outDir}  (total ${fmt(Date.now() - START)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
