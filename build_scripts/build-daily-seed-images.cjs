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
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { decode: decodePng } = require("fast-png");

const ROOT = path.resolve(__dirname, "..");
const NAV_TIMEOUT_MS = 90_000;
// Same daily-seed source the app uses (src/data_sources/daily_seed.ts).
const DAILY_SEED_URL = "https://daily-seed.acidflow.stream/current_seed.txt";

const fmt = (ms) => (ms / 1000).toFixed(1) + "s";
let START = 0;

/**
 * Run `upscalePngWithBg` over N regions concurrently using worker_threads.
 * Default concurrency = regions.length (there are only 9 regions per bake, so
 * any higher cap is pointless); env UPSCALE_CONCURRENCY overrides. Per-worker
 * peak RAM is ~500 MB-1 GB (overlay+mask PNGs, biome bgs, decor cell band,
 * buffered IDAT), so all 9 in parallel ~ 9 GB on the 128 GB runner.
 */
async function runUpscalePool({ regions, sharedParams, regionFile, fullDir, smallDir, maskDir, biomeBgSrcDir, biomeIndex, decorParam, scaleOverride }) {
  const cap = Math.max(
    1,
    parseInt(process.env.UPSCALE_CONCURRENCY || "0", 10) || regions.length,
  );
  console.log(`[images] upscale pool: ${regions.length} regions, concurrency=${cap}`);
  const queue = regions.slice();
  let done = 0, failed = 0;

  const runOne = (r) => new Promise((resolve) => {
    const name = regionFile(r);
    const factor = scaleOverride || r.scale;
    const params = {
      overlayPath: path.join(smallDir, name),
      maskPath: r.hasMask || r.mask ? path.join(maskDir, name) : null,
      factor,
      outputPath: path.join(fullDir, name),
      regionMinX: r.minX,
      regionMinY: r.minY,
      decor: decorParam,
    };
    const ts = Date.now();
    const w = new Worker(__filename, {
      workerData: { kind: "upscale-region", region: { file: name }, params, biomeBgSrcDir, biomeIndex },
    });
    w.once("message", (m) => {
      if (m && m.ok) {
        done++;
        console.log(`[images] composited ${name} x${factor} -> ${m.W}x${m.H} (${fmt(Date.now() - ts)})`);
      } else {
        failed++;
        console.error(`[images] failed on ${name}: ${m && m.error}`);
      }
    });
    w.once("error", (e) => { failed++; console.error(`[images] worker error on ${name}: ${e.message}`); });
    w.once("exit", () => resolve());
  });

  const workers = Array.from({ length: Math.min(cap, queue.length) }, async () => {
    while (queue.length) {
      const r = queue.shift();
      await runOne(r);
    }
  });
  await Promise.all(workers);
  return { done, failed };
}


