// Remap 129 per-biome game colors onto the Tailwind 4 palette.
//
// Strategy: rasterize each biome's SVG polygons to grid cells, build a
// 4-neighbour adjacency graph, then greedy graph-color so bordering biomes
// land on hues that are far apart on the oklch hue wheel. Output is written to
// a SIBLING json (biome_boundries_py.tailwind.json) so the original stays in
// place for rollback / A-B testing.
//
// Run: node scripts/remap-biome-colors.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../src/data/biome_boundries_py.json");
const OUT = resolve(__dirname, "../src/data/biome_boundries_py.tailwind.json");

// Tailwind 4 palette — 400 shade, one representative per hue family. 17 hues,
// far more than the ~5 a planar adjacency graph needs, so neighbour contrast
// stays high. Each entry: [name, oklch, hueAngle].
const PALETTE = [
  ["red", "oklch(70.4% 0.191 22.216)", 22.216],
  ["orange", "oklch(75% 0.183 55.934)", 55.934],
  ["amber", "oklch(82.8% 0.189 84.429)", 84.429],
  ["yellow", "oklch(85.2% 0.199 91.936)", 91.936],
  ["lime", "oklch(84.1% 0.238 128.85)", 128.85],
  ["green", "oklch(79.2% 0.209 151.711)", 151.711],
  ["emerald", "oklch(76.5% 0.177 163.223)", 163.223],
  ["teal", "oklch(77.7% 0.152 181.912)", 181.912],
  ["cyan", "oklch(78.9% 0.154 211.53)", 211.53],
  ["sky", "oklch(74.6% 0.16 232.661)", 232.661],
  ["blue", "oklch(70.7% 0.165 254.624)", 254.624],
  ["indigo", "oklch(67.3% 0.182 276.935)", 276.935],
  ["violet", "oklch(70.2% 0.183 293.541)", 293.541],
  ["purple", "oklch(71.4% 0.203 305.504)", 305.504],
  ["fuchsia", "oklch(74% 0.238 322.16)", 322.16],
  ["pink", "oklch(71.8% 0.202 349.761)", 349.761],
  ["rose", "oklch(71.2% 0.194 13.428)", 13.428],
];

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Parse an SVG path string ("M x y L x y ... Z M ...") into a list of polygons,
// each polygon a list of [x, y] points.
function parsePolygons(path) {
  const tokens = path.split(/\s+/).filter(Boolean);
  const polys = [];
  let cur = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "M") {
      if (cur && cur.length) polys.push(cur);
      cur = [];
      cur.push([Number(tokens[i + 1]), Number(tokens[i + 2])]);
      i += 3;
    } else if (t === "L") {
      cur.push([Number(tokens[i + 1]), Number(tokens[i + 2])]);
      i += 3;
    } else if (t === "Z") {
      i += 1;
    } else {
      i += 1;
    }
  }
  if (cur && cur.length) polys.push(cur);
  return polys;
}

// Even-odd point-in-polygon-set test (handles holes: a point inside an outer
// loop and an inner loop counts as outside).
function inside(polys, px, py) {
  let crossings = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py) {
        const xAt = xi + ((py - yi) / (yj - yi)) * (xj - xi);
        if (px < xAt) crossings++;
      }
    }
  }
  return crossings % 2 === 1;
}

const data = JSON.parse(readFileSync(SRC, "utf8"));
const biomes = data.biomes;

// Grid bounds.
const W = 70;
const H = 48;

// Rasterize each biome to a Set of "x,y" cell keys (test cell centres).
const cellsOf = biomes.map((b) => {
  const polys = parsePolygons(b.svg_map_path);
  let minX = W,
    minY = H,
    maxX = 0,
    maxY = 0;
  for (const p of polys)
    for (const [x, y] of p) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  const set = new Set();
  for (let cy = Math.max(0, Math.floor(minY)); cy < Math.min(H, Math.ceil(maxY)); cy++) {
    for (let cx = Math.max(0, Math.floor(minX)); cx < Math.min(W, Math.ceil(maxX)); cx++) {
      if (inside(polys, cx + 0.5, cy + 0.5)) set.add(cx + "," + cy);
    }
  }
  return set;
});

// Map cell -> biome indices occupying it (cells can overlap across PWs? no —
// but tiny biomes may share). Build 4-neighbour adjacency between biomes.
const cellOwners = new Map();
cellsOf.forEach((set, idx) => {
  for (const key of set) {
    if (!cellOwners.has(key)) cellOwners.set(key, []);
    cellOwners.get(key).push(idx);
  }
});

const adj = biomes.map(() => new Set());
const NEIGH = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
cellsOf.forEach((set, idx) => {
  for (const key of set) {
    const [cx, cy] = key.split(",").map(Number);
    for (const [dx, dy] of NEIGH) {
      const owners = cellOwners.get(cx + dx + "," + (cy + dy));
      if (!owners) continue;
      for (const o of owners) if (o !== idx) {
        adj[idx].add(o);
        adj[o].add(idx);
      }
    }
  }
});

// Greedy graph coloring: most-constrained (highest degree) first; pick the
// palette hue maximizing the minimum hue-distance to already-colored
// neighbours, tie-broken by least global usage.
const order = biomes.map((_, i) => i).sort((a, b) => adj[b].size - adj[a].size);
const colorIdx = new Array(biomes.length).fill(-1);
const usage = new Array(PALETTE.length).fill(0);

for (const idx of order) {
  const neighHues = [];
  for (const n of adj[idx]) if (colorIdx[n] >= 0) neighHues.push(PALETTE[colorIdx[n]][2]);

  let best = -1;
  let bestScore = -Infinity;
  for (let c = 0; c < PALETTE.length; c++) {
    const minDist = neighHues.length ? Math.min(...neighHues.map((h) => hueDist(h, PALETTE[c][2]))) : 360;
    // Primary: maximize separation from neighbours. Secondary: prefer
    // under-used colors so the whole map stays balanced.
    const score = minDist * 1000 - usage[c];
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  colorIdx[idx] = best;
  usage[best]++;
}

// Apply + write sibling file.
const out = JSON.parse(JSON.stringify(data));
out.biomes.forEach((b, i) => {
  b.biome_color = PALETTE[colorIdx[i]][1];
});
writeFileSync(OUT, JSON.stringify(out, null, 2));

// Report.
let conflicts = 0;
for (let i = 0; i < biomes.length; i++)
  for (const n of adj[i]) if (n > i && colorIdx[i] === colorIdx[n]) conflicts++;

const degrees = adj.map((s) => s.size);
console.log("biomes:", biomes.length);
console.log("max adjacency degree:", Math.max(...degrees));
console.log("adjacent same-color conflicts:", conflicts);
console.log("palette usage:");
PALETTE.forEach((p, i) => usage[i] && console.log(`  ${p[0].padEnd(8)} ${usage[i]}`));
console.log("written:", OUT);
