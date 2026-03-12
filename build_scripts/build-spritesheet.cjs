/**
 * build-spritesheet.cjs
 *
 * Extracts ALL entity sprites from data.zip, packs them into a single
 * spritesheet.png + atlas.json.
 *
 * - Recursively scans all key image directories (items_gfx, buildings_gfx,
 *   enemies_gfx, ui_gfx/gun_actions, ui_gfx/items, ui_gfx/perk_icons,
 *   props_gfx, props_breakable_gfx, etc.) including subdirectories.
 * - Parses companion .xml files for spritesheet animation data (frame_width,
 *   frame_height, offset_x, offset_y, frame_count, etc.) and adds to atlas.
 * - Wand sprites are rotated 90° CCW.
 * - Animated sprites are cropped to first frame using XML data or heuristic.
 * - Custom flask/pouch material icons from src/material-icons are included.
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
const SHEET_MAX_W = 4096;

// Max individual sprite dimension — skip huge images (pixel scenes, backgrounds)
const MAX_SPRITE_DIM = 256;

// ─── Image directories to scan recursively in data.zip ───────────────────────
// These contain entity sprites, item icons, spell icons, etc.
const SCAN_DIRS = [
  "data/items_gfx/",
  "data/buildings_gfx/",
  "data/enemies_gfx/",
  "data/ui_gfx/gun_actions/",
  "data/ui_gfx/items/",
  "data/ui_gfx/perk_icons/",
  "data/ui_gfx/status_indicators/",
  "data/ui_gfx/essence_icons/",
  "data/ui_gfx/decorations/",
  "data/ui_gfx/inventory/",
  "data/props_gfx/",
  "data/props_breakable_gfx/",
  "data/projectiles_gfx/",
];

// Paths to SKIP when scanning — not useful as standalone sprites
const SKIP_DIRS = [
  "data/items_gfx/in_hand/",  // Hand-held overlays, not standalone sprites
];

// Filename patterns to SKIP — never used in the spritesheet/atlas
const SKIP_SUFFIXES = [
  "_hotspot",
  "_hotspots",
  "_uv_src",
];

// Directories whose PNGs should be rotated 90° CCW (wand sprites)
const WAND_DIRS = [
  "data/items_gfx/wands/",
];

// Directories where width > height does NOT mean animated spritesheet;
// images should NOT be cropped by the heuristic.
const NO_HEURISTIC_CROP_DIRS = [
  "data/buildings_gfx/",
  "data/props_gfx/",
  "data/props_breakable_gfx/",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodePng(buf) {
  const png = PNG.sync.read(Buffer.from(buf));
  return {
    data: new Uint8ClampedArray(png.data),
    width: png.width,
    height: png.height,
  };
}

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
 * Crop the first frame from a spritesheet image.
 * posX/posY specify the pixel offset of the first frame within the source image.
 */
function cropToFrame(data, sw, sh, frameW, frameH, posX = 0, posY = 0) {
  const fw = Math.min(frameW || sh, sw - posX);
  const fh = Math.min(frameH || sh, sh - posY);
  if (fw >= sw && fh >= sh && posX === 0 && posY === 0) return { data, width: sw, height: sh };
  const out = new Uint8ClampedArray(fw * fh * 4);
  for (let y = 0; y < fh; y++) {
    const srcOff = ((y + posY) * sw + posX) * 4;
    const dstOff = y * fw * 4;
    out.set(data.subarray(srcOff, srcOff + fw * 4), dstOff);
  }
  return { data: out, width: fw, height: fh };
}

/**
 * Parse a Noita .xml file and extract all useful sprite metadata.
 * Returns object with available fields, or null if no XML found / no useful data.
 */
