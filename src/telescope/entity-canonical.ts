// Telescope POI data carries the entity XML *basename* (e.g. "roboguard_big",
// "basebot_soldier"). Most map 1:1 to a creature id via `animal_<basename>`, but
// some entity files are size/variant skins whose in-game name lives under a
// DIFFERENT key - the `<Entity name="$animal_X">` attribute in the XML, not the
// filename. Without this remap the name key (`animal_roboguard_big`) and the
// CREATURE_DATA lookup both miss, so the card/search fall back to the raw
// snake_case filename ("roboguard big") and the wiki link breaks.
//
// Derived from data.zip entity XMLs (resolving <Base file> inheritance): for each
// entry the filename basename -> the canonical creature id used by `animal_<id>`
// in game-translations/common.csv AND by CREATURE_DATA. Stable; only changes with
// a Noita content update (which already requires re-baking the whole map).
const ENTITY_CANONICAL_ID: Record<string, string> = {
  acidshooter_weak: "acidshooter",
  basebot_hidden: "hidden",
  basebot_neutralizer: "neutralizer",
  basebot_sentry: "sentry",
  basebot_soldier: "soldier",
  boss_limbs_physics: "boss_limbs",
  chest_leggy: "lukki",
  miner_weak: "miner",
  roboguard_big: "piranha",
  shotgunner_weak: "shotgunner",
  slimeshooter_weak: "slimeshooter",
  tank_super: "tank",
  turret_left: "turret",
  turret_right: "turret",
  zombie_weak: "zombie",
};

/**
 * Canonical creature id for a telescope entity reference. Accepts a bare
 * basename ("roboguard_big"), a path ("data/entities/animals/roboguard_big.xml"),
 * or already-canonical id; returns the lowercased id used by `animal_<id>`
 * translation keys and CREATURE_DATA. Applies the variant->canonical remap.
 */
export function canonicalEntityId(rawEntity: string): string {
  const id = String(rawEntity)
    .toLowerCase()
    .replace(/\.xml$/, "")
    .split("/")
    .pop() as string;
  return ENTITY_CANONICAL_ID[id] || id;
}
