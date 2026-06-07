#!/usr/bin/env node
/**
 * Generate the 9 biome-map region images for one daily seed exactly as they
 * appear on the dynamic map, plus their 10x nearest-neighbour upscales — 18
 * PNGs total. Biomes only: no POIs, creatures, pixel scenes, or markers.
 *
 * These feed a later, separate pyramid + upload step. Each image is named by
 * the OSD top-left corner (minX_minY) the live render passes to addTiledImage,
 * so the pyramid can be re-anchored without recomputing coords.
 *
 * OUTPUT (wiped + rewritten each run, no per-seed subfolder):
 *   noitamap/optional_data/small/dynamic-daily-<minX>-<minY>.png   tiny composite
 *   noitamap/optional_data/full/dynamic-daily-<minX>-<minY>.png    10x nearest-neighbour
 *   noitamap/optional_data/manifest.json                            seed + per-region bounds
 *
 * Filename uses a stable prefix (no seed) because the biome-region bounding
 * boxes are seed-independent — successive daily runs OVERWRITE the same paths
 * so the URLs the live map fetches stay constant across days.
 *
 * EXECUTION (two steps)
 *   1. The biome renderer (telescope gen + canvas composite) is browser-only,
 *      so this reuses the real renderer via headless Playwright Chromium
 *      (Docker-runnable). It navigates the dev server with the seed, waits for
 *      the biome render, then reads window.noitamap.exportBiomeRegions() and
 *      writes the 9 native composites — no canvas in Node.
 *   2. Each composite is upscaled to native game resolution (10x, nearest-
 *      neighbour). A single browser canvas at 10x exceeds the max canvas size
 *      for the bigger regions, so this is a separate step done by either the
 *      aseprite CLI or a built-in streaming Node upscaler (no deps, no 3.2GB
 *      buffer). Default is aseprite-if-present, else the Node upscaler.
 *
 * USAGE
 *   1. Start the dev server: `npm run dev` (in noitamap/)
 *   2. node build_scripts/build-daily-seed-images.cjs
 *      (no --seed -> fetches today's daily seed from the daily-seed worker)
 *   Re-upscale existing smalls without re-rendering:
 *      node build_scripts/build-daily-seed-images.cjs --upscale-only
 *
 * Flags:
 *   --seed=N                      seed to render; omit to use today's daily seed
 *   --url=http://localhost:5173   override dev server URL
 *   --out=<dir>                   override output dir (default ../optional_data)
 *   --upscaler=auto|aseprite|node upscale backend (default auto: aseprite, else node)
 *   --aseprite=<path>             aseprite executable (default "aseprite" on PATH)
 *   --scale=N                     upscale factor (default 10, the live map's)
 *   --timeout=N                   seconds to wait for the biome render (default 300)
 *   --upscale-only                skip the browser; upscale the smalls on disk
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { decode: decodePng } = require("fast-png");

const ROOT = path.resolve(__dirname, "..");
const NAV_TIMEOUT_MS = 90_000;
// Same daily-seed source the app uses (src/data_sources/daily_seed.ts).
const DAILY_SEED_URL = "https://daily-seed.acidflow.stream/current_seed.txt";

const fmt = (ms) => (ms / 1000).toFixed(1) + "s";
let START = 0;

// ─── Streaming nearest-neighbour PNG upscaler (no deps) ─────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(data, crc32(t)) ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
// One error listener per stream (not per write — that leaks listeners over the
// tens of thousands of scanline writes). Returns a write fn that resolves on
// drain and rejects if the stream has errored.
function streamWriter(stream) {
  let err = null;
  stream.on("error", (e) => { err = e; });
  return (buf) =>
    new Promise((res, rej) => {
      if (err) return rej(err);
      if (stream.write(buf)) res();
      else stream.once("drain", res);
    });
}

/**
 * Nearest-neighbour upscale a PNG by an integer factor, streaming scanlines
 * through zlib so the full (factor^2 x) RGBA image is never held in one buffer
 * — a 3277x2457 composite at 10x is ~3.2GB raw, which would OOM. Pure Node:
 * fast-png decode + a hand-rolled streaming PNG encode (filter None, 8-bit RGBA).
 */
