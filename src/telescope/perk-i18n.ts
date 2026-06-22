// Telescope perk ids (from lib/noita-telescope/js/perks.js) don't all match the
// suffix used by Noita's translation keys (perk_<suffix> / perkdesc_<suffix> in
// game-translations/common.csv). For most perks the suffix is just the lowercased
// id, but these six are spelled differently in the game data. Map id -> key suffix
// so name AND description lookups resolve instead of falling back to "Perk".
const PERK_I18N_REMAP: Record<string, string> = {
  fire_gas: "gas_fire",
  bleed_gas: "gas_blood",
  wand_radar: "radar_wand",
  item_radar: "radar_item",
  duplicate_projectile: "projectile_duplicate",
  peace_with_gods: "peace_with_steve",
};

/** Lowercased translation-key suffix for a telescope perk id. */
export function perkI18nSuffix(perkId: string): string {
  const id = String(perkId).toLowerCase();
  return PERK_I18N_REMAP[id] || id;
}

/** `perk_<suffix>` translation key for a telescope perk id. */
export function perkNameKey(perkId: string): string {
  return `perk_${perkI18nSuffix(perkId)}`;
}

/** `perkdesc_<suffix>` translation key for a telescope perk id. */
export function perkDescKey(perkId: string): string {
  return `perkdesc_${perkI18nSuffix(perkId)}`;
}
