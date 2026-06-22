/**
 * POI name coverage - guards against raw snake_case POI names.
 *
 * Telescope POI data carries the entity XML *basename* (e.g. "roboguard_big").
 * The card title / search label resolve a name via `animal_<id>` in
 * game-translations/common.csv, with a CREATURE_DATA fallback. When the filename
 * differs from the in-game name key (variant skins like roboguard_big ->
 * animal_piranha), BOTH miss and the UI falls back to the humanized filename
 * ("roboguard big") - and the wiki link breaks too.
 *
 * canonicalEntityId() remaps those filenames to the real creature id. This test
 * enumerates every entity referenced in the telescope enemy spawn tables and
 * asserts each resolves to a real name, so a future data update that introduces
 * a new mismatch fails here instead of shipping a broken label.
 *
 * Entities Noita itself leaves nameless (no ui_name/name in the XML: traps,
 * nests, props) are listed in KNOWN_NAMELESS - they legitimately have no
 * official translation and fall back to a CREATURE_DATA English name or are not
 * surfaced as creature cards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { canonicalEntityId } from "../src/telescope/entity-canonical";
import { CREATURE_DATA } from "../src/data/creature-data";

const LIB_DIR = join(__dirname, "..", "lib", "noita-telescope");
const COMMON_CSV = join(__dirname, "..", "src", "game-translations", "common.csv");

// Entities with no in-game name key (verified against data.zip entity XMLs).
// These are traps / nests / props / structural enemies Noita never names; they
// either fall back to a CREATURE_DATA English wiki name or are environmental.
const KNOWN_NAMELESS = new Set([
  "arrowtrap_left", "arrowtrap_right", "firetrap_left", "firetrap_right",
  "spittrap_left", "spittrap_right", "thundertrap_left", "thundertrap_right",
  "statue_trap_left", "statue_trap_right",
  "firebugnest", "flynest", "spidernest",
  "ghost_crystal", "lukki_eggs", "physics_cocoon", "walleye", "wallmouth",
  // Easter item (data/entities/items/easter/beer_bottle.xml), name key
  // item_kaljapullo - an item, not an animal_ creature key; not a creature card.
  "beer_bottle",
  "statue_rock_01", "statue_rock_02", "statue_rock_03", "statue_rock_04",
  "statue_rock_05", "statue_rock_06", "statue_rock_07", "statue_rock_08",
  "statue_rock_09", "statue_rock_10", "statue_rock_11", "statue_rock_12",
]);

function collectEntityIds(): string[] {
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|json)$/.test(f)) files.push(p);
    }
  })(LIB_DIR);
  const re = /data\/entities\/[a-zA-Z0-9_\/]+\.xml/g;
  const set = new Set<string>();
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) set.add(m[0].replace(".xml", "").split("/").pop()!);
  }
  return [...set].sort();
}

function commonCsvKeys(): Set<string> {
  const csv = readFileSync(COMMON_CSV, "utf8");
  return new Set([...csv.matchAll(/^(animal_[a-z0-9_]+),/gm)].map((m) => m[1]));
}

describe("POI name coverage", () => {
  const ids = collectEntityIds();
  const keys = commonCsvKeys();

  it("every spawnable entity resolves to a real name (no raw snake_case)", () => {
    const broken: string[] = [];
    for (const id of ids) {
      if (KNOWN_NAMELESS.has(id)) continue;
      const canon = canonicalEntityId(id);
      const hasTranslation = keys.has(`animal_${canon}`);
      const hasCreatureData = !!CREATURE_DATA[canon];
      if (!hasTranslation && !hasCreatureData) broken.push(`${id} -> animal_${canon}`);
    }
    expect(broken, `entities with no resolvable name:\n${broken.join("\n")}`).toEqual([]);
  });

  it("canonical remap targets have a common.csv translation", () => {
    // Specific known variant -> canonical fixes (task 17). Guards that each
    // remap actually lands on a translated key.
    const cases: [string, string][] = [
      ["roboguard_big", "animal_piranha"],
      ["basebot_soldier", "animal_soldier"],
      ["basebot_sentry", "animal_sentry"],
      ["basebot_hidden", "animal_hidden"],
      ["basebot_neutralizer", "animal_neutralizer"],
      ["zombie_weak", "animal_zombie"],
      ["miner_weak", "animal_miner"],
      ["boss_limbs_physics", "animal_boss_limbs"],
    ];
    for (const [id, expectedKey] of cases) {
      expect(`animal_${canonicalEntityId(id)}`, id).toBe(expectedKey);
      expect(keys.has(expectedKey), expectedKey).toBe(true);
    }
  });
});
