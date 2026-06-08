#!/usr/bin/env node
/**
 * Drive the noita-mapcap `stitch` Go binary over the 9 full-resolution biome
 * region images produced by build-daily-seed-images.cjs, producing 9 DZI
 * pyramids — one per region — written to a flat output directory. The DZIs
 * later get uploaded to Cloudflare and the live map fetches them by URL.
 *
 * INPUT
 *   <in>/manifest.json                       (per-region bounds + filenames)
 *   <in>/full/dynamic-daily-<minX>-<minY>.png
 *
 * OUTPUT (overwritten each run; same paths every day so URLs stay stable)
 *   <out>/dynamic-daily-<minX>-<minY>.dzi
 *   <out>/dynamic-daily-<minX>-<minY>_files/<level>/<iX>_<iY>.webp
 *
 * stitch CONTRACT
 *   - Filename regex inside <input>: ^(-?\d+),(-?\d+)\.png$ (COMMA, e.g.
 *     "18940,-7168.png"). Our PNGs are named "dynamic-daily-<x>-<y>.png", so
 *     each region is *copied* into its own private temp dir under that comma
 *     name before invocation. stitch's *.png glob then sees exactly one tile
 *     and the regex matches.
 *   - A tile occupies world rect [X, X+w) x [Y, Y+h), where w/h are the PNG's
 *     pixel dimensions. Our 10x fulls are 1:1 with world units, so per region:
 *       --xmin <minX> --ymin <minY> --xmax <minX+fullW> --ymax <minY+fullH>
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
  const tasks = manifest.regions.map((r) => ({
    r,
    baseName: `dynamic-daily-${r.minX}-${r.minY}`,
  }));

  const runRegion = async ({ r, baseName }) => {
    const src = path.join(fullDir, r.file);
    if (!fs.existsSync(src)) {
      console.warn(`[stitch] missing ${src}; skipping pw=${r.pw} pvt=${r.pvt}`);
      return { ok: false, skipped: true };
    }
    const outPath = path.join(outDir, `${baseName}.dzi`);
    const filesDir = path.join(outDir, `${baseName}_files`);

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
      "--xmin", String(r.minX),
      "--ymin", String(r.minY),
      "--xmax", String(r.minX + r.fullW),
      "--ymax", String(r.minY + r.fullH),
    ];

    const t = Date.now();
    const child = spawn(stitchBin, stitchArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.stderr.on("data", (d) => { buf += d.toString(); });

    const result = await new Promise((res) => {
      child.on("error", (e) => res({ error: e }));
      child.on("close", (code, sig) => res({ status: code, signal: sig }));
    });

    // Flush this region's output as one grouped block so concurrent stitches
    // don't interleave their newline-progress lines into noise.
    const header = `\n----- [stitch] pw=${r.pw} pvt=${r.pvt} ${baseName} (${r.fullW}x${r.fullH}) -----`;
    if (result.error) {
      process.stdout.write(`${header}\n${buf}[stitch] failed to spawn on ${baseName}: ${result.error.message}\n`);
      return { ok: false };
    }
    if (result.status !== 0) {
      const sig = result.signal ? ` signal=${result.signal}` : "";
      const code = result.status === null ? "null" : String(result.status);
      const hint = result.signal === "SIGKILL" ? " (likely OOM-killed by host kernel; lower STITCH_CONCURRENCY)" : "";
      process.stdout.write(`${header}\n${buf}[stitch] failed on ${baseName}: status=${code}${sig}${hint}\n`);
      return { ok: false };
    }
    process.stdout.write(`${header}\n${buf}[stitch] ${baseName} done in ${fmt(Date.now() - t)}\n`);
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
  console.log(`[stitch] done: ${count} DZIs -> ${outDir}  (total ${fmt(Date.now() - START)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
