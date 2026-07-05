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
// Runtime atlas: the app imports the atlas from src/data/atlas.json (bundled),
// while it still fetches the spritesheet from public/assets/spritesheet.png.
// Write the atlas to BOTH so the bundled atlas never desyncs from the sheet.
const RUNTIME_JSON = path.resolve(__dirname, "..", "src", "data", "atlas.json");

// On Windows the output file can be transiently locked by another process
// (Defender real-time scan, or a vite dev server serving public/assets/), which
// surfaces as errno -4094 (UNKNOWN) / EBUSY / EPERM on open-for-write. The lock
// window is short, so retry the write a few times with a small backoff instead
// of failing the whole build.
function writeFileSyncRetry(file, data, retries = 8, delayMs = 150) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      const transient = err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "UNKNOWN");
      if (!transient || attempt > retries) throw err;
      console.warn(`[build-spritesheet] write ${path.basename(file)} locked (${err.code}), retry ${attempt}/${retries}`);
      const until = Date.now() + delayMs * attempt;
      while (Date.now() < until) {} // sync busy-wait (this is a one-shot build script)
    }
  }
}

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
  "data/entities/animals/",
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
  // Achievement Pillars segments (data/biome_impl/pillars/*.png) — each
  // pillar_part_<code>.png is an engraved 48x48 achievement icon, stacked by
  // mountain_tree.lua spawn_pillars. Baked so the structure can be rendered.
  "data/biome_impl/pillars/",
];

// Explicit single-PNG inclusions outside SCAN_DIRS.
// Pairs of [zipPath, atlasKey] — the PNG is loaded as-is (no XML, no rotation,
// no heuristic crop) and registered under the given key.
const INCLUDE_EXTRA_PNGS = [
  // Meditation Cube visual — pixel scene loaded by data/scripts/biomes/excavationsite.lua
  // (spawn_meditation_cube → LoadPixelScene with meditation_cube_visual.png).
  // Telescope surfaces this as {type:'item', item:'meditation_cube'} → key
  // item:meditation_cube, which would otherwise be missing.
  ["data/biome_impl/excavationsite/meditation_cube_visual.png", "item:meditation_cube"],
  // Potion mimic (Henkevä potu) UI icon — telescope emits {item:'mimic_potion'}.
  // The items_gfx has no matching sprite; use the dedicated animal icon.
  ["data/ui_gfx/animal_icons/mimic_potion.png", "item:mimic_potion"],
];

// Paths to SKIP when scanning — not useful as standalone sprites
const SKIP_DIRS = [
  "data/items_gfx/in_hand/",  // Hand-held overlays, not standalone sprites
  "data/entities/animals/boss_centipede/rewards/",  // Reward icons, not creature sprites
  "data/entities/animals/boss_centipede/verlet_chains/",  // Chain segments
  "data/entities/animals/boss_centipede/limbs/",  // Limb segments
  "data/entities/animals/boss_centipede/tail/",  // Tail segments
  "data/entities/animals/boss_limbs/limb",  // Limb segments (prefix match)
  "data/entities/animals/boss_meat/limb",  // Limb segments
  "data/entities/animals/boss_meat/hair",  // Hair pieces
  "data/entities/animals/boss_fish/tentacle",  // Tentacle parts
  "data/entities/animals/ending_placeholder/",  // Duplicate ending assets
];

// Filename patterns to SKIP — never used in the spritesheet/atlas
const SKIP_SUFFIXES = [
  "_hotspot",
  "_hotspots",
  "_uv_src",
  "_normals",
];

