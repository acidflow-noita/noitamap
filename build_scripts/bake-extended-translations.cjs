#!/usr/bin/env node
/**
 * Bakes the static parts of the POI-card / extended-info translations into
 * each `src/locales/<lang>/translation.json`.
 *
 * Inputs (no network):
 *   - public/data/translations.csv        — game translations (common.csv)
 *
 * Outputs:
 *   - extended.row.*       — UI row labels (Faction, HP, Cast delay, …)
 *   - extended.dmg.*       — damage-type labels (Melee → 近接ダメージ, …)
 *   - extended.matType.*   — material types (Liquid, Solid, Powder, …)
 *   - extended.danger.*    — danger flags (fire, radioactive, …)
 *   - extended.immunity.*  — wiki immunity names (Kinetic, Venomous Curse, …)
 *   - extended.spawn.*     — spawn-location names (coal_pits → Coal Pits, …)
 *   - extended.yes
 *   - wand.*               — wand stat labels
 *   - common.yes / common.no
 *   - poi.*                — POI popup labels
 *
 * Behavior:
 *   - For every key with a csvKey, the matching CSV value is written for each
 *     non-English locale that has a CSV column. CSV is upstream; values are
 *     overwritten on every build so CSV updates flow through.
 *   - The English locale always gets the in-code English fallback.
 *   - Keys that have no csvKey AND the locale has no CSV column are LEFT
 *     ALONE if a value already exists (translator's edits / earlier gtx runs
 *     are preserved). If the key is missing entirely, the EN fallback is
 *     written so the key is at least present for translators to edit.
 *
 * Run via npm during build, or manually:
 *   node build_scripts/bake-extended-translations.cjs
 */

const fs = require("fs");
const path = require("path");

// Locale code (i.e. directory under src/locales) → CSV column header in
// public/data/translations.csv. null means the locale has no game-CSV column;
// translators fill those in by hand or via the manual gtranslate script.
const LOCALE_TO_CSV_COL = {
  en: "en",
  ru: "ru",
  br: "pt-br",
  es: "es-es",
  de: "de",
  fr: "fr-fr",
  it: "it",
  pl: "pl",
  zh: "zh-cn",
  ja: "jp",
  uk: "uk",
  nl: null,
  fi: null,
  cs: null,
  sv: null,
  id: null,
};

