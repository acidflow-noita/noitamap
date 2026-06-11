#!/usr/bin/env node
/**
 * Drive the noita-mapcap `stitch` Go binary over the 9 full-resolution biome
 * region images produced by build-daily-seed-images.cjs, producing 9 DZI
 * pyramids grouped by parallel world. Each world's subdir is a self-contained
 * deploy root for one CF Static Assets worker.
 *
 * INPUT
 *   <in>/manifest.json                          (per-region bounds + filenames)
 *   <in>/full/dynamic-daily-<minX>-<minY>.png
 *
 * OUTPUT (overwritten each run; same paths every day so URLs stay stable)
 *   <out>/<world>/dynamic-daily-<minX>-<minY>.dzi
 *   <out>/<world>/dynamic-daily-<minX>-<minY>_files/<level>/<iX>_<iY>.webp
 *   <out>/<world>/manifest.json                 (DZIs in this world + their bounds)
 *
 * <world> is derived from `pw`: 0 -> middle, <0 -> left, >0 -> right.
 * Each world holds 3 DZIs (heaven/main/hell) -> ~12k files, comfortably under
 * the 20k Static Assets per-worker file limit.
 *
 * stitch CONTRACT
 *   - Filename regex inside <input>: ^(-?\d+),(-?\d+)\.png$ (COMMA). Our PNGs
 *     use a different naming, so each region is *linked or copied* into its
 *     own private temp dir under the comma name before invocation.
 *   - A tile occupies world rect [X, X+w) x [Y, Y+h), where w/h are the PNG's
 *     pixel dimensions. Our 10x fulls are 1:1 with world units, so per region:
 *       --xmin <minX> --ymin <minY> --xmax <minX+pad512(fullW)> --ymax <minY+pad512(fullH)>
 *     (bounds padded up to 512-multiples; see comment at stitchArgs)
 *
 * USAGE
 *   node build_scripts/stitch-dzis.cjs --out /out
 *   Flags:
 *     --in=<dir>      input dir (default ../optional_data; expects manifest.json + full/)
 *     --out=<dir>     output dir (default <in>/dzi)
 *     --stitch=<bin>  path to stitch (default "stitch" on PATH)
 *     --webp-level=N  WebP lossless effort 0-9 (default 0; output is always lossless,
 *                     N controls encode speed vs file size: 0 = fast/largest, 9 = slow/smallest)
 *     --concurrency=N regions stitched in parallel (default 4, or env STITCH_CONCURRENCY).
 *                     Each stitch peaks at ~3.2 GB; size to host RAM.
 *     --force         re-stitch regions whose .dzi already exists
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const fmt = (ms) => (ms / 1000).toFixed(1) + "s";

const pad512 = (v) => Math.ceil(v / 512) * 512;

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
  // Region-level parallelism. Each stitch process holds ~3.2 GB while encoding.
  // After the biome-baker stitch patch (BlendMethodFast on single-tile inputs)
  // the per-process mutex contention is gone, so running all 9 regions
  // concurrently is the fastest setting on a beefy host. Default 9 = max
  // concurrency for our 9 regions; lower it for tighter RAM budgets.
  // 9 * 3.2 GB ≈ 29 GB peak — fits easily on saas-linux-large-amd64 (32 GB)
  // and trivially on 2xlarge (128 GB). On free GHA (16 GB) keep this at 2.
  const concurrency = Math.max(1, parseInt(args.concurrency || process.env.STITCH_CONCURRENCY || "9", 10));

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

  // One task per region. Each task does its own filesystem prep, runs stitch
  // async via spawn, and prints a single grouped block to stdout when done so
  // concurrent stitches don't interleave their progress lines.
  // Per-world subdirs (left/middle/right) so each is its own deploy root for
  // a CF Static Assets worker. World is decided by `pw`: 0=middle, -1=left,
  // 1=right. Files within a world (heaven/main/hell) live together.
  const worldFor = (pw) => (pw === 0 ? "middle" : pw < 0 ? "left" : "right");
  const tasks = manifest.regions.map((r) => ({
    r,
    world: worldFor(r.pw),
    baseName: `dynamic-daily-${r.minX}-${r.minY}`,
  }));

  const runRegion = async ({ r, world, baseName }) => {
    const src = path.join(fullDir, r.file);
    if (!fs.existsSync(src)) {
      console.warn(`[stitch] missing ${src}; skipping pw=${r.pw} pvt=${r.pvt}`);
      return { ok: false, skipped: true };
    }
    const worldDir = path.join(outDir, world);
    fs.mkdirSync(worldDir, { recursive: true });
    const outPath = path.join(worldDir, `${baseName}.dzi`);
    const filesDir = path.join(worldDir, `${baseName}_files`);

    // Resumability: skip regions whose DZI already exists from a prior run.
    if (!force && fs.existsSync(outPath) && fs.existsSync(filesDir)) {
      console.log(`[stitch] checkpoint: ${baseName}.dzi exists, skipping (pass --force to redo)`);
      return { ok: true, checkpoint: true };
    }

    // stitch's input glob expects "<X>,<Y>.png" (comma). One private dir per
    // region so the *.png glob matches exactly one tile and the regex doesn't
    // panic on our hyphen-prefixed filename.
    const regionTmp = path.join(tmpRoot, `r${r.minX}_${r.minY}`);
    fs.mkdirSync(regionTmp, { recursive: true });
    const tileName = `${r.minX},${r.minY}.png`;
    try { fs.linkSync(src, path.join(regionTmp, tileName)); }
    catch { fs.copyFileSync(src, path.join(regionTmp, tileName)); }

    fs.rmSync(filesDir, { recursive: true, force: true });

    const stitchArgs = [
      "--input", regionTmp,
      "--output", outPath,
      "--blend-tile-limit", "1",
      "--dzi-tile-size", "512",
      "--webp-level", webpLevel,
      // Pad the output canvas up to a multiple of 512 (right/bottom only;
      // minX/minY stay the OSD anchor). The static map DZIs are exact
      // 512-multiples (35840x73728) so every pyramid level halves to integers;
      // our raw bounds (e.g. 32770x24570) make every level odd/ceil()-padded
      // with a 1px ragged last tile column, which renders worse in OSD. The
      // margin is transparent and free: file count is unchanged (65 ragged
      // columns -> 65 exact), and the padded heaven/main/hell slots (24570 ->
      // 24576) abut exactly with no overlap into neighbouring regions.
      "--xmin", String(r.minX),
      "--ymin", String(r.minY),
      "--xmax", String(r.minX + pad512(r.fullW)),
      "--ymax", String(r.minY + pad512(r.fullH)),
    ];

    const t = Date.now();
    // Stream each child's stdout/stderr live, prefixed with a per-region tag,
    // so we get progress visibility during the stitch instead of one batch
    // dump on completion. Concurrent regions interleave but each line is
    // complete (the stitch patch already terminates lines with \n), so it's
    // grep-friendly: e.g. `grep "[middle/main]" log` to follow one region.
    const tag = `[${world}/${r.pvt === -1 ? "heaven" : r.pvt === 1 ? "hell" : "main"}]`;
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
  console.log(`[stitch] running ${queue.length} regions with concurrency=${concurrency}, webp-level=${webpLevel}`);
  try {
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const task = queue.shift();
        const r = await runRegion(task);
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
  // file listing the DZIs it serves + their OSD bounds, so the map fetches one
  // small JSON per world instead of stitching together a global view itself.
  const byWorld = { left: [], middle: [], right: [] };
  for (const r of manifest.regions) {
    const world = worldFor(r.pw);
    const baseName = `dynamic-daily-${r.minX}-${r.minY}`;
    const dziPath = path.join(outDir, world, `${baseName}.dzi`);
    if (!fs.existsSync(dziPath)) continue;
    // Publish the dims the DZI actually has (padded by this run, or whatever
    // a checkpoint-reused older DZI was built with) -- OSD scales the image
    // to the manifest width, so a mismatch would shrink/misalign the layer.
    const img = JSON.parse(fs.readFileSync(dziPath, "utf8")).Image;
    byWorld[world].push({
      pw: r.pw, pvt: r.pvt,
      dzi: `${baseName}.dzi`,
      minX: r.minX, minY: r.minY,
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
