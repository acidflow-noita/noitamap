#!/usr/bin/env node
/**
 * One-shot fixer that capitalizes the first character of every biome label
 * stored in already-baked translation.json files. Two namespaces are touched:
 *
 *   - gameContent.biomes.*           keyed by English biome name (e.g. "Mines")
 *   - gameContent.ui.biome_*         keyed by Noita's internal CSV row id
 *
 * Both originate from common.csv whose lowercase mid-sentence form ("mines",
 * "twisty passages") is fine inside a Noita sentence but wrong for our
 * standalone UI labels. The bake scripts now apply this capitalization on
 * write (add-biome-translations.cjs + process-translations.cjs), so this
 * script is only needed to repair files baked before those changes landed.
 * Source CSV stays untouched.
 *
 * Idempotent — already-capitalized values pass through unchanged.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src", "locales");

function capitalizeFirst(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  const first = s.charAt(0);
  const upper = first.toUpperCase();
  if (upper === first) return s;
  return upper + s.slice(1);
}

let totalChanged = 0;
let touchedFiles = 0;

for (const entry of fs.readdirSync(SRC_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(SRC_DIR, entry.name, "translation.json");
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  let changed = 0;

  // 1. gameContent.biomes.<EnglishName>
  const biomes = data?.gameContent?.biomes;
  if (biomes && typeof biomes === "object") {
    for (const key of Object.keys(biomes)) {
      const v = biomes[key];
      if (typeof v !== "string") continue;
      const next = capitalizeFirst(v);
      if (next !== v) {
        biomes[key] = next;
        changed++;
      }
    }
  }

  // 2. gameContent.ui.biome_*
  const ui = data?.gameContent?.ui;
  if (ui && typeof ui === "object") {
    for (const key of Object.keys(ui)) {
      if (!key.startsWith("biome_")) continue;
      const v = ui[key];
      if (typeof v !== "string") continue;
      const next = capitalizeFirst(v);
      if (next !== v) {
        ui[key] = next;
        changed++;
      }
    }
  }

  if (changed > 0) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`${entry.name}: ${changed} values recapitalized`);
    totalChanged += changed;
    touchedFiles++;
  }
}
console.log(`done — ${totalChanged} values across ${touchedFiles} files`);