// ─── KEYS ──────────────────────────────────────────────────────────────────
//
// Each entry: { key, en, csvKey?: string }
//   csvKey  — common.csv row name. When present, the CSV value for the locale
//             is written; when absent, EN fallback is used (writes only if
//             the key is missing — see Behavior above).
const KEYS = [
  // Extended-info row labels.
  { key: "extended.row.faction", en: "Faction" },
  { key: "extended.row.hp", en: "HP" },
  { key: "extended.row.attacks", en: "Attacks" },
  { key: "extended.row.immunities", en: "Immunities" },
  { key: "extended.row.spawn", en: "Spawn" },
  { key: "extended.row.spawnNgplus", en: "Spawn (NG+)" },
  { key: "extended.row.blood", en: "Blood" },
  { key: "extended.row.corpse", en: "Corpse" },
  { key: "extended.row.polyChaos", en: "Polymorph (chaos)" },
  { key: "extended.row.polyUnstable", en: "Polymorph (unstable)" },
  { key: "extended.row.notes", en: "Notes" },
  { key: "extended.row.type", en: "Type", csvKey: "inventory_actiontype" },
  { key: "extended.row.mana", en: "Mana", csvKey: "inventory_manamax" },
  { key: "extended.row.uses", en: "Uses" },
  { key: "extended.row.castDelay", en: "Cast delay", csvKey: "inventory_castdelay" },
  { key: "extended.row.recharge", en: "Recharge", csvKey: "inventory_rechargetime" },
  { key: "extended.row.rechargeTime", en: "Recharge time", csvKey: "inventory_rechargetime" },
  { key: "extended.row.speed", en: "Speed", csvKey: "inventory_speed" },
  { key: "extended.row.spread", en: "Spread", csvKey: "inventory_spread" },
  { key: "extended.row.lifetime", en: "Lifetime" },
  { key: "extended.row.recoil", en: "Recoil" },
  { key: "extended.row.bounces", en: "Bounces" },
  { key: "extended.row.crit", en: "Crit" },
  { key: "extended.row.price", en: "Price" },
  { key: "extended.row.unlock", en: "Unlock" },
  { key: "extended.row.density", en: "Density" },
  { key: "extended.row.hardness", en: "Hardness" },
  { key: "extended.row.durability", en: "Durability" },
  { key: "extended.row.crackability", en: "Crackability" },
  { key: "extended.row.viscosity", en: "Viscosity" },
  { key: "extended.row.liquidGravity", en: "Liquid gravity" },
  { key: "extended.row.conductsElectricity", en: "Conducts electricity" },
  { key: "extended.row.slippery", en: "Slippery" },
  { key: "extended.row.burnable", en: "Burnable" },
  { key: "extended.row.alwaysBurning", en: "Always burning" },
  { key: "extended.row.autoignition", en: "Autoignition" },
  { key: "extended.row.freezesTo", en: "Freezes to" },
  { key: "extended.row.dangers", en: "Dangers" },
  { key: "extended.row.tags", en: "Tags" },
  { key: "extended.row.reactions", en: "Reactions" },

  // Damage-type labels — sourced from inventory_mod_damage_* rows so
  // non-English forms include the proper "ダメージ" / "Sch." suffix.
  { key: "extended.dmg.melee", en: "Melee", csvKey: "inventory_mod_damage_melee" },
  { key: "extended.dmg.projectile", en: "Projectile", csvKey: "inventory_actiontype_projectile" },
  { key: "extended.dmg.slice", en: "Slice", csvKey: "inventory_mod_damage_slice" },
  { key: "extended.dmg.explosion", en: "Explosion", csvKey: "inventory_mod_damage_explosion" },
  { key: "extended.dmg.electricity", en: "Electricity", csvKey: "inventory_mod_damage_electric" },
  { key: "extended.dmg.electric", en: "Electric", csvKey: "inventory_mod_damage_electric" },
  { key: "extended.dmg.fire", en: "Fire", csvKey: "inventory_mod_damage_fire" },
  { key: "extended.dmg.ice", en: "Ice", csvKey: "inventory_mod_damage_ice" },
  { key: "extended.dmg.drill", en: "Drill", csvKey: "inventory_mod_damage_drill" },
  { key: "extended.dmg.radioactive", en: "Radioactive", csvKey: "damage_radioactive" },
  { key: "extended.dmg.holy", en: "Holy", csvKey: "inventory_dmg_holy" },
  { key: "extended.dmg.healing", en: "Healing", csvKey: "inventory_mod_damage_healing" },

  // Material types.
  { key: "extended.matType.liquid", en: "Liquid" },
  { key: "extended.matType.solid", en: "Solid" },
  { key: "extended.matType.gas", en: "Gas" },
  { key: "extended.matType.fire", en: "Fire", csvKey: "damage_fire" },
  { key: "extended.matType.powder", en: "Powder" },

  // Danger flags.
  { key: "extended.danger.fire", en: "fire", csvKey: "damage_fire" },
  { key: "extended.danger.radioactive", en: "radioactive", csvKey: "damage_radioactive" },
  { key: "extended.danger.poison", en: "poison", csvKey: "damage_poison" },
  { key: "extended.danger.water", en: "water", csvKey: "damage_water" },

  { key: "extended.yes", en: "yes" },

  // Immunities — wiki section names. Where the same word is a damage type
  // in the CSV (fire, ice, electricity …) we share the JP/RU/etc.
  // translation; the rest stay as EN until a translator edits them.
  { key: "extended.immunity.breath", en: "Breath" },
  { key: "extended.immunity.burn", en: "Burn" },
  { key: "extended.immunity.curse", en: "Curse", csvKey: "damage_curse" },
  { key: "extended.immunity.electricity", en: "Electricity", csvKey: "damage_electricity" },
  { key: "extended.immunity.electrocution", en: "Electrocution" },
  { key: "extended.immunity.explosion", en: "Explosion", csvKey: "damage_explosion" },
  { key: "extended.immunity.fire", en: "Fire", csvKey: "damage_fire" },
  { key: "extended.immunity.freeze", en: "Freeze" },
  { key: "extended.immunity.freezestun", en: "Freeze stun" },
  { key: "extended.immunity.glue", en: "Glue" },
  { key: "extended.immunity.ice", en: "Ice", csvKey: "damage_ice" },
  { key: "extended.immunity.melee", en: "Melee", csvKey: "damage_melee" },
  { key: "extended.immunity.necro", en: "Necromancy" },
  { key: "extended.immunity.physics", en: "Kinetic" },
  { key: "extended.immunity.polymorph", en: "Polymorph", csvKey: "status_polymorph" },
  { key: "extended.immunity.projectile", en: "Projectile", csvKey: "inventory_actiontype_projectile" },
  { key: "extended.immunity.resurrection", en: "Resurrection" },
  { key: "extended.immunity.shock", en: "Shock" },
  { key: "extended.immunity.stun", en: "Stun" },
  { key: "extended.immunity.suffocation", en: "Suffocation" },
  { key: "extended.immunity.teleportation", en: "Teleport", csvKey: "status_teleportation" },
  { key: "extended.immunity.touch", en: "Touch Magic" },
  { key: "extended.immunity.touch_spell", en: "Touch Magic" },
  { key: "extended.immunity.venom", en: "Venomous Curse" },

  // Wand popup.
  { key: "wand.shuffle", en: "Shuffle", csvKey: "inventory_shuffle" },
  { key: "wand.spellsPerCast", en: "Spells/Cast" },
  { key: "wand.castDelay", en: "Cast Delay", csvKey: "inventory_castdelay" },
  { key: "wand.recharge", en: "Recharge", csvKey: "inventory_rechargetime" },
  { key: "wand.mana", en: "Mana", csvKey: "inventory_manamax" },
  { key: "wand.regen", en: "Regen", csvKey: "inventory_manachargespeed" },
  { key: "wand.capacity", en: "Capacity", csvKey: "inventory_capacity" },
  { key: "wand.spread", en: "Spread", csvKey: "inventory_spread" },
  { key: "wand.degAbbrev", en: "deg" },

  // Common Yes/No.
  { key: "common.yes", en: "Yes" },
  { key: "common.no", en: "No" },

  // POI labels.
  { key: "poi.amount", en: "Amount" },
  { key: "poi.contains", en: "Contains" },
  { key: "poi.gold", en: "Gold" },
  { key: "poi.biome", en: "Biome" },
  { key: "poi.heartSmall", en: "Heart (+25 HP)" },
  { key: "poi.heartBig", en: "Heart (+50 HP)" },
  { key: "poi.fullHeal", en: "Full Heal" },
  { key: "poi.heartShort", en: "+25 HP" },
  { key: "poi.heartBiggerShort", en: "+50 HP" },
];