async function parseXml(zip, xmlPath) {
  const f = zip.file(xmlPath);
  if (!f) return null;
  const txt = await f.async("text");

  const getInt = (name) => {
    const m = txt.match(new RegExp(`${name}="(-?\\d+)"`));
    return m ? parseInt(m[1]) : undefined;
  };
  const getFloat = (name) => {
    const m = txt.match(new RegExp(`${name}="(-?[\\d.]+)"`));
    return m ? parseFloat(m[1]) : undefined;
  };
  const getStr = (name) => {
    const m = txt.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };

  const result = {};
  let hasData = false;

  // Sprite geometry
  const fields = {
    offset_x: getInt("offset_x"),
    offset_y: getInt("offset_y"),
    frame_width: getInt("frame_width"),
    frame_height: getInt("frame_height"),
    frame_count: getInt("frame_count"),
    frames_per_row: getInt("frames_per_row"),
    frame_wait: getFloat("frame_wait"),
    default_animation: getStr("default_animation"),
  };

  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      result[k] = v;
      hasData = true;
    }
  }

  // Parse <RectAnimation> elements for named animations
  const animRegex = /<RectAnimation\s+([^/>]*)\/?>/g;
  let animMatch;
  const animations = [];
  while ((animMatch = animRegex.exec(txt)) !== null) {
    const attrs = animMatch[1];
    const anim = {};
    const nameM = attrs.match(/name="([^"]*)"/);
    if (nameM) anim.name = nameM[1];
    const posXM = attrs.match(/pos_x="(-?\d+)"/);
    if (posXM) anim.pos_x = parseInt(posXM[1]);
    const posYM = attrs.match(/pos_y="(-?\d+)"/);
    if (posYM) anim.pos_y = parseInt(posYM[1]);
    const fwM = attrs.match(/frame_width="(-?\d+)"/);
    if (fwM) anim.frame_width = parseInt(fwM[1]);
    const fhM = attrs.match(/frame_height="(-?\d+)"/);
    if (fhM) anim.frame_height = parseInt(fhM[1]);
    const fcM = attrs.match(/frame_count="(-?\d+)"/);
    if (fcM) anim.frame_count = parseInt(fcM[1]);
    const fwaitM = attrs.match(/frame_wait="(-?[\d.]+)"/);
    if (fwaitM) anim.frame_wait = parseFloat(fwaitM[1]);
    const fprM = attrs.match(/frames_per_row="(-?\d+)"/);
    if (fprM) anim.frames_per_row = parseInt(fprM[1]);
    if (Object.keys(anim).length > 0) animations.push(anim);
  }
  if (animations.length > 0) {
    result.animations = animations;
    hasData = true;
  }

  return hasData ? result : null;
}

/**
 * Determine the atlas key for a file path within data.zip.
 */
