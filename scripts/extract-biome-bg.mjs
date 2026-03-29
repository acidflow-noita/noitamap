#!/usr/bin/env node
/**
 * Extract biome background textures from data.zip → public/biome_bg/
 * so they can be loaded directly via URL (no data.zip dependency).
 *
 * Usage: node scripts/extract-biome-bg.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ZIP_PATH = join(ROOT, "public", "data.zip");
const OUT_DIR = join(ROOT, "public", "biome_bg");

// All unique texture paths needed by BIOME_BACKGROUND_MAP
const TEXTURE_PATHS = [
  "data/weather_gfx/background_coalmine.png",
  "data/weather_gfx/background_excavationsite.png",
  "data/weather_gfx/background_cave_04_alt3.png",
  "data/weather_gfx/background_snowcave.png",
  "data/weather_gfx/background_snowcastle.png",
  "data/weather_gfx/background_cave_02.png",
  "data/weather_gfx/background_fungicave_01.png",
  "data/weather_gfx/background_fungiforest_01.png",
  "data/weather_gfx/background_rainforest.png",
  "data/weather_gfx/background_rainforest_dark.png",
  "data/weather_gfx/background_vault.png",
  "data/weather_gfx/background_vault_frozen.png",
  "data/weather_gfx/background_crypt.png",
  "data/weather_gfx/background_wandcave.png",
  "data/weather_gfx/background_wizardcave.png",
  "data/weather_gfx/background_robobase.png",
  "data/weather_gfx/background_the_end.png",
  "data/weather_gfx/background_pyramid.png",
  "data/weather_gfx/background_cave_04_alt.png",
  "data/weather_gfx/background_cave_09.png",
];

async function main() {
  console.log(`Reading ${ZIP_PATH}...`);
  const zipBuf = readFileSync(ZIP_PATH);
  const zip = await JSZip.loadAsync(zipBuf);

  mkdirSync(OUT_DIR, { recursive: true });

  let extracted = 0;
  for (const texPath of TEXTURE_PATHS) {
    const entry = zip.file(texPath);
    if (!entry) {
      console.warn(`  ⚠ Missing: ${texPath}`);
      continue;
    }
    const data = await entry.async("nodebuffer");
    const outName = texPath.split("/").pop();
    const outPath = join(OUT_DIR, outName);
    writeFileSync(outPath, data);
    console.log(`  ✓ ${outName} (${data.length} bytes)`);
    extracted++;
  }

  console.log(`\nExtracted ${extracted}/${TEXTURE_PATHS.length} textures to public/biome_bg/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
