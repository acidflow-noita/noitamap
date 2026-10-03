#!/usr/bin/env node

// Verify a stitch-produced DZI pyramid against the DZI spec.
//
// stitch derives each level's bounds by iteratively halving the ABSOLUTE world
// bounds with DivideFloor(min) / DivideCeil(max), while a DZI consumer (OSD)
// computes level width as ceil(Size.Width / 2^k). Those agree only while the
// origin stays divisible by the level's scale; past that, floor() pushes the min
// outward and the level's tiles come out 1px wider than the descriptor declares.
// OSD sizes its destination rect from the descriptor, so such a level renders
// stretched -- by a constant 1px, which as a FRACTION of the level width doubles
// every level down. That is what made the baked biome map distort when zooming
// out, worse the further out you went.
//
// build_scripts/stitch-dzis.cjs snaps the stitch bounds to a power-of-two grid so
// this cannot happen. This script is the guard that proves it stayed fixed.
//
// Perfect alignment at EVERY level would need the origin snapped to 2^maxLevel,
// which is absurd padding. So the gate is about visibility: a level is only worth
// failing on while the whole world is still wider than MIN_VISIBLE_WIDTH pixels at
// that level. Below that the map is a thumbnail and a 1px error cannot be seen.
//
// Usage:
//   node build_scripts/check-dzi-geometry.cjs <file.dzi> [more.dzi ...]
//   node build_scripts/check-dzi-geometry.cjs --dir /out
//   MIN_VISIBLE_WIDTH=256 node build_scripts/check-dzi-geometry.cjs --dir /out
//
// Exit 0 when no VISIBLE level is misaligned, 1 otherwise. Safe to wire into the
// bake as a hard gate.

const fs = require("fs");
const path = require("path");

// Smallest level width still worth policing. At 256 a misaligned level only
// fails the gate while the entire world is wider than 256px on screen.
const MIN_VISIBLE_WIDTH = Number(process.env.MIN_VISIBLE_WIDTH || 256);

function findDzis(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    console.error(`No such directory: ${dir}`);
    console.error("Note: /out is the path INSIDE the bake container. Locally, point");
    console.error("this at wherever stitch-dzis.cjs wrote its output, e.g.");
    console.error("  node build_scripts/check-dzi-geometry.cjs --dir ./optional_data/dzi");
    console.error("or pass descriptors directly:");
    console.error("  node build_scripts/check-dzi-geometry.cjs path/to/dynamic-daily-middle.dzi");
    process.exit(2);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findDzis(p));
    else if (entry.name.endsWith(".dzi")) out.push(p);
  }
  return out;
}

/** First level whose bounds stitch and a DZI consumer disagree on, or null. */
function firstBadLevel(minX, minY, width, height) {
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  const div2 = (n) => {
    n = Math.abs(n);
    if (n === 0) return Infinity;
    let k = 0;
    while (n % 2 === 0) { n /= 2; k++; }
    return k;
  };
  // Exact while the level's scale (2^(maxLevel-L)) divides BOTH origins.
  const v = Math.min(div2(minX), div2(minY));
  const bad = maxLevel - v - 1;
  return { maxLevel, divisibility: v === Infinity ? "inf" : v, firstBad: bad >= 0 ? bad : null };
}

function check(file) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // Real DZI descriptors may be XML; stitch writes JSON. Only JSON is checkable here.
    console.error(`  ! ${path.basename(file)}: not JSON (${e.message})`);
    return false;
  }
  const img = d && d.Image;
  if (!img || !img.Size) {
    console.error(`  ! ${path.basename(file)}: no Image.Size`);
    return false;
  }
  const W = Number(img.Size.Width), H = Number(img.Size.Height);
  const minX = Number((img.TopLeft && img.TopLeft.X) ?? 0);
  const minY = Number((img.TopLeft && img.TopLeft.Y) ?? 0);
  const r = firstBadLevel(minX, minY, W, H);
  const name = path.basename(file);
  // Lowest level at which the world is still wider than MIN_VISIBLE_WIDTH.
  let lowestVisible = 0;
  for (let L = r.maxLevel; L >= 0; L--) {
    if (Math.ceil(W / Math.pow(2, r.maxLevel - L)) >= MIN_VISIBLE_WIDTH) lowestVisible = L;
  }
  const badVisible = r.firstBad !== null && r.firstBad >= lowestVisible;
  const widthAt = (L) => Math.ceil(W / Math.pow(2, r.maxLevel - L));
  if (!badVisible) {
    const detail = r.firstBad === null
      ? "every level exact"
      : `first misaligned level ${r.firstBad} is only ${widthAt(r.firstBad)}px wide — below the ${MIN_VISIBLE_WIDTH}px visibility floor`;
    console.log(`  OK   ${name}  ${W}x${H} @(${minX},${minY})  maxLevel=${r.maxLevel}  origin 2-div=${r.divisibility}  (${detail})`);
    return true;
  }
  console.error(
    `  FAIL ${name}  ${W}x${H} @(${minX},${minY})  maxLevel=${r.maxLevel}  origin 2-div=${r.divisibility}\n` +
    `       levels ${r.firstBad} and below are geometrically wrong: their tiles are 1px wider than\n` +
    `       the descriptor declares, so OSD draws them stretched. Level ${r.firstBad} is ${widthAt(r.firstBad)}px wide,\n` +
    `       which is above the ${MIN_VISIBLE_WIDTH}px visibility floor, so this WILL be seen when zoomed out.\n` +
    `       Fix: snap the stitch origin so it is divisible by 2^(maxLevel - ${lowestVisible}) = ${Math.pow(2, r.maxLevel - lowestVisible)}\n` +
    `       (build_scripts/stitch-dzis.cjs ORIGIN_ALIGN).`
  );
  return false;
}

const args = process.argv.slice(2);
let files = [];
if (args[0] === "--dir") {
  if (!args[1]) { console.error("--dir needs a path"); process.exit(2); }
  files = findDzis(args[1]);
} else {
  files = args;
}
if (files.length === 0) {
  console.error("usage: check-dzi-geometry.cjs <file.dzi ...> | --dir <path>");
  process.exit(2);
}

console.log(`Checking ${files.length} DZI descriptor(s) for pyramid geometry:`);
let allOk = true;
for (const f of files) if (!check(f)) allOk = false;

if (allOk) {
  console.log(`No misaligned level above the ${MIN_VISIBLE_WIDTH}px visibility floor.`);
  process.exit(0);
}
console.error("\nPyramid geometry is wrong: the map will visibly distort when zoomed out.");
process.exit(1);
