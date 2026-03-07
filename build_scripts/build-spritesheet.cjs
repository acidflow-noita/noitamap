/**
 * build-spritesheet.cjs
 *
 * Extracts POI sprites from data.zip, packs them into a single spritesheet.png + atlas.json.
 * Wand sprites are rotated 90° CCW (stored horizontal, displayed vertical on the map).
 * Animated sprites (width > height) are cropped to the first frame.
 *
 * Output:
 *   public/assets/spritesheet.png
 *   public/assets/atlas.json
 *
 * Usage:
 *   node build_scripts/build-spritesheet.cjs
 */

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { PNG } = require("pngjs");

const DATA_ZIP = path.resolve(__dirname, "..", "public", "data.zip");
const OUT_DIR = path.resolve(__dirname, "..", "public", "assets");
const OUT_PNG = path.join(OUT_DIR, "spritesheet.png");
const OUT_JSON = path.join(OUT_DIR, "atlas.json");

// Max spritesheet width — sprites are packed left-to-right, row by row
const SHEET_MAX_W = 2048;

/**
 * Decode a PNG buffer into { data: Uint8ClampedArray, width, height }.
 */
function decodePng(buf) {
  const png = PNG.sync.read(Buffer.from(buf));
  return {
    data: new Uint8ClampedArray(png.data),
    width: png.width,
    height: png.height,
  };
}

/**
 * Rotate RGBA pixel data 90° counter-clockwise.
 * Input is (sw × sh), output is (sh × sw).
 */
