import { gameTranslator } from "../game-translations/translator";
import i18next from "../i18n";
import spells from "../data/spells.json";
import { perkNameKey } from "./perk-i18n";

const spellNames = new Map(spells.map((spell) => [spell.id, spell.name]));
/** Telescope loot ids are not always the game's translation keys. */
const ITEM_KEYS: Record<string, string> = {
  kammi: "item_safe_haven",
  safe_haven: "item_safe_haven",
  kuu: "item_moon",
  ukkoskivi: "item_thunderstone",
  kiuaskivi: "item_brimstone",
  paha_silma: "item_evil_eye",
  chaos_die: "item_die",
  shiny_orb: "item_orb",
  chest: "item_chest_treasure",
  great_chest: "item_chest_treasure_super",
  potion: "item_potion",
  potion_normal: "item_potion",
  pouch: "item_powder_stash_3",
  powder_stash: "item_powder_stash",
  powder_stash_pouch: "item_powder_stash_3",
};
export function getPOIDisplayName(poi: {
  type: string;
  [key: string]: any;
}): string {
  const id =
    poi.type === "spell"
      ? poi.item
      : poi.item === "spell"
        ? poi.spell
        : undefined;
  if (id)
    return gameTranslator.translateSpell(
      spellNames.get(String(id)) ?? String(id),
    );
  if (poi.type === "wand" && poi.name) return String(poi.name);
  let key = poi.nameKey;
  if (!key && poi.type === "chest" && poi.chestVariant === "coral")
    key = "item_chest_light";
  if (!key && poi.type === "chest" && poi.chestVariant === "dark")
    key = "item_chest_dark";
  if (!key && poi.item === "perk" && poi.perk)
    key = perkNameKey(String(poi.perk));
  if (!key) key = ITEM_KEYS[String(poi.item ?? poi.type)];
  const raw = String(poi.item ?? poi.type);
  let name = key
    ? gameTranslator.translateItem(String(key))
    : gameTranslator.translateItem(raw);
  if (name === key || name === raw)
    name =
      poi.name ||
      raw.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase());
  if (["heart", "heart_bigger", "heart_extra"].includes(raw))
    name = String(
      i18next.t(raw === "heart" ? "poi.heartSmall" : "poi.heartBig", {
        defaultValue: "Health upgrade",
      }),
    );
  if (raw === "full_heal")
    name = String(
      i18next.t("gameContent.ui.item_full_health_regeneration", {
        defaultValue: "Full-health regeneration",
      }),
    );
  if (poi.material) {
    // Gameplay id differs from the common.csv key for this material.
    const materialKey =
      poi.material === "ambrosia"
        ? "magic_liquid_protection_all"
        : String(poi.material);
    name += ` · ${gameTranslator.translateMaterial(materialKey)}`;
  }
  return name;
}