function getAtlasKey(zipPath, isWand) {
  // Wands: wand:<basename> or wand:custom/<basename>
  if (isWand) {
    const wandBase = "data/items_gfx/wands/";
    const rel = zipPath.slice(wandBase.length).replace(/\.png$/, "");
    return `wand:${rel}`;
  }

  // Spells: spell:<basename>
  if (zipPath.startsWith("data/ui_gfx/gun_actions/")) {
    const name = path.basename(zipPath, ".png");
    return `spell:${name}`;
  }

  // Items: item:<relative path from items_gfx without .png>
  if (zipPath.startsWith("data/items_gfx/")) {
    // Skip wands — handled above
    if (zipPath.startsWith("data/items_gfx/wands/")) return null;
    const rel = zipPath.slice("data/items_gfx/".length).replace(/\.png$/, "");
    return `item:${rel}`;
  }

  // Buildings
  if (zipPath.startsWith("data/buildings_gfx/")) {
    const rel = zipPath.slice("data/buildings_gfx/".length).replace(/\.png$/, "");
    return `building:${rel}`;
  }

  // Enemies
  if (zipPath.startsWith("data/enemies_gfx/")) {
    const rel = zipPath.slice("data/enemies_gfx/".length).replace(/\.png$/, "");
    return `enemy:${rel}`;
  }

  // UI items
  if (zipPath.startsWith("data/ui_gfx/items/")) {
    const rel = zipPath.slice("data/ui_gfx/items/".length).replace(/\.png$/, "");
    return `ui_item:${rel}`;
  }

  // Perks
  if (zipPath.startsWith("data/ui_gfx/perk_icons/")) {
    const name = path.basename(zipPath, ".png");
    return `perk:${name}`;
  }

  // Status indicators
  if (zipPath.startsWith("data/ui_gfx/status_indicators/")) {
    const name = path.basename(zipPath, ".png");
    return `status:${name}`;
  }

  // Essence icons
  if (zipPath.startsWith("data/ui_gfx/essence_icons/")) {
    const name = path.basename(zipPath, ".png");
    return `essence:${name}`;
  }

  // Props
  if (zipPath.startsWith("data/props_gfx/")) {
    const rel = zipPath.slice("data/props_gfx/".length).replace(/\.png$/, "");
    return `prop:${rel}`;
  }

  // Props breakable
  if (zipPath.startsWith("data/props_breakable_gfx/")) {
    const rel = zipPath.slice("data/props_breakable_gfx/".length).replace(/\.png$/, "");
    return `prop_break:${rel}`;
  }

  // Projectiles
  if (zipPath.startsWith("data/projectiles_gfx/")) {
    const rel = zipPath.slice("data/projectiles_gfx/".length).replace(/\.png$/, "");
    return `projectile:${rel}`;
  }

  // Generic fallback for remaining ui_gfx
  if (zipPath.startsWith("data/ui_gfx/")) {
    const rel = zipPath.slice("data/ui_gfx/".length).replace(/\.png$/, "");
    return `ui:${rel}`;
  }

  // Fallback: full relative path
  const rel = zipPath.slice("data/".length).replace(/\.png$/, "");
  return `data:${rel}`;
}

/**
 * Check if a PNG is fully transparent (skip it).
 */
function isFullyTransparent(data) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return false;
  }
  return true;
}