function rotateCCW(data, sw, sh) {
  const outW = sh;
  const outH = sw;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const srcIdx = (y * sw + x) * 4;
      const dstX = y;
      const dstY = sw - 1 - x;
      const dstIdx = (dstY * outW + dstX) * 4;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
      out[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Crop the first frame from an animated sprite (width > height).
 * Frame = first height×height pixels from the left.
 */
function cropFirstFrame(data, sw, sh) {
  const frameW = sh; // square frame
  const out = new Uint8ClampedArray(frameW * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srcOff = y * sw * 4;
    const dstOff = y * frameW * 4;
    out.set(data.subarray(srcOff, srcOff + frameW * 4), dstOff);
  }
  return { data: out, width: frameW, height: sh };
}

async function main() {
  console.log("[build-spritesheet] Loading data.zip...");
  const zipBuf = fs.readFileSync(DATA_ZIP);
  const zip = await JSZip.loadAsync(zipBuf);

  /** @type {Array<{key: string, data: Uint8ClampedArray, width: number, height: number}>} */
  const sprites = [];

  // ─── Wand sprites (rotated 90° CCW) ────────────────────────────────────────
  const wandPrefix = "data/items_gfx/wands/";
  const wandPaths = [];
  zip.forEach((relPath) => {
    if (
      relPath.startsWith(wandPrefix) &&
      relPath.endsWith(".png") &&
      relPath.indexOf("/custom/") === -1
    ) {
      wandPaths.push(relPath);
    }
  });
  wandPaths.sort();

  console.log(`[build-spritesheet] Processing ${wandPaths.length} wand sprites...`);
  for (const p of wandPaths) {
    const buf = await zip.file(p).async("arraybuffer");
    const img = decodePng(buf);
    const rotated = rotateCCW(img.data, img.width, img.height);
    const name = path.basename(p, ".png");
    sprites.push({ key: `wand:${name}`, ...rotated });
  }

  // Also include custom wand sprites
  const customWandPaths = [];
  zip.forEach((relPath) => {
    if (
      relPath.startsWith(wandPrefix + "custom/") &&
      relPath.endsWith(".png")
    ) {
      customWandPaths.push(relPath);
    }
  });
  customWandPaths.sort();

  console.log(`[build-spritesheet] Processing ${customWandPaths.length} custom wand sprites...`);
  for (const p of customWandPaths) {
    const buf = await zip.file(p).async("arraybuffer");
    const img = decodePng(buf);
    const rotated = rotateCCW(img.data, img.width, img.height);
    const name = path.basename(p, ".png");
    sprites.push({ key: `wand:custom/${name}`, ...rotated });
  }

  // ─── Item sprites ──────────────────────────────────────────────────────────
  // Key items that appear as POIs on the dynamic map
  const itemFiles = [
    "chest", "chest_present", "crate",
    "heart", "heart_extrahp", "heart_extrahp_evil",
    "potion", "pouch", "powder_stash", "material_pouch", "material_backbag",
    "flask_liquid", "jar",
    "goldnugget_01", "goldnugget_6px", "goldnugget_9px", "goldnugget_12px", "goldnugget_20px",
    "spell_refresh",
    "orb", "orb_greed",
    "perk", "safe_haven",
    "egg", "egg_purple", "egg_red", "egg_slime", "egg_worm",
    "book", "book_s", "emerald_tablet", "scroll",
    "kakke", "gourd",
    "key", "knife", "rock",
    "bomb", "bomb_holy", "bomb_holy_giga",
    "evil_eye",
    "torch", "moon", "sunseed",
    "beamstone", "thunderstone", "stonestone", "waterstone", "wandstone", "musicstone", "brimstone",
    "broken_wand", "broken_spell",
    "kantele", "flute",
    "medkit",
  ];

  console.log(`[build-spritesheet] Processing ${itemFiles.length} item sprites...`);
  for (const name of itemFiles) {
    const p = `data/items_gfx/${name}.png`;
    const f = zip.file(p);
    if (!f) {
      console.warn(`  [SKIP] ${p} not found`);
      continue;
    }
    const buf = await f.async("arraybuffer");
    let img = decodePng(buf);
    // Crop animated sprites to first frame
    if (img.width > img.height) {
      img = cropFirstFrame(img.data, img.width, img.height);
    }
    sprites.push({ key: `item:${name}`, data: img.data, width: img.width, height: img.height });
  }

  // ─── Spell sprites (from ui_gfx/gun_actions/) ─────────────────────────────
  const spellPrefix = "data/ui_gfx/gun_actions/";
  const spellPaths = [];
  zip.forEach((relPath) => {
    if (relPath.startsWith(spellPrefix) && relPath.endsWith(".png")) {
      spellPaths.push(relPath);
    }
  });
  spellPaths.sort();

  console.log(`[build-spritesheet] Processing ${spellPaths.length} spell sprites...`);
  for (const p of spellPaths) {
    const buf = await zip.file(p).async("arraybuffer");
    let img = decodePng(buf);
    if (img.width > img.height) {
      img = cropFirstFrame(img.data, img.width, img.height);
    }
    const name = path.basename(p, ".png");
    sprites.push({ key: `spell:${name}`, data: img.data, width: img.width, height: img.height });
  }

  console.log(`[build-spritesheet] Total sprites: ${sprites.length}`);

  // ─── Pack sprites into rows ────────────────────────────────────────────────
  // Simple row packing: left to right, wrap when exceeding SHEET_MAX_W
  const atlas = {};
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;

  // Sort sprites by height (descending) for slightly better packing
  sprites.sort((a, b) => b.height - a.height);

  for (const s of sprites) {
    if (curX + s.width > SHEET_MAX_W) {
      // New row
      curY += rowHeight + 1; // 1px gap between rows
      curX = 0;
      rowHeight = 0;
    }
    atlas[s.key] = { x: curX, y: curY, w: s.width, h: s.height };
    s._px = curX;
    s._py = curY;
    curX += s.width + 1; // 1px gap between sprites
    rowHeight = Math.max(rowHeight, s.height);
  }

  const sheetW = SHEET_MAX_W;
  const sheetH = curY + rowHeight;

  console.log(`[build-spritesheet] Sheet size: ${sheetW}×${sheetH}`);

  // ─── Compose final PNG ─────────────────────────────────────────────────────
  const sheet = new PNG({ width: sheetW, height: sheetH });
  // Fill with transparent
  sheet.data.fill(0);

  for (const s of sprites) {
    const dx = s._px;
    const dy = s._py;
    for (let row = 0; row < s.height; row++) {
      const srcOff = row * s.width * 4;
      const dstOff = ((dy + row) * sheetW + dx) * 4;
      for (let col = 0; col < s.width; col++) {
        const si = srcOff + col * 4;
        const di = dstOff + col * 4;
        sheet.data[di] = s.data[si];
        sheet.data[di + 1] = s.data[si + 1];
        sheet.data[di + 2] = s.data[si + 2];
        sheet.data[di + 3] = s.data[si + 3];
      }
    }
  }

  // ─── Write outputs ─────────────────────────────────────────────────────────
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const pngBuf = PNG.sync.write(sheet, { colorType: 6 }); // RGBA
  fs.writeFileSync(OUT_PNG, pngBuf);
  console.log(`[build-spritesheet] Wrote ${OUT_PNG} (${(pngBuf.length / 1024).toFixed(1)} KB)`);

  fs.writeFileSync(OUT_JSON, JSON.stringify(atlas, null, 2));
  console.log(`[build-spritesheet] Wrote ${OUT_JSON} (${Object.keys(atlas).length} entries)`);

  console.log("[build-spritesheet] Done.");
}

main().catch((err) => {
  console.error("[build-spritesheet] FATAL:", err);
  process.exit(1);
});
