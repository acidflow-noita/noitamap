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

const sourceDir = path.join(__dirname, '../lib/noita-telescope/data');
const targetDir = path.join(__dirname, '../public/data');

// Files telescope fetches at runtime via a dynamic URL (un-bundleable).
const requiredFiles = ['biome_flags.json'];

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

console.log(`${requiredFiles.length}/${requiredFiles.length} telescope data file(s) synced to public/data`);
