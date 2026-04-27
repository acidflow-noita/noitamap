/**
 * generate-material-effects.cjs
 *
 * Builds the noita-ordered status effect lookup used by extended material
 * popups. Source of truth is `data/scripts/status_effects/status_list.lua`
 * extracted from `noitamap/public/data.zip` (the canonical noita enum order).
 * Names and descriptions are pulled from
 * `noitamap/public/game-translations/common.csv` (English column).
 *
 * Materials JSON's stain_effects/ingestion_effects use `id = noita lua index + 1`
 * (1-based), so the renderer subtracts 1 before indexing into this array.
 *
 * Output: noitamap/public/assets/material_effects.json
 */

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const ZIP_INPUT = path.resolve(__dirname, "..", "public", "data.zip");
const ZIP_ENTRY = "data/scripts/status_effects/status_list.lua";
const CSV_INPUT = path.resolve(__dirname, "..", "public", "game-translations", "common.csv");
const OUTPUT = path.resolve(__dirname, "..", "public", "assets", "material_effects.json");

function parseStatusList(lua) {
  // Drop everything inside Lua block comments so commented-out entries don't sneak in.
  const cleaned = lua.replace(/--\[\[[\s\S]*?\]\]--?/g, "");

  // Each table entry is `{ ... }`. Match top-level entries inside `status_effects = { ... }`.
  // Strategy: find `id="..."` lines and grab the surrounding entry by walking outward.
  const entries = [];
  const re = /\{\s*([\s\S]*?)\s*\}/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const block = m[1];
    const idMatch = block.match(/id\s*=\s*"([^"]+)"/);
    if (!idMatch) continue;
    // Only top-level status effects have ui_name; child tables (like Graphics) don't.
    const uiNameMatch = block.match(/ui_name\s*=\s*"([^"]+)"/);
    const uiDescMatch = block.match(/ui_description\s*=\s*"([^"]+)"/);
    if (!uiNameMatch) continue;
    entries.push({
      id: idMatch[1],
      ui_name: uiNameMatch[1],
      ui_description: uiDescMatch ? uiDescMatch[1] : null,
    });
  }
  return entries;
}

/**
 * Parse CSV without dragging in a dependency. Format:
 *   key,en,ru,pt-br,...
 * Fields can be quoted to embed commas; \n is literal in the file.
 * We only care about column 0 (key) and column 1 (English).
 *
 * Important: in noita, when a key appears twice, the LATER row overrides the
 * earlier one (matches the engine's load behavior). So we always overwrite.
 */
function parseCsv(csv) {
  const map = new Map();
  const rows = csv.split(/\r?\n/);
  for (const row of rows) {
    if (!row) continue;
    const fields = parseCsvRow(row);
    if (fields.length < 2) continue;
    const key = fields[0];
    const en = fields[1];
    if (!key) continue;
    map.set(key, en);
  }
  return map;
}

function parseCsvRow(row) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function resolveKey(map, refOrLiteral) {
  if (!refOrLiteral) return null;
  if (refOrLiteral.startsWith("$")) {
    return map.get(refOrLiteral.slice(1)) ?? null;
  }
  return refOrLiteral;
}

async function main() {
  const zipBuf = fs.readFileSync(ZIP_INPUT);
  const zip = await JSZip.loadAsync(zipBuf);
  const entry = zip.file(ZIP_ENTRY);
  if (!entry) {
    console.error(`[generate-material-effects] '${ZIP_ENTRY}' not found in ${ZIP_INPUT}`);
    process.exit(1);
  }
  const lua = await entry.async("string");
  const csv = fs.readFileSync(CSV_INPUT, "utf-8");

  const entries = parseStatusList(lua);
  const trans = parseCsv(csv);

  const out = entries.map((e) => ({
    statusId: e.id,
    name: resolveKey(trans, e.ui_name),
    description: resolveKey(trans, e.ui_description),
  }));

  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(out);
  fs.writeFileSync(OUTPUT, json);
  const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
  console.log(`[generate-material-effects] Wrote ${OUTPUT} (${sizeKB} KB, ${out.length} entries)`);

  // Sanity print a few key entries
  const checks = [
    [0, "WET"], [1, "OILED"], [2, "BLOODY"], [3, "SLIMY"],
    [4, "RADIOACTIVE"], [5, "ALCOHOLIC"], [6, "POISONED"],
    [7, "TELEPORTATION"], [8, "UNSTABLE_TELEPORTATION"],
    [15, "CHARM"], [16, "INVISIBILITY"],
  ];
  for (const [i, expectedId] of checks) {
    const e = out[i];
    if (!e) {
      console.warn(`  [warn] index ${i}: missing (expected ${expectedId})`);
      continue;
    }
    const ok = e.statusId === expectedId ? "ok" : "MISMATCH";
    console.log(`  [${ok}] idx ${i}: ${e.statusId} → ${e.name}`);
  }
}

main().catch((err) => {
  console.error("[generate-material-effects] Failed:", err);
  process.exit(1);
});