async function upscalePngNearest(inputPath, outputPath, factor) {
  const png = decodePng(fs.readFileSync(inputPath));
  if (png.depth && png.depth !== 8) throw new Error(`unexpected bit depth ${png.depth} in ${inputPath}`);
  const w = png.width, h = png.height, ch = png.channels || 4;
  const src = png.data;
  const F = factor;
  const W = w * F, H = h * F;

  const def = zlib.createDeflate({ level: 6 });
  const parts = [];
  def.on("data", (d) => parts.push(d));
  const deflated = new Promise((res, rej) => { def.on("end", res); def.on("error", rej); });
  const writeDef = streamWriter(def);

  const rowLen = 1 + W * 4;
  for (let sy = 0; sy < h; sy++) {
    const row = Buffer.allocUnsafe(rowLen);
    row[0] = 0; // filter: None
    const base = sy * w * ch;
    let o = 1;
    for (let x = 0; x < w; x++) {
      const s = base + x * ch;
      const r = src[s], g = src[s + 1], b = src[s + 2], a = ch === 4 ? src[s + 3] : 255;
      for (let k = 0; k < F; k++) { row[o++] = r; row[o++] = g; row[o++] = b; row[o++] = a; }
    }
    // Each source row maps to F identical output rows (vertical repeat).
    for (let k = 0; k < F; k++) await writeDef(row);
  }
  def.end();
  await deflated;
  const idat = Buffer.concat(parts);

  const ws = fs.createWriteStream(outputPath);
  const finished = new Promise((res, rej) => { ws.on("error", rej); ws.on("finish", res); });
  const writeWs = streamWriter(ws);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, colour type 6 (RGBA)
  await writeWs(PNG_SIG);
  await writeWs(pngChunk("IHDR", ihdr));
  await writeWs(pngChunk("IDAT", idat));
  await writeWs(pngChunk("IEND", Buffer.alloc(0)));
  ws.end();
  await finished;
  return { W, H };
}

/**
 * Upscale every item (small -> full). mode: "auto" (aseprite, fall back to the
 * Node upscaler on first ENOENT), "aseprite" (require it), or "node" (force).
 */
async function runUpscale({ items, smallDir, fullDir, asepritePath, mode }) {
  let method = mode === "node" ? "node" : "aseprite";
  let count = 0;
  for (const it of items) {
    const inP = path.join(smallDir, it.name);
    const outP = path.join(fullDir, it.name);
    if (method === "aseprite") {
      try {
        // aseprite scales pixel art nearest-neighbour by default.
        const ts = Date.now();
        execFileSync(asepritePath, ["-b", inP, "--scale", String(it.scale), "--save-as", outP], { stdio: "pipe" });
        count++;
        console.log(`[images] aseprite upscaled ${it.name} x${it.scale} (${fmt(Date.now() - ts)})`);
        continue;
      } catch (e) {
        if (e.code === "ENOENT") {
          if (mode === "aseprite") {
            console.warn(`[images] aseprite not found ('${asepritePath}'); fulls skipped. Use --upscaler=node or --aseprite=<path>.`);
            return count;
          }
          console.warn(`[images] aseprite not found ('${asepritePath}') -> using built-in Node upscaler.`);
          method = "node";
        } else {
          console.warn(`[images] aseprite failed on ${it.name}: ${(e.stderr || e.message || "").toString().trim()}`);
          continue;
        }
      }
    }
    // Node upscaler (forced, or auto fell back above — re-runs this item).
    const ts = Date.now();
    const { W, H } = await upscalePngNearest(inP, outP, it.scale);
    count++;
    console.log(`[images] node upscaled ${it.name} x${it.scale} -> ${W}x${H} (${fmt(Date.now() - ts)})`);
  }
  return count;
}

