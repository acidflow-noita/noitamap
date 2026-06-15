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
  // Section headers / status text used by the extended-info popup section.
  { key: "extended.title", en: "Extended info" },
  { key: "extended.loading", en: "Loading..." },
  { key: "extended.cta", en: "Unlock with Pro" },
  { key: "extended.dmgMults", en: "Damage multipliers" },
  { key: "extended.damage", en: "Damage" },
  { key: "extended.tiers", en: "Tier spawn rate" },
  { key: "extended.stainEffects", en: "Stain effects" },
  { key: "extended.ingestionEffects", en: "Ingestion effects" },
  { key: "extended.reactionsHeader", en: "Material reactions on Bartender" },
  { key: "extended.asReagent", en: "View as reagent" },
  { key: "extended.asProduct", en: "View as product" },

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
  { key: "poi.horde", en: "Horde" },
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

// ─── gameContent.items.* — POI labels used by the popup card ────────────────
// Each key here maps a raw POI label (the value telescope-osd-bridge.ts /
// overlays.ts pass to gameTranslator.translateItem) to the matching CSV row
// that holds the localised display name. Build-time only — runtime is just a
// plain i18next.t() lookup against the static JSON.
//
// Coverage spans the items emitted by Noita's POI scanner: wands, chests,
// potions, pouches, runestones, eggs, shops, hearts, musicstones, sampo,
// evil eye, etc. Generic types like "chest" / "great_chest" point at the
// closest CSV row so EN gets the proper UI name ("Treasure chest") rather
// than the snake_case key.
const POI_NAME_TO_CSV_KEY = {
  // Wands — generic + specific in-game wand variants.
  "Wand": "item_wand",
  "wand": "item_wand",
  "wand_unshuffle": "item_wand",
  "broken_wand": "item_broken_wand",
  "wand_kiekurakeppi": "item_wand_kiekurakeppi",
  "wand_valtikka": "item_wand_valtikka",
  "wand_ruusu": "item_wand_ruusu",
  "wand_riimusauva": "item_wand_riimusauva",
  "wand_arpaluu": "item_wand_arpaluu",
  "wand_varpuluuta": "item_wand_varpuluuta",
  "vault_puzzle_arpaluu": "item_wand_arpaluu",
  "vault_puzzle_varpuluuta": "item_wand_varpuluuta",
  "vasta": "item_vasta",
  "vihta": "item_vihta",

  // Spells.
  "spell": "inventory_actiontype_other",
  "Spell": "inventory_actiontype_other",
  "spell_refresh": "item_spell_refresh",

  // Potions / pouches / jars.
  "potion": "item_potion",
  "potion_normal": "item_potion",
  "potion_random": "item_potion",
  "potion_secret": "item_potion",
  "potion_mimic_empty": "item_potion_empty",
  "mimic_potion": "item_potion",
  "flask": "item_potion",
  "pouch": "item_powder_stash_3",
  "powder_stash": "item_powder_stash",
  "powder_pouch": "item_powder_stash_3",
  "jar": "item_jar",

  // Gold / hearts.
  "gold": "mat_gold",
  "goldnugget": "item_goldnugget",
  "heart": null,                       // localized via poi.heartSmall i18n key
  "heart_bigger": null,                // localized via poi.heartBig i18n key
  "heart_mimic": "animal_dark_alchemist",  // "Pahan muisto" — heart mimic's in-game entity name (NOT item_potion_mimic = the potion mimic)
  "full_heal": null,                   // localized via poi.fullHeal i18n key

  // Orbs.
  "orb": "item_orb",
  "true_orb": "item_orb",
  "shiny_orb": "item_orb",
  "greed_orb": "item_greed_crystal",

  // Chests + chest types.
  "chest": "item_chest_treasure",
  "great_chest": "item_chest_treasure_super",
  "pacifist_chest": "item_chest_treasure_pacifist",
  "treasure": "item_chest_treasure",
  "chest_dark": "item_chest_dark",
  "chest_light": "item_chest_light",
  "chest_leggy": "item_chest_treasure",

  // Shops / rooms (use biome rows since the CSV has no item_* match).
  "holy_mountain_shop": "biome_holymountain",
  "shop": "biome_shop_room",
  "eye_room": "biome_boss_sky",
  "greed_room": "biome_greed_room",

  // Musical instruments / runestones / story items.
  "ocarina": "item_ocarina",
  "kantele": "item_kantele",
  "musicstone": "item_musicstone",
  "music_machine": "item_musicstone",
  "sampo": "item_mcguffin_12",
  "kuu": "item_moon",
  "moon": "item_moon",
  "ukkoskivi": "item_thunderstone",
  "thunderstone": "item_thunderstone",
  "kakkakikkare": "item_kakka",
  "paha_silma": "item_evil_eye",
  "evil_eye": "item_evil_eye",
  "sunseed": "item_sunseed",
  "wandstone": "item_wandstone",
  "key": "item_key",
  "crystal_key": "item_key",
  "emerald_tablet": "booktitle00",

  // Eggs.
  "egg": "item_egg",
  "egg_fire": "item_egg_fire",
  "egg_monster": "item_egg_worm",
  "egg_purple": "item_egg_purple",
  "egg_slime": "item_egg_slime",
  "egg_hollow": "item_egg_hollow",
  "egg_worm": "item_egg_worm",

  // Bombs / dies / gourd / greed.
  "bomb": "action_bomb",
  "gourd": "item_gourd",
  "greed_die": "item_greed_die",
  "greed_crystal": "item_greed_crystal",
  "chaos_die": "item_greed_die",       // no exact CSV match; keep close family
  "fire_die": "item_greed_die",
  "heart_die": "item_greed_die",

  // Runestones (full set from the CSV).
  "runestone_laser": "item_runestone_laser",
  "runestone_fireball": "item_runestone_fireball",
  "runestone_lava": "item_runestone_lava",
  "runestone_disc": "item_runestone_disc",
  "runestone_null": "item_runestone_null",
  "runestone_slow": "item_runestone_slow",

  // Portals.
  "portal": "streamingevent_portal_random",
  "buried_eye_teleporter": "streamingevent_portal_random",

  // Misc / no good CSV match (fall back to capitalised label).
  "Heart": null,
  "Spell book": null,
  "music_speaker": null,
  "altar_inert": null,
  "meditation_cube": null,
  "mimic": null,
  "blocked_by_unlock": null,
  "kivi": null,
  "kummitus": null,
  "vuoksikivi": null,
  "kiuaskivi": null,
  "oil_receptacle_puzzle": null,
  "water_receptacle_puzzle": null,
  "steam_receptacle_puzzle": null,
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

    // gameContent.items.<poi-name> — generic POI labels (Wand, potion, chest,
    // orb, …). These match the strings telescope-osd-bridge.ts passes to
    // gameTranslator.translateItem, so the runtime path is just an i18next
    // lookup against the JSON. Unlike the KEYS table above we DO use the CSV
    // value for the EN locale here so popups read "Treasure chest" / "Potion"
    // / "Wand" / etc. — the proper UI display names — instead of the raw
    // lowercase POI keys.
    for (const [poiName, csvKey] of Object.entries(POI_NAME_TO_CSV_KEY)) {
      const dottedKey = `gameContent.items.${poiName}`;
      // First try the locale's own CSV column. If that's blank (some rows
      // are flagged "doesn't need to be translated" for certain languages),
      // fall back to the EN column so the JSON gets a proper UI display name
      // ("Kuu", "Ukkoskivi", "Kantele", …) instead of the lowercase POI key.
      const fromCsv =
        csvValue(rows, colIndex, csvKey, csvCol) ||
        csvValue(rows, colIndex, csvKey, "en");
      if (fromCsv != null) {
        if (setNested(json, dottedKey, fromCsv, { force: true })) csvWrites++;
      } else {
        if (setNested(json, dottedKey, poiName, { force: false })) enFallbackAdds++;
      }
    }

    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${loc}: csv=${csvWrites}, en-fallback=${enFallbackAdds}`);
  }
}

main();