// ─── extended.spawn.* ───────────────────────────────────────────────────────
// Wiki display name (full_creatures.json's spawnLocation field) → biome_*
// CSV row that holds the translations. Names with no CSV match keep the EN
// display value across every locale — translators can fix them by hand.
const SPAWN_NAME_TO_CSV_KEY = {
  "Mines": "biome_coalmine",
  "Collapsed Mines": "biome_coalmine_alt",
  "Coal Pits": "biome_excavationsite",
  "Fungal Caverns": "biome_fungicave",
  "Snowy Depths": "biome_snowcave",
  "Hiisi Base": "biome_snowcastle",
  "Underground Jungle": "biome_rainforest",
  "The Vault": "biome_vault",
  "Frozen Vault": "biome_vault_frozen",
  "Temple of the Art": "biome_crypt",
  "Lukki Lair": "biome_rainforest_dark",
  "Wizards' Den": "biome_wizardcave",
  "Wizards&#039; Den": "biome_wizardcave",
  "Overgrown Cavern": "biome_fun",
  "Power Plant": "biome_robobase",
  "Meat Realm": "biome_meat",
  "Pyramid": "biome_pyramid",
  "Lake": "biome_lake",
  "Lava Lake": "biome_lava",
  "Sandcave": "biome_sandcave",
  "Holy Mountain": "biome_holymountain",
  "Watchtower": "biome_watchtower",
  "Cloudscape": "biome_clouds",
  "Forgotten Cave": "biome_ghost_secret",
  "Throne Room": "biome_mestari_secret",
  "Snowy Chasm": "biome_winter_caves",
  "Snowy Wasteland": "biome_winter",
  "Magical Temple": "biome_wandcave",
  "The Tower": "biome_tower",
  "Ancient Laboratory": "biome_liquidcave",
  "Abandoned Alchemy Lab": "biome_secret_lab",
  "The Laboratory": "biome_boss_arena",
  "The Work (Sky)": "biome_boss_victoryroom",
  "The Work (Hell)": "biome_boss_victoryroom",
  "Kivi Temple": "biome_boss_sky",
  "Dragoncave": "biome_dragoncave",
  "Desert Chasm": "biome_desert",
  // Wiki names with no CSV match — EN value is used in every locale.
  "Forest": null,
  "Friend Room": null,
  "Giant Tree": null,
  "Lake Island": null,
  "Parallel Worlds": null,
  "Treasure Chest": null,
  "Buried skull": null,
};

