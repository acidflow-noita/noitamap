#!/usr/bin/env node

// Sync telescope data files that are fetched at RUNTIME (not bundled by Vite)
// into public/data so they ship in the deploy.
//
// Why this exists: telescope fetches some data via fetchSafeJson('../data/X'),
// which builds the URL dynamically inside a helper. Vite can't statically
// analyse that, so it never bundles the file. At runtime the chunk lives in
// /assets/, so '../data/X' resolves to /data/X and must physically exist under
// public/data. A telescope update that adds/renames such a file silently breaks
// the deployed map (the tests run in jsdom and never hit these asset paths), so
// this script is the guard: missing source -> build fails loudly.

const fs = require('fs');
const path = require('path');

// Must match the fork vite.config.ts resolves, or the copied data will not match
// the code that fetches it.
const telescopeDir = process.env.NOITAMAP_TELESCOPE || "lib/noita-telescope";
const sourceDir = path.join(__dirname, '..', telescopeDir, 'data');
const targetDir = path.join(__dirname, '../public/data');

// Files telescope fetches at runtime via a dynamic URL (un-bundleable).
const requiredFiles = ['biome_flags.json'];

// Runtime data the WebGL2 final-pixel terrain renderer fetches, on forks that
// have it. material_atlas.bin is deliberately raw rows rather than a PNG so no
// browser decode can perturb the bytes — byte-exactness against the game is the
// whole point of the material pass — which also means it cannot be shrunk by
// re-encoding. Optional: the older fork has no GL path, so a missing file here
// is not a build failure, it just means the GL renderer stays unavailable.
const optionalFiles = [
  'material_atlas.bin',
  'material_atlas.json',
  'edge_atlas.bin',
  'biome_backgrounds.json',
  'background_data.json',
];

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

let missing = false;
requiredFiles.forEach((file) => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);

  if (!fs.existsSync(sourcePath)) {
    console.error(`❌ Telescope data file not found: ${file} (looked in ${sourceDir})`);
    missing = true;
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
});

if (missing) {
  console.error('   A telescope update likely removed or renamed a runtime data file.');
  process.exit(1);
}

let optionalCopied = 0;
let optionalBytes = 0;
const optionalSkipped = [];
optionalFiles.forEach((file) => {
  const sourcePath = path.join(sourceDir, file);
  if (!fs.existsSync(sourcePath)) {
    optionalSkipped.push(file);
    return;
  }
  fs.copyFileSync(sourcePath, path.join(targetDir, file));
  optionalCopied++;
  optionalBytes += fs.statSync(sourcePath).size;
});

console.log(
  `${requiredFiles.length}/${requiredFiles.length} required telescope data file(s) synced to public/data (fork: ${telescopeDir})`,
);
if (optionalCopied) {
  console.log(`  + ${optionalCopied} GL terrain file(s), ${(optionalBytes / 1048576).toFixed(2)} MiB`);
}
if (optionalSkipped.length) {
  console.log(`  (no GL terrain data on this fork: ${optionalSkipped.join(', ')})`);
}
