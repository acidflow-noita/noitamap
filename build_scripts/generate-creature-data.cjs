/**
 * generate-creature-data.cjs
 *
 * Processes task/FULL_CREATURES_FINAL.json into a clean TypeScript data module
 * for use in:
 *   - Task 2: Creature aliases for search
 *   - Task 3b: Rich creature popup data
 *
 * Output: noitamap/src/data/creature-data.ts
 *
 * Usage:
 *   node build_scripts/generate-creature-data.cjs
 */

const fs = require("fs");
const path = require("path");

const INPUT = path.resolve(__dirname, "..", "..", "task", "FULL_CREATURES_FINAL.json");
const OUTPUT = path.resolve(__dirname, "..", "src", "data", "creature-data.ts");

// ─── HTML/Wiki markup cleaners ───────────────────────────────────────────────

/**
 * Parse the health HTML blob into a clean number.
 * Input example: '&lt;div class=&quot;noita-font hp-value&quot;&gt;...75[[File:...]]&lt;/div&gt;'
 * We want to extract just the number(s).
 */
function parseHealth(healthHtml) {
  if (!healthHtml) return null;
  // Decode HTML entities
  let s = healthHtml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
  // Strip all HTML tags
  s = s.replace(/<[^>]+>/g, " ");
  // Strip [[File:...]] wiki links
  s = s.replace(/\[\[File:[^\]]*\]\]/g, "");
  // Strip remaining [[ ]] wiki links
  s = s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");
  // Clean up whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Try to extract all HP values (some creatures have multiple: Normal 250, Vault 380, etc.)
  // Pattern: optional label + number + HP
  const entries = [];
  // Match patterns like "Normal 250" or just "75" or "Fungal Caverns 125"
  const labeledPattern = /([A-Za-z\s]*?)\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = labeledPattern.exec(s)) !== null) {
    const label = m[1].trim();
    const value = parseFloat(m[2]);
    if (!isNaN(value)) {
      entries.push(label ? `${label}: ${value}` : `${value}`);
    }
  }
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  return entries.join(", ");
}

/**
 * Strip wiki markup from a string.
 * [[Link|Display]] → Display, [[Link]] → Link
 * Also clean HTML entities.
 */
function cleanWikiText(text) {
  if (!text) return null;
  let s = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
  // Strip HTML tags
  s = s.replace(/<[^>]+>/g, "");
  // Convert [[Link|Display]] → Display
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  // Convert [[Link]] → Link
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  return s.trim() || null;
}

/**
 * Parse attack type string into a cleaner format.
 * Input: "Lunge/Dash/6.25, Melee/Melee/10-15"
 * Output: "Lunge (Dash) 6.25 dmg, Melee 10-15 dmg"
 */
function parseAttacks(attackStr) {
  if (!attackStr) return null;
  // Clean HTML/wiki first
  const cleaned = cleanWikiText(attackStr);
  if (!cleaned) return null;
  const parts = cleaned.split(",").map((p) => p.trim());
  const parsed = parts
    .map((part) => {
      const segs = part.split("/").map((s) => s.trim());
      if (segs.length >= 3) {
        const name = segs[0];
        const type = segs[1];
        const dmg = segs[2];
        // Handle optional 4th segment (e.g., "2.25/40F" for damage over time)
        const extra = segs[3] ? ` (${segs[3]})` : "";
        if (name === type) {
          return `${name}: ${dmg}${extra}`;
        }
        return `${name} (${type}): ${dmg}${extra}`;
      }
      return part;
    })
    .filter(Boolean);
  return parsed.join(", ") || null;
}

/**
 * Build damage multiplier object from creature fields.
 * Only includes non-default values (not "1x" or null).
 */
