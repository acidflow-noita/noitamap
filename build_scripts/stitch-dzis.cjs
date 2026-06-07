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
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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
  let count = 0, skipped = 0;
  try {
    for (const r of manifest.regions) {
      const src = path.join(fullDir, r.file);
      if (!fs.existsSync(src)) {
        console.warn(`[stitch] missing ${src}; skipping pw=${r.pw} pvt=${r.pvt}`);
        continue;
      }

      const baseName = `dynamic-daily-${r.minX}-${r.minY}`;
      const outPath = path.join(outDir, `${baseName}.dzi`);
      const filesDir = path.join(outDir, `${baseName}_files`);

      // Resumability: skip regions whose DZI already exists from a prior run.
      // The .dzi descriptor is written last by stitch, so its presence implies
      // the _files/ pyramid is complete. Pass --force to redo.
      if (!force && fs.existsSync(outPath) && fs.existsSync(filesDir)) {
        console.log(`[stitch] checkpoint: ${baseName}.dzi exists, skipping (pass --force to redo)`);
        skipped++;
        count++;
        continue;
      }

      // stitch's input glob expects "<X>,<Y>.png" (comma). Use a private dir per
      // region so the *.png glob matches exactly one tile.
      const regionTmp = path.join(tmpRoot, `r${r.minX}_${r.minY}`);
      fs.mkdirSync(regionTmp, { recursive: true });
      const tileName = `${r.minX},${r.minY}.png`;
      // Hard-link if possible (instant, no copy of ~120MB); fall back to copy
      // across filesystems / on Windows when crossing a drive.
      try { fs.linkSync(src, path.join(regionTmp, tileName)); }
      catch { fs.copyFileSync(src, path.join(regionTmp, tileName)); }

      // Wipe any prior partial <baseName>_files/ so a smaller pyramid replaces
      // a larger one cleanly (stitch only writes the levels it produces).
      fs.rmSync(filesDir, { recursive: true, force: true });

      const xmax = r.minX + r.fullW;
      const ymax = r.minY + r.fullH;
      const stitchArgs = [
        "--input", regionTmp,
        "--output", outPath,
        "--blend-tile-limit", "1",
        "--dzi-tile-size", "512",
        "--webp-level", "9",
        "--xmin", String(r.minX),
        "--ymin", String(r.minY),
        "--xmax", String(xmax),
        "--ymax", String(ymax),
      ];
      console.log(`[stitch] pw=${r.pw} pvt=${r.pvt} ${baseName} (${r.fullW}x${r.fullH})`);
      const t = Date.now();
      try {
        execFileSync(stitchBin, stitchArgs, { stdio: "inherit" });
      } catch (e) {
        console.error(`[stitch] failed on ${baseName}: ${e.message}`);
        continue;
      }
      console.log(`[stitch] ${baseName} done in ${fmt(Date.now() - t)}`);
      count++;
    }
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