// ─── Streaming nearest-neighbour PNG upscaler (no deps) ─────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Vertical world slot in game px (heaven/main/hell each occupy one slot).
const SLOT_H_PX = 24576;
const padSlotH = (v) => (v < SLOT_H_PX && SLOT_H_PX - v < 10 ? SLOT_H_PX : v);
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
 * Streaming nearest-neighbour upscale that composites a biome background
 * underneath the overlay before encoding. Used for ALL regions:
 *
 * - Main-world regions (pvt=0) provide a `maskPath`. The mask's RGB encodes
 *   a biome index per pixel and alpha=255 inside / 0 outside biome polygons.
 * - Heaven/hell regions (pvt!=0) pass `maskPath=null`. They have no biome
 *   bgs (live render doesn't paint any either), so every overlay-transparent
 *   pixel stays transparent.
 *
 * Per output pixel:
 *   1. mask sample (if mask present) -> biome bitmap (or null).
 *   2. overlay sample.
 *   3. inside biome polygon: bg pixel (or black if bitmap missing) under the
 *      overlay; alpha-blend; output is opaque.
 *   4. outside biome polygon (or no mask at all): if overlay opaque, emit
 *      overlay pixel; otherwise emit fully transparent so the static bg /
 *      OSD viewport bg shows through. We never fill empty space with opaque
 *      black — that would occlude static map tiles and inflate WebP size.
 */
async function upscalePngWithBg({ overlayPath, maskPath, biomeBitmaps, factor, outputPath, regionMinX = 0, regionMinY = 0, decor = null }) {
  const overlayPng = decodePng(fs.readFileSync(overlayPath));
  const w = overlayPng.width, h = overlayPng.height;
  const overlayCh = overlayPng.channels || 4;
  const overlay = overlayPng.data;

  let maskBuf = null;
  if (maskPath) {
    const m = decodePng(fs.readFileSync(maskPath));
    if (m.width !== w || m.height !== h) {
      throw new Error(`mask dims ${m.width}x${m.height} != overlay ${w}x${h}`);
    }
    maskBuf = m.data; // RGBA: R,G,B encode idx (24-bit), A=255 inside / 0 outside
  }

  // Decor cell cache (sparse, one row band of cells live at a time). The
  // browser emits cells on a fixed CELL-px world grid (CELL=2048 here);
  // cyIdx = floor(wy/CELL). When the streaming scanline crosses a cell-row
  // boundary, the previous row's bitmaps are dropped so peak RAM stays at
  // ~one row of cells (~17 * 16 MB = ~272 MB worst case per region).
  const CELL = decor && decor.cellSize ? decor.cellSize : 2048;
  const decorCells = decor && decor.cells ? decor.cells : null;
  const decorDir = decor && decor.dir ? decor.dir : null;
  // cxIdx -> {data,w,h,ch} | null (null = file missing/empty, cached as miss)
  let decorRow = null;
  let decorRowCy = Number.NaN;
  const loadDecorRow = (cy) => {
    if (cy === decorRowCy) return;
    decorRow = new Map();
    decorRowCy = cy;
    if (!decorCells || !decorDir) return;
    for (const c of decorCells) {
      if (c.cy !== cy) continue;
      const p = path.join(decorDir, `cell_${c.cx}_${c.cy}.png`);
      try {
        const png = decodePng(fs.readFileSync(p));
        decorRow.set(c.cx, { data: png.data, w: png.width, h: png.height, ch: png.channels || 4 });
      } catch {
        decorRow.set(c.cx, null);
      }
    }
  };

  const F = factor;
  const W = w * F, H = h * F;
  // World slots are 24576 px tall but the biome map can only yield
  // floor(24576/10)=2457 small px -> 24570 px regions. Pad to the slot height
  // by replicating the last row so the per-world merge stitch has zero
  // uncovered (zero-filled) canvas between vertically abutting regions.
  const padH = H < SLOT_H_PX && SLOT_H_PX - H < F ? SLOT_H_PX - H : 0;
  let lastRow = null;
  const def = zlib.createDeflate({ level: 6 });
  const parts = [];
  def.on("data", (d) => parts.push(d));
  const deflated = new Promise((res, rej) => { def.on("end", res); def.on("error", rej); });
  const writeDef = streamWriter(def);

  // Compose one output pixel into 4 bytes at row[o..o+3]. Inputs:
  //   biome composite (oR,oG,oB,oA + bg + maskInside) and decor sample.
  // The biome composite's output alpha is always 0 or 255 in practice (the
  // browser snaps overlay alpha to binary; partial-alpha blends only happen
  // inside biome polygons, which collapse to A=255). Decor sample is
  // straight RGBA from the browser's offscreen canvas.
  const composite = (row, o, oR, oG, oB, oA, bR, bG, bB, maskInside, dR, dG, dB, dA) => {
    let cR, cG, cB, cA;
    if (!maskInside) {
      cR = oR; cG = oG; cB = oB; cA = oA;
    } else if (oA === 255) {
      cR = oR; cG = oG; cB = oB; cA = 255;
    } else if (oA === 0) {
      cR = bR; cG = bG; cB = bB; cA = 255;
    } else {
      const inv = 255 - oA;
      cR = ((oR * oA) + (bR * inv) + 127) >> 8;
      cG = ((oG * oA) + (bG * inv) + 127) >> 8;
      cB = ((oB * oA) + (bB * inv) + 127) >> 8;
      cA = 255;
    }
    if (dA === 0) {
      // No decor here: emit the biome composite verbatim.
      row[o] = cR; row[o + 1] = cG; row[o + 2] = cB; row[o + 3] = cA;
    } else if (cA === 0) {
      // Transparent base: emit decor with its own straight RGBA so the
      // static bg DZI shows through wherever decor is also transparent.
      row[o] = dR; row[o + 1] = dG; row[o + 2] = dB; row[o + 3] = dA;
    } else if (dA === 255) {
      // Opaque decor over opaque base: decor wins, output opaque.
      row[o] = dR; row[o + 1] = dG; row[o + 2] = dB; row[o + 3] = 255;
    } else {
      // Partial decor over opaque base: standard "over" with straight RGBA.
      const inv = 255 - dA;
      row[o] = ((dR * dA) + (cR * inv) + 127) >> 8;
      row[o + 1] = ((dG * dA) + (cG * inv) + 127) >> 8;
      row[o + 2] = ((dB * dA) + (cB * inv) + 127) >> 8;
      row[o + 3] = 255;
    }
  };

  // Sample one decor pixel at world coords. decorRow must already be loaded
  // for the appropriate cy. Returns 0-alpha when no cell covers (wx,wy).
  const sampleDecor = (wx, wy) => {
    if (!decorRow || decorRow.size === 0) return [0, 0, 0, 0];
    const cx = Math.floor(wx / CELL);
    const cell = decorRow.get(cx);
    if (!cell) return [0, 0, 0, 0];
    const lx = wx - cx * CELL;
    const ly = wy - decorRowCy * CELL;
    if (lx < 0 || ly < 0 || lx >= cell.w || ly >= cell.h) return [0, 0, 0, 0];
    const i = (ly * cell.w + lx) * cell.ch;
    return [cell.data[i], cell.data[i + 1], cell.data[i + 2], cell.ch === 4 ? cell.data[i + 3] : 255];
  };

  const rowLen = 1 + W * 4;
  for (let sy = 0; sy < h; sy++) {
    const overlayBase = sy * w * overlayCh;
    const maskBase = sy * w * 4;

    for (let kRow = 0; kRow < F; kRow++) {
      const outY = sy * F + kRow;
      const worldY = regionMinY + outY;
      if (decorCells) loadDecorRow(Math.floor(worldY / CELL));

      const row = Buffer.allocUnsafe(rowLen);
      row[0] = 0;
      let o = 1;
      for (let sx = 0; sx < w; sx++) {
        // Inside-biome decision (same as before): mask alpha>0 inside polygon,
        // mask alpha=0 outside, no mask = always outside (heaven/hell).
        let bgBmp = null;
        let maskInside = false;
        if (maskBuf) {
          const mi = maskBase + sx * 4;
          if (maskBuf[mi + 3] > 0) {
            maskInside = true;
            const idx = (maskBuf[mi] << 16) | (maskBuf[mi + 1] << 8) | maskBuf[mi + 2];
            bgBmp = biomeBitmaps[idx] || null;
          }
        }
        const os = overlayBase + sx * overlayCh;
        const oR = overlay[os], oG = overlay[os + 1], oB = overlay[os + 2];
        const oA = overlayCh === 4 ? overlay[os + 3] : 255;

        const outBaseX = sx * F;
        for (let kx = 0; kx < F; kx++) {
          const outX = outBaseX + kx;
          let bR = 0, bG = 0, bB = 0;
          if (bgBmp) {
            const bx = outX % bgBmp.w;
            const by = outY % bgBmp.h;
            const bi = (by * bgBmp.w + bx) * bgBmp.ch;
            bR = bgBmp.data[bi]; bG = bgBmp.data[bi + 1]; bB = bgBmp.data[bi + 2];
          }
          let dR = 0, dG = 0, dB = 0, dA = 0;
          if (decorCells) {
            const s = sampleDecor(regionMinX + outX, worldY);
            dR = s[0]; dG = s[1]; dB = s[2]; dA = s[3];
          }
          composite(row, o, oR, oG, oB, oA, bR, bG, bB, maskInside, dR, dG, dB, dA);
          o += 4;
        }
      }
      await writeDef(row);
      lastRow = row;
    }
  }
  for (let i = 0; i < padH; i++) await writeDef(lastRow);
  def.end();
  await deflated;
  const idat = Buffer.concat(parts);

  const ws = fs.createWriteStream(outputPath);
  const finished = new Promise((res, rej) => { ws.on("error", rej); ws.on("finish", res); });
  const writeWs = streamWriter(ws);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H + padH, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  await writeWs(PNG_SIG);
  await writeWs(pngChunk("IHDR", ihdr));
  await writeWs(pngChunk("IDAT", idat));
  await writeWs(pngChunk("IEND", Buffer.alloc(0)));
  ws.end();
  await finished;
  return { W, H: H + padH };
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
  const maskDir = path.join(outDir, "mask");
  const decorDir = path.join(outDir, "decor");
  const biomeBgSrcDir = path.join(ROOT, "public", "biome_bg");
  const asepritePath = args.aseprite || "aseprite";
  const mode = args.upscaler || "auto";
  const scaleOverride = args.scale ? Number(args.scale) : null;
  const readyTimeoutMs = (args.timeout ? Number(args.timeout) : 300) * 1000;

  // ── Upscale-only: skip the browser, composite+upscale smalls already on disk ──
  if (args["upscale-only"]) {
    if (!fs.existsSync(smallDir)) {
      console.error(`[images] --upscale-only: no smalls at ${smallDir}`);
      process.exit(1);
    }
    const upscaleOnlyManifestPath = path.join(outDir, "manifest.json");
    const cachedManifest = fs.existsSync(upscaleOnlyManifestPath)
      ? JSON.parse(fs.readFileSync(upscaleOnlyManifestPath, "utf8"))
      : null;
    if (!cachedManifest || !cachedManifest.regions || !cachedManifest.biomeIndex) {
      console.error(`[images] --upscale-only: ${upscaleOnlyManifestPath} missing/incomplete (need regions + biomeIndex). Re-run without --upscale-only.`);
      process.exit(1);
    }
    fs.rmSync(fullDir, { recursive: true, force: true });
    fs.mkdirSync(fullDir, { recursive: true });

    const factor = scaleOverride || cachedManifest.scale || 10;
    const decorParam = cachedManifest.decor && cachedManifest.decor.cellSize && fs.existsSync(decorDir)
      ? { cellSize: cachedManifest.decor.cellSize, cells: cachedManifest.decor.cells || [], dir: decorDir }
      : null;
    const regionFileUpscale = (r) => r.file;
    const poolRes = await runUpscalePool({
      regions: cachedManifest.regions.map((r) => ({ ...r, scale: cachedManifest.scale || 10, hasMask: fs.existsSync(path.join(maskDir, r.file)) })),
      sharedParams: {}, regionFile: regionFileUpscale, fullDir, smallDir, maskDir,
      biomeBgSrcDir, biomeIndex: cachedManifest.biomeIndex || {}, decorParam, scaleOverride: factor,
    });
    console.log(`[images] done: ${poolRes.done} full PNGs -> ${fullDir}  (total ${fmt(Date.now() - START)})`);
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
        const allPresent =
          fs.existsSync(path.join(outDir, "generation.json")) &&
          cached.regions.every((r) =>
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

  let decorCellsForManifest = [];
  let decorCellSize = 0;

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
  let biomeIndex;
  let generationData;
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
      // google-analytics: headless page has no business phoning home; its
      // aborted beacon POST is not a bake failure.
      if (f && !/favicon|google-analytics|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED|ERR_FAILED/i.test((f.errorText || "") + req.url())) {
        console.warn(`[page reqfail] ${req.method()} ${req.url()} -- ${f.errorText}`);
      }
    });
    page.on("console", (msg) => {
      const txt = msg.text();
      if (msg.type() === "error") {
        // "Tile ... failed to load" is expected with the bg route active: every
        // background tile request is fulfilled with an empty 204 (see above),
        // which OSD reports as a per-tile load error. Only real errors matter.
        const expectedTileNoise = !args["no-bg-route"] && /Tile %s failed to load/.test(txt);
        if (!expectedTileNoise && !/favicon|404|ERR_NAME_NOT_RESOLVED/i.test(txt)) console.warn(`[page] ${txt}`);
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
    // map the renderer biome-composites. nb=1 disables the client's baked fast
    // path: a re-bake of an already-deployed seed must still generate locally
    // (the export hooks need live tileLayers, which the baked path never has).
    const url = `${baseUrl}/?map=dynamic-main-branch&se=${seed}&u=all&nb=1`;
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
    const exportResult = await page.evaluate(() => window.noitamap.exportBiomeRegions());
    regions = exportResult ? exportResult.regions : null;
    biomeIndex = exportResult ? exportResult.biomeIndex : null;
    console.log(`[images] exported ${regions ? regions.length : 0} regions in ${fmt(Date.now() - tEval)}`);

    // Full generation data (POIs, pixel scenes, biome map). stitch-dzis.cjs
    // splits this per world so the live map can render the daily without
    // running telescope at all.
    generationData = await page.evaluate(() =>
      typeof window.noitamap.exportGenerationData === "function" ? window.noitamap.exportGenerationData() : null,
    );
    if (!generationData) {
      throw new Error("exportGenerationData returned nothing — POI bake is a required artifact");
    }
    console.log(`[images] exported generation data (${Object.keys(generationData.poisByPW || {}).length} pw slices)`);

    // Decoration export: pixel scenes + POI sprites baked into native-scale
    // cells on a fixed world grid. The node compositor will alpha-blend each
    // cell onto the upscaled region full before stitching, so the deployed
    // pyramids carry scenes + creatures in their pixels (live map skips
    // addPixelScenes + the marker tile source entirely on baked seeds).
    fs.rmSync(decorDir, { recursive: true, force: true });
    fs.mkdirSync(decorDir, { recursive: true });
    const tDecor = Date.now();
    const decorInfo = await page.evaluate(() =>
      typeof window.noitamap.prepareDecorationExport === "function"
        ? window.noitamap.prepareDecorationExport()
        : null,
    );
    if (decorInfo && decorInfo.cells && decorInfo.cells.length) {
      decorCellSize = decorInfo.cellSize;
      console.log(`[images] decor: ${decorInfo.cells.length} cells x ${decorCellSize}px to render`);
      let nRendered = 0, nEmpty = 0;
      for (const c of decorInfo.cells) {
        const dataUrl = await page.evaluate(
          ({ cx, cy }) => window.noitamap.exportDecorationCell(cx, cy),
          c,
        );
        if (!dataUrl) { nEmpty++; continue; }
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(path.join(decorDir, `cell_${c.cx}_${c.cy}.png`), Buffer.from(b64, "base64"));
        decorCellsForManifest.push({ cx: c.cx, cy: c.cy });
        nRendered++;
      }
      await page.evaluate(() => window.noitamap.releaseDecorationExport && window.noitamap.releaseDecorationExport());
      console.log(`[images] decor: wrote ${nRendered} cells (${nEmpty} empty) in ${fmt(Date.now() - tDecor)}`);
    } else {
      console.warn(`[images] decor: prepareDecorationExport returned nothing (continuing without baked scenes/sprites)`);
    }

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
  // never linger. decorDir was already populated above and is intentionally
  // skipped here.
  for (const d of [smallDir, fullDir, maskDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  // Also drop any stale manifest from a previous seed/run before we start writing.
  fs.rmSync(manifestPath, { force: true });

  // 1. Write the native composites + masks. Browser only emits the small
  //    composite + (for main-world regions) a per-pixel biome-index mask;
  //    bgs are baked underneath in the upscale step.
  const regionFile = (r) => `dynamic-daily-${r.minX}-${r.minY}.png`;
  const tWrite = Date.now();
  for (const r of regions) {
    const name = regionFile(r);
    fs.writeFileSync(path.join(smallDir, name), Buffer.from(r.small, "base64"));
    if (r.mask) fs.writeFileSync(path.join(maskDir, name), Buffer.from(r.mask, "base64"));
    console.log(`[images] pw=${r.pw} pvt=${r.pvt} small ${name} ${r.compositeW}x${r.compositeH}${r.mask ? " (+ mask)" : ""}`);
  }
  console.log(`[images] wrote ${regions.length} small PNGs in ${fmt(Date.now() - tWrite)} -> ${smallDir}`);

  // 2. Upscale each region with bg composited underneath. Main-world regions
  //    use their per-pixel mask; heaven/hell pass maskPath=null which makes
  //    every overlay-transparent pixel stay transparent. Decoration cells (if
  //    any) are alpha-blended on top of the biome composite per scanline.
  //    Regions run in parallel via worker_threads (one region per worker);
  //    each worker re-decodes the (small) biome bg PNGs once for itself.
  const tUp = Date.now();
  const decorParam = decorCellSize
    ? { cellSize: decorCellSize, cells: decorCellsForManifest, dir: decorDir }
    : null;
  const poolRes = await runUpscalePool({
    regions, sharedParams: {}, regionFile, fullDir, smallDir, maskDir,
    biomeBgSrcDir, biomeIndex: biomeIndex || {}, decorParam, scaleOverride,
  });
  const fullCount = poolRes.done;
  console.log(`[images] upscaled+composited ${fullCount} full PNGs in ${fmt(Date.now() - tUp)}`);

  // 3. Manifest: stitch driver reads this for per-region bounds (no PNG re-parse).
  //    biomeIndex is included so --upscale-only re-runs can re-decode the same
  //    set of biome bg PNGs without re-running the browser. decor (if present)
  //    tells the stitch step that scenes+sprites are already baked into the
  //    pixels and lets --upscale-only re-blend the cached cells.
  const manifest = {
    seed,
    generatedAt: new Date().toISOString(),
    scale: scaleOverride || (regions[0] && regions[0].scale) || 10,
    biomeIndex: biomeIndex || {},
    decor: decorCellSize ? { cellSize: decorCellSize, cells: decorCellsForManifest } : null,
    baked: decorCellSize > 0,
    regions: regions.map((r) => {
      const s = scaleOverride || r.scale;
      return {
        pw: r.pw, pvt: r.pvt,
        file: regionFile(r),
        minX: r.minX, minY: r.minY,
        fullW: r.compositeW * s, fullH: padSlotH(r.compositeH * s),
        hasMask: !!r.mask,
      };
    }),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "generation.json"), JSON.stringify(generationData));

  console.log(`[images] done: ${regions.length} small + ${fullCount} full PNGs + manifest -> ${outDir}  (total ${fmt(Date.now() - START)})`);
  if (regions.length < 9) {
    console.warn(`[images] NOTE: only ${regions.length} regions (expected 9) — heaven/hell may be absent for this seed, or a region was empty`);
  }
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    if (START) console.error(`[images] failed after ${fmt(Date.now() - START)}`);
    process.exit(1);
  });
}

// ─── Worker_threads entry ───────────────────────────────────────────────────
// Placed at module bottom so all `const`/function declarations above (e.g.
// SLOT_H_PX, upscalePngWithBg) are fully initialized by the time the async
// IIFE starts running. Putting this at the top hits TDZ on the first
// SLOT_H_PX read because the IIFE starts synchronously to its first await.
//
// The compositor (upscalePngWithBg) is a heavy synchronous pixel loop pinned
// to one core. To use the 32-vCPU runner the parent spawns one worker per
// region; each worker re-decodes the biome bgs (cheap, ~13 tiny PNGs) once
// and runs the compositor for its assigned region. The decor cell band cache
// inside the compositor stays per-worker so peak RAM is ~one row of cells
// per concurrent region (cap workers via UPSCALE_CONCURRENCY).
//
// `main()` above is gated by `if (isMainThread)` so worker threads do NOT
// also kick off the full bake pipeline.
if (!isMainThread && workerData && workerData.kind === "upscale-region") {
  (async () => {
    try {
      const { region, params, biomeBgSrcDir, biomeIndex } = workerData;
      const biomeBitmaps = {};
      for (const [idxStr, bgFile] of Object.entries(biomeIndex || {})) {
        const p = path.join(biomeBgSrcDir, bgFile);
        if (!fs.existsSync(p)) continue;
        const png = decodePng(fs.readFileSync(p));
        biomeBitmaps[Number(idxStr)] = { w: png.width, h: png.height, ch: png.channels || 4, data: png.data };
      }
      const { W, H } = await upscalePngWithBg({
        overlayPath: params.overlayPath,
        maskPath: params.maskPath,
        biomeBitmaps,
        factor: params.factor,
        outputPath: params.outputPath,
        regionMinX: params.regionMinX,
        regionMinY: params.regionMinY,
        decor: params.decor,
      });
      parentPort.postMessage({ ok: true, region, W, H });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
}