function parseDmgMults(creature) {
  const mults = {};
  const fields = [
    ["melee", creature.dmgMultMelee],
    ["projectile", creature.dmgMultProjectile],
    ["slice", creature.dmgMultSlice],
    ["explosion", creature.dmgMultExplosion],
    ["electricity", creature.dmgMultElectricity],
    ["fire", creature.dmgMultFire],
    ["ice", creature.dmgMultIce],
    ["drill", creature.dmgMultDrill],
    ["radioactive", creature.dmgMultRadioactive],
    ["holy", creature.dmgMultHoly],
  ];
  let hasAny = false;
  for (const [key, val] of fields) {
    if (val != null) {
      mults[key] = val;
      hasAny = true;
    }
  }
  return hasAny ? mults : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("[generate-creature-data] Reading FULL_CREATURES_FINAL.json...");
  const raw = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
  console.log(`[generate-creature-data] Found ${raw.length} creature entries`);

  const data = {};
  let skipped = 0;

  for (const c of raw) {
    // Must have an id to be usable (it maps to translation keys like animal_<id>)
    if (!c.id) {
      skipped++;
      continue;
    }

    // Skip duplicate ids — keep the first occurrence
    if (data[c.id]) continue;

    data[c.id] = {
      alias: cleanWikiText(c.alias) || null,
      name: cleanWikiText(c.name) || null,
      health: parseHealth(c.health),
      attacks: parseAttacks(c.attackType),
      spawnLocation: cleanWikiText(c.spawnLocation) || null,
      ngPlusSpawn: cleanWikiText(c.ngplusSpawnLocation) || null,
      immunities: cleanWikiText(c.immunities) || null,
      blood: cleanWikiText(c.blood),
      corpse: cleanWikiText(c.corpse),
      category: c.category || null,
      faction: c.faction || null,
      dmgMults: parseDmgMults(c),
    };
  }

  const count = Object.keys(data).length;
  console.log(`[generate-creature-data] Processed ${count} creatures (skipped ${skipped} without id)`);

  // Generate TypeScript module
  const tsContent = `/**
 * creature-data.ts
 *
 * Auto-generated from FULL_CREATURES_FINAL.json by generate-creature-data.cjs
 * DO NOT EDIT MANUALLY — re-run: node build_scripts/generate-creature-data.cjs
 *
 * Provides creature stats for:
 *   - Search aliases (Task 2)
 *   - Rich creature popups (Task 3b)
 */

export interface CreatureInfo {
  /** English common name (e.g., "Rat") */
  alias: string | null;
  /** Official Finnish name (e.g., "Rotta") */
  name: string | null;
  /** HP value(s) as string — may contain multiple (e.g., "Normal: 250, Vault: 380") */
  health: string | null;
  /** Attack summary (e.g., "Melee: 10-15, Lunge (Dash): 6.25") */
  attacks: string | null;
  /** Where the creature spawns */
  spawnLocation: string | null;
  /** NG+ spawn locations */
  ngPlusSpawn: string | null;
  /** Comma-separated immunities */
  immunities: string | null;
  /** Blood material */
  blood: string | null;
  /** Corpse material */
  corpse: string | null;
  /** Category (e.g., "Ghosts", "Slimes", "Monsters") */
  category: string | null;
  /** Faction (e.g., "ghost", "slimes", "helpless") */
  faction: string | null;
  /** Damage multipliers (only non-null entries) */
  dmgMults: Record<string, string> | null;
}

/**
 * Creature data keyed by creature id (e.g., "rat", "tentacler", "firemage").
 * The id maps to translation keys as \`animal_\${id}\`.
 */
export const CREATURE_DATA: Record<string, CreatureInfo> = ${JSON.stringify(data, null, 2)};

/**
 * Quick alias lookup: creature id → English alias.
 * Only includes creatures that have an alias.
 */
export const CREATURE_ALIASES: Record<string, string> = {
${Object.entries(data)
  .filter(([, v]) => v.alias)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v.alias)}`)
  .join(",\n")}
};
`;

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT, tsContent);
  const sizeKB = (Buffer.byteLength(tsContent) / 1024).toFixed(1);
  console.log(`[generate-creature-data] Wrote ${OUTPUT} (${sizeKB} KB, ${count} creatures)`);
  console.log("[generate-creature-data] Done.");
}

main();