async function main() {
  console.log("[build-spritesheet] Loading data.zip...");
  const zipBuf = fs.readFileSync(DATA_ZIP);
  const zip = await JSZip.loadAsync(zipBuf);

  /** @type {Array<{key: string, data: Uint8ClampedArray, width: number, height: number, xmlData?: object}>} */
  const sprites = [];
  const seenKeys = new Set();

  // ─── Collect all PNG paths from scan directories ───────────────────────────
  const allPngPaths = [];
  zip.forEach((relPath) => {
    if (!relPath.endsWith(".png")) return;
    // Skip excluded directories
    for (const skip of SKIP_DIRS) {
      if (relPath.startsWith(skip)) return;
    }
    // Skip image_emitters anywhere in path
    if (relPath.includes("/image_emitters/")) return;
    // Skip filename patterns (_hotspot, _hotspots, _uv_src)
    const baseName = path.basename(relPath, ".png");
    for (const suffix of SKIP_SUFFIXES) {
      if (baseName.endsWith(suffix)) return;
    }
    for (const dir of SCAN_DIRS) {
      if (relPath.startsWith(dir)) {
        allPngPaths.push(relPath);
        return;
      }
    }
  });
  allPngPaths.sort();

  console.log(`[build-spritesheet] Found ${allPngPaths.length} PNG files across ${SCAN_DIRS.length} directories`);

  let skippedLarge = 0;
  let skippedTransparent = 0;
  let processed = 0;

  for (const p of allPngPaths) {
    const isWand = WAND_DIRS.some((d) => p.startsWith(d));
    const key = getAtlasKey(p, isWand);
    if (!key || seenKeys.has(key)) continue;

    let buf;
    try {
      buf = await zip.file(p).async("arraybuffer");
    } catch {
      continue;
    }

    let img;
    try {
      img = decodePng(buf);
    } catch {
      continue;
    }

    // Skip very large images (pixel scene backgrounds, etc.)
    if (img.width > MAX_SPRITE_DIM || img.height > MAX_SPRITE_DIM) {
      skippedLarge++;
      continue;
    }

    // Skip fully transparent images
    if (isFullyTransparent(img.data)) {
      skippedTransparent++;
      continue;
    }

    // Parse companion XML
    const xmlPath = p.replace(/\.png$/, ".xml");
    const xmlData = await parseXml(zip, xmlPath);

    // Crop animated sprites to first frame of the default/idle animation
    const noHeuristicCrop = NO_HEURISTIC_CROP_DIRS.some((d) => p.startsWith(d));
    if (xmlData && xmlData.frame_width && xmlData.frame_height) {
      // Find the best animation to use for the first frame:
      // 1. The animation matching default_animation name
      // 2. An animation named "idle" or "stand"
      // 3. The first animation
      let posX = 0, posY = 0;
      if (xmlData.animations && xmlData.animations.length > 0) {
        let bestAnim = xmlData.animations[0];
        if (xmlData.default_animation) {
          const match = xmlData.animations.find(a => a.name === xmlData.default_animation);
          if (match) bestAnim = match;
        } else {
          const idleAnim = xmlData.animations.find(a =>
            a.name === "idle" || a.name === "stand" || a.name === "default"
          );
          if (idleAnim) bestAnim = idleAnim;
        }
        posX = bestAnim.pos_x || 0;
        posY = bestAnim.pos_y || 0;
        // Use the animation's own frame dimensions if available
        if (bestAnim.frame_width && bestAnim.frame_height) {
          img = cropToFrame(img.data, img.width, img.height, bestAnim.frame_width, bestAnim.frame_height, posX, posY);
        } else {
          img = cropToFrame(img.data, img.width, img.height, xmlData.frame_width, xmlData.frame_height, posX, posY);
        }
      } else {
        img = cropToFrame(img.data, img.width, img.height, xmlData.frame_width, xmlData.frame_height, 0, 0);
      }
    } else if (img.width > img.height && !isWand && !noHeuristicCrop) {
      // Heuristic: width > height likely means horizontal spritesheet
      // Skip for buildings/props which are often just wide (not animated)
      img = cropToFrame(img.data, img.width, img.height, img.height, img.height);
    }

    // Rotate wands 90° CCW
    if (isWand) {
      const rotated = rotateCCW(img.data, img.width, img.height);
      img = rotated;
    }

    // Skip if after cropping, still too large
    if (img.width > MAX_SPRITE_DIM || img.height > MAX_SPRITE_DIM) {
      skippedLarge++;
      continue;
    }

    const entry = { key, data: img.data, width: img.width, height: img.height };
    if (xmlData) entry.xmlData = xmlData;
    sprites.push(entry);
    seenKeys.add(key);
    processed++;
  }

  console.log(`[build-spritesheet] Processed: ${processed}, Skipped large: ${skippedLarge}, Skipped transparent: ${skippedTransparent}`);

  // ─── Backward-compatible aliases ───────────────────────────────────────────
  // The runtime code uses keys like "item:chest_random" which maps to buildings_gfx.
  // Add aliases so both key formats work.
  const aliases = [
    { from: "building:chest_random", to: "item:chest_random" },
    { from: "building:chest_random_super", to: "item:chest_random_super" },
    { from: "ui_item:potion", to: "item:potion" },
  ];

  // ─── wand:handgun (rotated) — used by spoiler-free mode ────────────────────
  // handgun.png lives in items_gfx/ root, keyed as item:handgun. We need a
  // rotated copy under wand:handgun for use as the generic wand sprite.
  const handgunSprite = sprites.find((s) => s.key === "item:handgun");
  if (handgunSprite) {
    const rotated = rotateCCW(handgunSprite.data, handgunSprite.width, handgunSprite.height);
    const wandHandgun = { key: "wand:handgun", data: rotated.data, width: rotated.width, height: rotated.height };
    sprites.push(wandHandgun);
    seenKeys.add("wand:handgun");
    console.log("[build-spritesheet] Added wand:handgun (rotated from item:handgun)");
  } else {
    console.warn("[build-spritesheet] WARNING: item:handgun not found, cannot create wand:handgun");
  }

  // ─── Custom Material Icons from src/material-icons ─────────────────────────
  const MATERIAL_ICONS_DIR = path.resolve(__dirname, "..", "src", "material-icons");
  if (fs.existsSync(MATERIAL_ICONS_DIR)) {
    const files = fs.readdirSync(MATERIAL_ICONS_DIR);
    let materialIconCount = 0;
    for (const file of files) {
      if (!file.endsWith(".png")) continue;

      let key = null;
      if (file.startsWith("Materialpotion_")) {
        const material = file.replace("Materialpotion_", "").replace(".png", "");
        key = `item:potion:${material}`;
      } else if (file.startsWith("Materialpouch_")) {
        const material = file.replace("Materialpouch_", "").replace(".png", "");
        key = `item:pouch:${material}`;
      }

      if (key && !seenKeys.has(key)) {
        try {
          const buf = fs.readFileSync(path.join(MATERIAL_ICONS_DIR, file));
          const img = decodePng(buf);
          sprites.push({ key, data: img.data, width: img.width, height: img.height });
          seenKeys.add(key);
          materialIconCount++;
        } catch (e) {
          console.warn(`  [WARN] Failed to decode ${file}: ${e.message}`);
        }
      }
    }
    console.log(`[build-spritesheet] Added ${materialIconCount} custom material icons`);
  }

  console.log(`[build-spritesheet] Total sprites: ${sprites.length}`);

  // ─── Pack sprites into rows ────────────────────────────────────────────────
  const atlas = {};

  // Sort by height descending for better packing
  sprites.sort((a, b) => b.height - a.height);

  let curX = 0;
  let curY = 0;
  let rowHeight = 0;

  for (const s of sprites) {
    if (curX + s.width > SHEET_MAX_W) {
      curY += rowHeight + 1;
      curX = 0;
      rowHeight = 0;
    }
    const atlasEntry = { x: curX, y: curY, w: s.width, h: s.height };

    // Add XML metadata if available
    if (s.xmlData) {
      if (s.xmlData.offset_x != null) atlasEntry.ox = s.xmlData.offset_x;
      if (s.xmlData.offset_y != null) atlasEntry.oy = s.xmlData.offset_y;
      if (s.xmlData.frame_width != null) atlasEntry.fw = s.xmlData.frame_width;
      if (s.xmlData.frame_height != null) atlasEntry.fh = s.xmlData.frame_height;
      if (s.xmlData.frame_count != null) atlasEntry.fc = s.xmlData.frame_count;
      if (s.xmlData.frames_per_row != null) atlasEntry.fpr = s.xmlData.frames_per_row;
      if (s.xmlData.frame_wait != null) atlasEntry.fwait = s.xmlData.frame_wait;
      if (s.xmlData.default_animation) atlasEntry.defanim = s.xmlData.default_animation;
      if (s.xmlData.animations) atlasEntry.anims = s.xmlData.animations;
    }

    atlas[s.key] = atlasEntry;
    s._px = curX;
    s._py = curY;
    curX += s.width + 1;
    rowHeight = Math.max(rowHeight, s.height);
  }

  // Add backward-compatible aliases
  for (const { from, to } of aliases) {
    if (atlas[from] && !atlas[to]) {
      atlas[to] = { ...atlas[from] };
    }
  }

  const sheetW = SHEET_MAX_W;
  const sheetH = curY + rowHeight;

  console.log(`[build-spritesheet] Sheet size: ${sheetW}×${sheetH}`);

  // ─── Compose final PNG ─────────────────────────────────────────────────────
  const sheet = new PNG({ width: sheetW, height: sheetH });
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

  const pngBuf = PNG.sync.write(sheet, { colorType: 6 });
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