async function main() {
  START = Date.now();
  // Parse both `--k=v` and `--k v` forms; falling back to "true" for bare flags.
  const args = (() => {
    const out = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      if (!m) { out[a] = "true"; continue; }
      const key = m[1];
      if (m[2] !== undefined) { out[key] = m[2]; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !/^--/.test(next)) { out[key] = next; i++; }
      else { out[key] = "true"; }
    }
    return out;
  })();
  const baseUrl = args.url || "http://localhost:5173";
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, "optional_data");
  const smallDir = path.join(outDir, "small");
  const fullDir = path.join(outDir, "full");
  const asepritePath = args.aseprite || "aseprite";
  const mode = args.upscaler || "auto";
  const scaleOverride = args.scale ? Number(args.scale) : null;
  const readyTimeoutMs = (args.timeout ? Number(args.timeout) : 300) * 1000;

  // ── Upscale-only: skip the browser, upscale the smalls already on disk ──
  if (args["upscale-only"]) {
    if (!fs.existsSync(smallDir)) {
      console.error(`[images] --upscale-only: no smalls at ${smallDir}`);
      process.exit(1);
    }
    const names = fs.readdirSync(smallDir).filter((f) => f.endsWith(".png"));
    if (names.length === 0) {
      console.error(`[images] --upscale-only: no PNGs in ${smallDir}`);
      process.exit(1);
    }
    fs.rmSync(fullDir, { recursive: true, force: true });
    fs.mkdirSync(fullDir, { recursive: true });
    const items = names.map((name) => ({ name, scale: scaleOverride || 10 }));
    console.log(`[images] upscale-only: ${names.length} smalls, x${scaleOverride || 10}, method=${mode}`);
    const n = await runUpscale({ items, smallDir, fullDir, asepritePath, mode });
    console.log(`[images] done: ${n} full PNGs -> ${fullDir}  (total ${fmt(Date.now() - START)})`);
    return;
  }

  let seed = parseInt(args.seed, 10);
  if (!Number.isFinite(seed) || seed <= 0) {
    // No explicit seed: fetch today's seed from the daily-seed worker (the same
    // source the app uses). Navigating with se=<dailySeed>&u=all then
    // reproduces the daily world's content (all unlocks).
    try {
      const resp = await fetch(DAILY_SEED_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      seed = parseInt((await resp.text()).trim(), 10);
      if (!Number.isFinite(seed) || seed <= 0) throw new Error("unparseable seed in worker response");
      console.log(`[images] no --seed given; using today's daily seed ${seed} from ${DAILY_SEED_URL}`);
    } catch (e) {
      console.error(`[images] could not fetch daily seed from ${DAILY_SEED_URL}: ${e.message}. Pass --seed=<n> to override.`);
      process.exit(1);
    }
  }

  // Resumability: if a previous run for this exact seed left a complete set of
  // smalls/fulls + manifest under <outDir>, skip the (very expensive) headless
  // render and reuse them. Manifest is the authoritative marker — only written
  // at the end of the render phase, so its presence means smalls + fulls are
  // in place. Pass --force-render to bypass.
  const manifestPath = path.join(outDir, "manifest.json");
  if (!args["force-render"] && fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (cached.seed === seed && Array.isArray(cached.regions) && cached.regions.length) {
        const allPresent = cached.regions.every((r) =>
          fs.existsSync(path.join(smallDir, r.file)) && fs.existsSync(path.join(fullDir, r.file)),
        );
        if (allPresent) {
          console.log(`[images] checkpoint: reusing ${cached.regions.length} small+full PNGs for seed ${seed} from ${outDir} (pass --force-render to redo)  (total ${fmt(Date.now() - START)})`);
          return;
        }
        console.log(`[images] checkpoint stale (some PNGs missing) — re-rendering`);
      } else if (cached.seed !== seed) {
        console.log(`[images] checkpoint is for seed ${cached.seed}, but this run is for ${seed} — re-rendering`);
      }
    } catch (e) {
      console.warn(`[images] could not read existing manifest (${e.message}) — re-rendering`);
    }
  }

  let playwright;
  try {
    playwright = require("playwright");
  } catch (e) {
    console.error(
      "[images] playwright not installed.\n" +
      "  cd noitamap && npm install --save-dev playwright && npx playwright install chromium",
    );
    process.exit(1);
  }

  // Probe the dev server up-front so a missing server fails fast instead of
  // timing out inside Playwright navigation.
  try {
    const probe = await fetch(baseUrl, { method: "GET" });
    if (!probe.ok) {
      console.error(`[images] dev server at ${baseUrl} returned HTTP ${probe.status}. Run \`npm run dev\` first.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[images] could not reach dev server at ${baseUrl}: ${e.message}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  // Headless Chromium as root in a container needs --no-sandbox; expose via env
  // so local (non-container) runs keep their default sandbox.
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || "").trim().split(/\s+/).filter(Boolean);
  const browser = await playwright.chromium.launch({ headless: true, args: launchArgs });
  let regions;
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // CF's WAF can 403 acidflow.stream requests originating from GHA runner IPs.
    // The biome export doesn't need the background-map pixels at all — OSD
    // only needs each layer's .dzi descriptor (dimensions/topleft) so its
    // viewport math works. So:
    //   * serve baked .dzi descriptors from $BAKED_DZI_DIR (image-build time
    //     curl into /app/baked-dzi),
    //   * 204 every _files/<level>/<x>_<y>.<ext> tile request so OSD treats
    //     it as "no tile here" and proceeds.
    // Disable with --no-bg-route (handy for local debugging when you DO want
    // to see the background).
    if (!args["no-bg-route"]) {
      const bakedDir = process.env.BAKED_DZI_DIR || "/app/baked-dzi";
      await page.route(/https?:\/\/[^/]*acidflow\.stream\/maps\//, (route) => {
        const url = route.request().url();
        // Match .../maps/<host>/<file>.dzi (descriptor) vs ..._files/.../tile.
        const m = url.match(/\/maps\/[^/]+\/([^/?#]+)\.dzi(?:[?#]|$)/);
        if (m) {
          const local = require("path").join(bakedDir, `${m[1]}.dzi`);
          if (require("fs").existsSync(local)) {
            const body = require("fs").readFileSync(local);
            return route.fulfill({ status: 200, contentType: "application/json", body }).catch(() => route.abort("failed"));
          }
        }
        // Anything else under /maps/ (tiles, missing .dzi) -> 204.
        return route.fulfill({ status: 204, body: "" }).catch(() => route.abort("failed"));
      });
    }

    let lastPageErr = null;
    page.on("pageerror", (e) => {
      // e may be an Error, plain Object, or primitive — surface every form so
      // the next CI failure tells us exactly what broke instead of "[Object]".
      let serialized;
      try {
        serialized = e && (e.stack || e.message) ? (e.stack || e.message) : JSON.stringify(e);
      } catch { serialized = String(e); }
      lastPageErr = serialized;
      console.warn(`[page error] ${serialized}`);
    });
    page.on("requestfailed", (req) => {
      const f = req.failure();
      if (f && !/favicon|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED|ERR_FAILED/i.test(f.errorText || "")) {
        console.warn(`[page reqfail] ${req.method()} ${req.url()} -- ${f.errorText}`);
      }
    });
    page.on("console", (msg) => {
      const txt = msg.text();
      if (msg.type() === "error") {
        if (!/favicon|404|ERR_NAME_NOT_RESOLVED/i.test(txt)) console.warn(`[page] ${txt}`);
      } else if (/^\[export\]/.test(txt)) {
        console.log(`[page] ${txt}`);
      }
    });

    // Record the latest biome render progress so a stall is visible while we
    // wait. addInitScript runs before app scripts on every navigation.
    await page.addInitScript(() => {
      window.__biomeProgress = -1;
      window.addEventListener("biomeGenerationProgress", (e) => {
        const p = e && e.detail && e.detail.percentage;
        if (typeof p === "number") window.__biomeProgress = p;
      });
    });

    // u=all reproduces the daily seed's content (all unlocks). Do NOT pass ds=1
    // (that ignores ?se= and fetches today's daily). dynamic-main-branch is the
    // map the renderer biome-composites.
    const url = `${baseUrl}/?map=dynamic-main-branch&se=${seed}&u=all`;
    console.log(`[images] seed ${seed} -> ${url}`);
    const tNav = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    console.log(`[images] page loaded in ${fmt(Date.now() - tNav)}; waiting for biomes (timeout ${fmt(readyTimeoutMs)})...`);

    // Poll for biomesReady (instead of waitForFunction) so a timeout reports how
    // far the render got — hooks present? biome progress %? indexing state?
    const tWait = Date.now();
    const deadline = tWait + readyTimeoutMs;
    let ready = false, lastLog = 0;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => {
        const h = window.noitamap;
        return {
          hooks: !!(h && typeof h.exportBiomeRegions === "function" && typeof h.biomesReady === "function"),
          ready: !!(h && typeof h.biomesReady === "function" && h.biomesReady()),
          progress: window.__biomeProgress,
          indexing: (window.__noitamap && window.__noitamap.getIndexingState) ? window.__noitamap.getIndexingState() : null,
        };
      }).catch(() => null);
      if (st && st.ready) { ready = true; break; }
      if (Date.now() - lastLog >= 5000) {
        lastLog = Date.now();
        console.log(`[images]  ...${fmt(Date.now() - tWait)} hooks=${st ? st.hooks : "?"} biomeProgress=${st ? st.progress : "?"} indexing=${st ? st.indexing : "?"}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      throw new Error(
        `biomes not ready after ${fmt(Date.now() - tWait)}` +
        (lastPageErr ? ` (last page error: ${lastPageErr})` : "") +
        `. If the render is just slow, bump --timeout=<sec>.`,
      );
    }
    console.log(`[images] biomes ready in ${fmt(Date.now() - tWait)}`);

    const tEval = Date.now();
    regions = await page.evaluate(() => window.noitamap.exportBiomeRegions());
    console.log(`[images] exported ${regions ? regions.length : 0} regions in ${fmt(Date.now() - tEval)}`);
    await page.close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  if (!regions || regions.length === 0) {
    console.error("[images] export returned no regions");
    process.exit(1);
  }

  // Reset output dirs only after a successful render — that way if a previous
  // run wrote a partial manifest, the checkpoint logic above had a chance to
  // detect it. We delete and recreate so leftover files from a previous seed
  // never linger.
  for (const d of [smallDir, fullDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  // Also drop any stale manifest from a previous seed/run before we start writing.
  fs.rmSync(manifestPath, { force: true });

  // 1. Write the native composites (the browser only emits these — a 10x
  //    canvas exceeds the browser's max size for the larger regions).
  // Filenames use a seed-independent prefix so successive daily runs overwrite
  // the same paths (biome-region bounding boxes are seed-stable).
  const regionFile = (r) => `dynamic-daily-${r.minX}-${r.minY}.png`;
  const tWrite = Date.now();
  for (const r of regions) {
    const name = regionFile(r);
    fs.writeFileSync(path.join(smallDir, name), Buffer.from(r.small, "base64"));
    console.log(`[images] pw=${r.pw} pvt=${r.pvt} small ${name} ${r.compositeW}x${r.compositeH}`);
  }
  console.log(`[images] wrote ${regions.length} small PNGs in ${fmt(Date.now() - tWrite)} -> ${smallDir}`);

  // 2. Upscale each composite to native game resolution (separate step).
  const tUp = Date.now();
  const items = regions.map((r) => ({ name: regionFile(r), scale: scaleOverride || r.scale }));
  const fullCount = await runUpscale({ items, smallDir, fullDir, asepritePath, mode });
  console.log(`[images] upscaled ${fullCount} full PNGs in ${fmt(Date.now() - tUp)}`);

  // 3. Manifest: stitch driver reads this for per-region bounds (no PNG re-parse).
  const manifest = {
    seed,
    generatedAt: new Date().toISOString(),
    scale: scaleOverride || (regions[0] && regions[0].scale) || 10,
    regions: regions.map((r) => {
      const s = scaleOverride || r.scale;
      return {
        pw: r.pw, pvt: r.pvt,
        file: regionFile(r),
        minX: r.minX, minY: r.minY,
        fullW: r.compositeW * s, fullH: r.compositeH * s,
      };
    }),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[images] done: ${regions.length} small + ${fullCount} full PNGs + manifest -> ${outDir}  (total ${fmt(Date.now() - START)})`);
  if (regions.length < 9) {
    console.warn(`[images] NOTE: only ${regions.length} regions (expected 9) — heaven/hell may be absent for this seed, or a region was empty`);
  }
}

main().catch((e) => {
  console.error(e);
  if (START) console.error(`[images] failed after ${fmt(Date.now() - START)}`);
  process.exit(1);
});