// Substrings anywhere in the PNG path that cause it to be skipped
const SKIP_SUBSTRINGS = [
  "/image_emitters/",
  "/stain",
  "_stain",
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

// Specific enemy PNGs that ship WITHOUT a companion .xml but are genuinely
// wider than tall (single non-animated frame). The width>height heuristic would
// square-crop them and lose the right edge. Korjauslennokki (Repair Drone) is
// 12x8 — its emissive twin's XML confirms a single 12x8 "stand" frame.
const NO_HEURISTIC_CROP_FILES = new Set([
  "data/enemies_gfx/healerdrone.png",
  // Utility box item sprite is a single wide frame; the square-crop clipped it
  // to 10x10 (right edge lost on the map, search icons and cards).
  "data/items_gfx/utility_box.png",
]);

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

  // Boss/creature entity sprites → enemy: keys (same namespace as enemies_gfx)
  if (zipPath.startsWith("data/entities/animals/")) {
    const rel = zipPath.slice("data/entities/animals/".length).replace(/\.png$/, "");
    // Map boss_xxx/body.png → enemy:boss_xxx_body, boss_xxx/sprite.png → enemy:boss_xxx_sprite
    const key = rel.replace(/\//g, "_");
    return `enemy:${key}`;
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

  // Achievement Pillar segments → pillar:<basename> (e.g. pillar:pillar_part_secretcd)
  if (zipPath.startsWith("data/biome_impl/pillars/")) {
    const name = path.basename(zipPath, ".png");
    return `pillar:${name}`;
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
    // Skip image_emitters and stain files anywhere in path
    for (const sub of SKIP_SUBSTRINGS) {
      if (relPath.includes(sub)) return;
    }
    // Skip filename patterns (_hotspot, _hotspots, _uv_src, _normals)
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

  // ─── Explicit single-PNG inclusions outside SCAN_DIRS ───────────────────
  // Each entry forces a specific PNG into the spritesheet under a fixed key,
  // bypassing the normal directory scan + key derivation.
  const extraInclusions = []; // {zipPath, key}
  for (const [zipPath, key] of INCLUDE_EXTRA_PNGS) {
    if (!zip.file(zipPath)) {
      console.warn(`[build-spritesheet] WARNING: extra PNG missing in data.zip: ${zipPath}`);
      continue;
    }
    extraInclusions.push({ zipPath, key });
  }
  if (extraInclusions.length) {
    console.log(`[build-spritesheet] Queued ${extraInclusions.length} explicit extra PNG(s)`);
  }

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

    // Parse companion XML early — we need it to decide whether large images can be cropped
    // Try exact match first, then _sprite.xml (boss sprites use this naming convention)
    const xmlPath = p.replace(/\.png$/, ".xml");
    let xmlData = await parseXml(zip, xmlPath);
    // Also try _sprite.xml if the matched XML has no frame data
    // (entity XMLs like boss_alchemist.xml have offset_x/y from SpriteComponents but no frame_width)
    if (!xmlData || !xmlData.frame_width) {
      const spriteXmlPath = p.replace(/\.png$/, "_sprite.xml");
      const spriteXml = await parseXml(zip, spriteXmlPath);
      if (spriteXml) xmlData = spriteXml;
    }

    // Skip images where BOTH dimensions exceed the limit — UNLESS they have XML frame data
    // that will allow us to crop them to a small first frame (e.g., boss sprite sheets).
    // Wide spritesheets (e.g. 280x50 orb animations) pass through and get cropped later.
    if (img.width > MAX_SPRITE_DIM && img.height > MAX_SPRITE_DIM) {
      const canCrop = xmlData && xmlData.frame_width && xmlData.frame_height
        && xmlData.frame_width <= MAX_SPRITE_DIM && xmlData.frame_height <= MAX_SPRITE_DIM;
      if (!canCrop) {
        skippedLarge++;
        continue;
      }
      // Large image with XML frame data — let it through for cropping below
    }

    // Skip fully transparent images
    if (isFullyTransparent(img.data)) {
      skippedTransparent++;
      continue;
    }

    // Crop animated sprites to first frame of the default/idle animation
    const noHeuristicCrop =
      NO_HEURISTIC_CROP_DIRS.some((d) => p.startsWith(d)) || NO_HEURISTIC_CROP_FILES.has(p);
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

  // ─── Explicit extra PNGs (verbatim, no XML / no heuristic crop) ────────
  let extrasAdded = 0;
  for (const { zipPath, key } of extraInclusions) {
    if (seenKeys.has(key)) continue;
    let buf;
    try { buf = await zip.file(zipPath).async("arraybuffer"); } catch { continue; }
    let img;
    try { img = decodePng(buf); } catch { continue; }
    if (img.width > MAX_SPRITE_DIM || img.height > MAX_SPRITE_DIM) {
      console.warn(`[build-spritesheet] WARNING: extra PNG too large, skipped: ${zipPath} (${img.width}x${img.height})`);
      continue;
    }
    if (isFullyTransparent(img.data)) continue;
    sprites.push({ key, data: img.data, width: img.width, height: img.height });
    seenKeys.add(key);
    extrasAdded++;
  }
  if (extrasAdded) console.log(`[build-spritesheet] Added ${extrasAdded} explicit extra PNG(s)`);

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

  // ─── wand:bomb_wand (rotated) — used by the starting loadout ───────────────
  // bomb_wand.png lives in items_gfx/ root, keyed as item:bomb_wand. Mirror
  // the handgun treatment so the starting bomb wand renders on the map.
  const bombWandSprite = sprites.find((s) => s.key === "item:bomb_wand");
  if (bombWandSprite) {
    const rotated = rotateCCW(bombWandSprite.data, bombWandSprite.width, bombWandSprite.height);
    const wandBomb = { key: "wand:bomb_wand", data: rotated.data, width: rotated.width, height: rotated.height };
    sprites.push(wandBomb);
    seenKeys.add("wand:bomb_wand");
    console.log("[build-spritesheet] Added wand:bomb_wand (rotated from item:bomb_wand)");
  } else {
    console.warn("[build-spritesheet] WARNING: item:bomb_wand not found, cannot create wand:bomb_wand");
  }

  // ─── wand:custom/kantele, wand:custom/flute (rotated) ──────────────────────
  // Kantele (Kantele) and Huilu (flute) live as item sprites (item:kantele /
  // item:flute, from data/items_gfx/{kantele,flute}.png) but telescope assigns
  // them sprite "custom/kantele" / "custom/flute". Bake rotated wand:custom/*
  // copies (tip-up, like every other wand:* sprite) so they render correctly
  // AND with the right orientation on the map. Same treatment as handgun above.
  for (const [itemKey, wandKey] of [
    ["item:kantele", "wand:custom/kantele"],
    ["item:flute", "wand:custom/flute"],
  ]) {
    const src = sprites.find((s) => s.key === itemKey);
    if (src) {
      const rotated = rotateCCW(src.data, src.width, src.height);
      sprites.push({ key: wandKey, data: rotated.data, width: rotated.width, height: rotated.height });
      seenKeys.add(wandKey);
      console.log(`[build-spritesheet] Added ${wandKey} (rotated from ${itemKey})`);
    } else {
      console.warn(`[build-spritesheet] WARNING: ${itemKey} not found, cannot create ${wandKey}`);
    }
  }

  // ─── wand:custom/experimental_wand_1, _2 (rotated) ─────────────────────────
  // Experimental Wands ("It's a wand, ok?") live OUTSIDE the scanned wand dir,
  // at data/entities/items/wands/experimental/*.png, so the normal scan never
  // bakes a wand:custom/experimental_wand_N key. Telescope names these sprites
  // "custom/experimental_wand_N", so without this block the map marker (and the
  // baked daily DZI) has no sprite even though the card/search resolve via the
  // data.zip fallback. Load + rotate them like every other wand:* sprite.
  for (const n of ["experimental_wand_1", "experimental_wand_2"]) {
    const wandKey = `wand:custom/${n}`;
    if (seenKeys.has(wandKey)) continue;
    try {
      const buf = await zip.file(`data/entities/items/wands/experimental/${n}.png`).async("arraybuffer");
      const img = decodePng(buf);
      const rotated = rotateCCW(img.data, img.width, img.height);
      sprites.push({ key: wandKey, data: rotated.data, width: rotated.width, height: rotated.height });
      seenKeys.add(wandKey);
      console.log(`[build-spritesheet] Added ${wandKey} (rotated from entities/items/wands/experimental/${n}.png)`);
    } catch (e) {
      console.warn(`[build-spritesheet] WARNING: could not bake ${wandKey}:`, e.message);
    }
  }

  // ─── enemy:boss_fish_eye_open — last "open" frame of Syväolento's eye ───────
  // The eye spritesheet (data/entities/animals/boss_fish/eye.png) has an "open"
  // animation at pos_y=72, 5 frames of 50x72 laid out left-to-right. We want
  // the fully-open eye (last frame) as a standalone map marker. Crop it here.
  try {
    const eyeBuf = await zip.file("data/entities/animals/boss_fish/eye.png").async("arraybuffer");
    const eye = decodePng(eyeBuf);
    const FW = 50, FH = 72, ROW_Y = 72, LAST_X = 4 * FW; // 5th frame (0-indexed 4)
    const frame = cropToFrame(eye.data, eye.width, eye.height, FW, FH, LAST_X, ROW_Y);
    sprites.push({ key: "enemy:boss_fish_eye_open", data: frame.data, width: frame.width, height: frame.height });
    seenKeys.add("enemy:boss_fish_eye_open");
    console.log("[build-spritesheet] Added enemy:boss_fish_eye_open (last open frame of boss_fish/eye.png)");
  } catch (e) {
    console.warn("[build-spritesheet] WARNING: could not bake enemy:boss_fish_eye_open:", e.message);
  }

  // ─── animal_icon:fish_giga — Syväolento's UI/search icon ───────────────────

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

  // ─── Grayscale variants for pillar segments ────────────────────────────────
  // Achievement-pillar segments render in full colour when the achievement is
  // unlocked and desaturated ("not unlocked yet") otherwise. Bake a grayscale
  // twin (pillar_gray:<name>) for every pillar:<name> so the locked state is a
  // plain atlas-key swap at render time — no per-marker canvas filter needed.
  {
    let grayCount = 0;
    for (const s of sprites.slice()) {
      if (!s.key.startsWith("pillar:")) continue;
      const grayKey = s.key.replace(/^pillar:/, "pillar_gray:");
      if (seenKeys.has(grayKey)) continue;
      const g = new Uint8ClampedArray(s.data.length);
      for (let i = 0; i < s.data.length; i += 4) {
        const lum = (s.data[i] * 0.299 + s.data[i + 1] * 0.587 + s.data[i + 2] * 0.114) | 0;
        g[i] = g[i + 1] = g[i + 2] = lum;
        g[i + 3] = s.data[i + 3];
      }
      sprites.push({ key: grayKey, data: g, width: s.width, height: s.height });
      seenKeys.add(grayKey);
      grayCount++;
    }
    if (grayCount) console.log(`[build-spritesheet] Added ${grayCount} grayscale pillar variants`);
  }

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

  // ─── Entity aliases: enemy:<basename> → actual atlas key ───────────────────
  // Telescope strips entity paths to the basename (e.g., "failed_alchemist"
  // from "data/entities/animals/failed_alchemist.xml"). For entities whose
  // sprite doesn't live at data/enemies_gfx/<basename>.png, the atlas key
  // built from the sprite path differs from enemy:<basename>, so POI
  // markers and tooltips can't find a sprite. We resolve each entity's
  // SpriteComponent image_file chain (entity XML → maybe another XML → PNG)
  // and register the PNG's atlas key under enemy:<basename>.
  async function resolveEntitySprite(zip, xmlPath, depth = 0) {
    if (depth > 6) return null;
    const f = zip.file(xmlPath);
    if (!f) return null;
    const txt = await f.async("text");
    // <Sprite filename="X[.png]" /> — leaf sprite XML; extension is optional in Noita XMLs
    const fnMatch = txt.match(/<Sprite\b[^/>]*\sfilename="([^"]+)"/);
    if (fnMatch) {
      const fn = fnMatch[1];
      return fn.endsWith(".png") ? fn : fn + ".png";
    }
    // image_file="..." — either a PNG or another XML to follow
    const imMatch = txt.match(/image_file="([^"]+)"/);
    if (imMatch) {
      const target = imMatch[1];
      if (target.endsWith(".png")) return target;
      if (target.endsWith(".xml")) {
        const resolved = await resolveEntitySprite(zip, target, depth + 1);
        if (resolved) return resolved;
      }
    }
    // <Base file="..."> — follow inheritance chain
    const baseMatch = txt.match(/<Base\b[^>]*\sfile="([^"]+)"/);
    if (baseMatch) return resolveEntitySprite(zip, baseMatch[1], depth + 1);
    return null;
  }

  const entityXmlPaths = [];
  zip.forEach((relPath) => {
    if (!relPath.startsWith("data/entities/")) return;
    if (!relPath.endsWith(".xml")) return;
    // Skip non-entity XMLs (particle effects, sprite definitions, etc.)
    const base = path.basename(relPath, ".xml");
    if (base.endsWith("_sprite") || base.endsWith("_particles") ||
        base.endsWith("_fx") || base.endsWith("_emitter") ||
        base.endsWith("_animated") || base.endsWith("_damage") ||
        base.endsWith("_effect") || base.endsWith("_marker")) return;
    entityXmlPaths.push(relPath);
  });

  let entityAliasCount = 0;
  for (const xmlPath of entityXmlPaths) {
    const entityName = path.basename(xmlPath, ".xml");
    const aliasKey = `enemy:${entityName}`;
    if (atlas[aliasKey]) continue;
    const spritePng = await resolveEntitySprite(zip, xmlPath);
    if (!spritePng) continue;
    const targetKey = getAtlasKey(spritePng, false);
    if (targetKey && atlas[targetKey]) {
      atlas[aliasKey] = { ...atlas[targetKey] };
      entityAliasCount++;
    }
  }
  console.log(`[build-spritesheet] Added ${entityAliasCount} entity sprite aliases`);

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
  writeFileSyncRetry(OUT_PNG, pngBuf);
  console.log(`[build-spritesheet] Wrote ${OUT_PNG} (${(pngBuf.length / 1024).toFixed(1)} KB)`);

  const atlasJson = JSON.stringify(atlas, null, 2);
  writeFileSyncRetry(OUT_JSON, atlasJson);
  console.log(`[build-spritesheet] Wrote ${OUT_JSON} (${Object.keys(atlas).length} entries)`);

  writeFileSyncRetry(RUNTIME_JSON, atlasJson);
  console.log(`[build-spritesheet] Wrote ${RUNTIME_JSON} (runtime bundled atlas)`);

  console.log("[build-spritesheet] Done.");
}

main().catch((err) => {
  console.error("[build-spritesheet] FATAL:", err);
  process.exit(1);
});
