/**
 * generate-reaction-roles.cjs
 *
 * Reads bartender's reactions.json (4 MB) and emits a slim role index:
 *   { "<materialId>": [r, p] }
 * where r=1 if the material appears as a reagent, p=1 if as a product.
 * Used by extended material popups to decide which bartender link(s) to show.
 *
 * Output: noitamap/public/assets/reaction_roles.json
 */

const fs = require("fs");
const path = require("path");

const INPUT = path.resolve(__dirname, "..", "build_data", "reactions.json");
const OUTPUT = path.resolve(__dirname, "..", "public", "assets", "reaction_roles.json");

function unwrap(name) {
  if (name == null) return null;
  // Bartender uses [tag] syntax for tag-based reactions; skip those - they're not material ids.
  if (typeof name === "string" && name.startsWith("[") && name.endsWith("]")) return null;
  return name;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
  const roles = {};

  const mark = (id, idx) => {
    const mat = unwrap(id);
    if (!mat) return;
    if (!roles[mat]) roles[mat] = [0, 0];
    roles[mat][idx] = 1;
  };

  for (const r of raw) {
    mark(r.input_cell1, 0);
    mark(r.input_cell2, 0);
    mark(r.input_cell3, 0);
    mark(r.output_cell1, 1);
    mark(r.output_cell2, 1);
    mark(r.output_cell3, 1);
  }

  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(roles));
  const count = Object.keys(roles).length;
  const sizeKB = (Buffer.byteLength(JSON.stringify(roles)) / 1024).toFixed(1);
  console.log(`[generate-reaction-roles] Wrote ${OUTPUT} (${sizeKB} KB, ${count} materials)`);
}

main();