// ─── helpers ────────────────────────────────────────────────────────────────

// Stable spawn-name → JSON-friendly slug. Keep in sync with the matching
// function in src/extended-info/index.ts (translateBiomeName) so runtime
// lookups land on the keys this script writes.
function spawnSlug(name) {
  return name
    .toLowerCase()
    .replace(/&#?\w+;/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === "," && !q) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function loadCsv() {
  const raw = fs
    .readFileSync(path.join(__dirname, "../public/data/translations.csv"), "utf8")
    .replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const header = parseCsvLine(lines[0]);
  const colIndex = {};
  header.forEach((h, i) => { if (h) colIndex[h] = i; });
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f[0]) rows.set(f[0], f);
  }
  return { rows, colIndex };
}

function setNested(obj, dottedKey, value, { force }) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (force || cur[last] === undefined || cur[last] === null || cur[last] === "") {
    cur[last] = value;
    return true;
  }
  return false;
}

function csvValue(rows, colIndex, csvKey, csvCol) {
  if (!csvKey || !csvCol || !rows.has(csvKey)) return null;
  const row = rows.get(csvKey);
  const idx = colIndex[csvCol];
  if (idx == null) return null;
  const v = (row[idx] || "").trim();
  return v || null;
}

// ─── main ───────────────────────────────────────────────────────────────────

function main() {
  const { rows, colIndex } = loadCsv();
  const localesDir = path.join(__dirname, "../src/locales");

  for (const [loc, csvCol] of Object.entries(LOCALE_TO_CSV_COL)) {
    const file = path.join(localesDir, loc, "translation.json");
    if (!fs.existsSync(file)) {
      console.warn(`skip ${loc} — no translation.json`);
      continue;
    }
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    let csvWrites = 0;
    let enFallbackAdds = 0;

    // Flat KEYS.
    for (const k of KEYS) {
      const fromCsv = loc !== "en" ? csvValue(rows, colIndex, k.csvKey, csvCol) : null;
      if (fromCsv != null) {
        // CSV is upstream — always write (overwrite).
        if (setNested(json, k.key, fromCsv, { force: true })) csvWrites++;
      } else {
        // No CSV value for this locale — only add the EN fallback when the
        // key is missing entirely. This preserves any prior translator
        // edits or values from the manual gtranslate script.
        if (setNested(json, k.key, k.en, { force: false })) enFallbackAdds++;
      }
    }

    // extended.spawn.* — same rule.
    for (const [enName, csvKey] of Object.entries(SPAWN_NAME_TO_CSV_KEY)) {
      const slug = spawnSlug(enName);
      const dottedKey = `extended.spawn.${slug}`;
      const fromCsv = loc !== "en" ? csvValue(rows, colIndex, csvKey, csvCol) : null;
      if (fromCsv != null) {
        if (setNested(json, dottedKey, fromCsv, { force: true })) csvWrites++;
      } else {
        if (setNested(json, dottedKey, enName, { force: false })) enFallbackAdds++;
      }
    }

    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${loc}: csv=${csvWrites}, en-fallback=${enFallbackAdds}`);
  }
}

main();
