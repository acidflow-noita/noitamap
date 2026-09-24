import { gameTranslator } from "../game-translations/translator";
import i18next from "../i18n";
import spells from "../data/spells.json";
import { perkNameKey } from "./perk-i18n";
import { canonicalEntityId } from "./entity-canonical";
import { CREATURE_DATA } from "../data/creature-data";
import { getMimicEntityId } from './poi-mimics';

const spellNames = new Map(spells.map((spell) => [spell.id, spell.name]));
/** Telescope loot ids are not always the game's translation keys. */
const ITEM_KEYS: Record<string, string> = {
  wand: "item_wand",
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

/** Telescope names can be an adjective, a full wand name, or a named special
 * wand. Keep that identity and add the game's localized item word once.
 * Alive wands retain their separate canonical creature name after the adapter
 * replaces `name` with the procedural adjective. */
export function formatWandName(poi: { name?: unknown; wandName?: unknown; isTaikasauva?: unknown; sprite?: unknown; nameKey?: unknown; [key: string]: unknown }): string {
  const translatedWand = gameTranslator.translateItem('item_wand');
  const wand = translatedWand !== 'item_wand' ? translatedWand : 'Wand';
  const translatedGhost = gameTranslator.translateItem('animal_wand_ghost');
  const ghost = translatedGhost !== 'animal_wand_ghost' ? translatedGhost : 'Taikasauva';
  const clean = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  let name = clean(poi.wandName) || clean(poi.name);
  let canonicalName = false;
  // The Tower's authored full names already contain the item word at the
  // beginning. Use their real common.csv keys rather than appending "wand".
  const tower = /^custom\/good_0([123])(?:\.png)?$/.exec(clean(poi.sprite));
  const towerNames: Record<string, string> = { 'Wand of Swiftness': '1', 'Wand of Destruction': '2', 'Wand of Multitudes': '3' };
  const nameKey = clean(poi.nameKey).replace(/^\$/, '') || (tower?.[1] || towerNames[name] ? `item_wand_good_${tower?.[1] || towerNames[name]}` : '');
  if (nameKey && nameKey !== 'item_wand') {
    const translated = gameTranslator.translateItem(nameKey);
    if (translated !== nameKey) { name = translated; canonicalName = true; }
  }
  const containsWord = (word: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(name);
  };
  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  let alive = poi.isTaikasauva === true;
  for (const prefix of [...new Set([ghost, 'Taikasauva'])]) {
    if (same(name, prefix) || same(name.slice(0, prefix.length + 1), `${prefix} `)) {
      alive = true;
      name = name.slice(prefix.length).trim();
      break;
    }
  }
  const cjkWand = /[\u3000-\u9fff\uac00-\ud7af]/u.test(wand);
  if (canonicalName && (containsWord(wand) || (cjkWand && name.endsWith(wand))))
    return `${alive ? `${ghost} ` : ''}${name}`;
  // Recognize the original English suffix as well as this locale's word.
  // CJK names may attach their item word directly, without a separating space.
  const suffixes = [...new Set([wand, 'wand'])].sort((a, b) => b.length - a.length);
  let separator = ' ';
  let removed: boolean;
  do {
    removed = false;
    for (const suffix of suffixes) {
      if (!same(name.slice(-suffix.length), suffix)) continue;
      const before = name.slice(0, -suffix.length);
      if (before && !/\s$/.test(before) && !/[\u3000-\u9fff\uac00-\ud7af]/u.test(suffix)) continue;
      if (before && !/\s$/.test(before)) separator = '';
      name = before.trimEnd(); removed = true; break;
    }
  } while (removed);
  if (!name) return alive ? ghost : wand;
  const named = containsWord(wand) || containsWord('wand') ? name : `${name}${separator}${wand}`;
  return `${alive ? `${ghost} ` : ''}${named}`;
}

export function getPOIDisplayName(poi: {
  type: string;
  [key: string]: any;
}): string {
  if (poi.type === 'shop') return String(i18next.t('poi.biomeShop', 'Biome shop'));
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
  const mimic = getMimicEntityId(poi);
  if (mimic) {
    const key = `animal_${mimic}`;
    const translated = gameTranslator.translateItem(key);
    return translated !== key ? translated : CREATURE_DATA[mimic]?.name || poi.name || mimic;
  }
  if (poi.type === "entity" && poi.entity) {
    const entity = canonicalEntityId(String(poi.entity));
    const key = `animal_${entity}`;
    const translated = gameTranslator.translateItem(key);
    return translated !== key ? translated : CREATURE_DATA[entity]?.name || poi.name || entity;
  }
  if (poi.type === "wand") return formatWandName(poi);
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
      ({ ambrosia: "magic_liquid_protection_all", just_death: "magic_liquid_death" } as Record<string, string>)[String(poi.material)]
        ?? String(poi.material);
    name += ` · ${gameTranslator.translateMaterial(materialKey)}`;
  }
  return name;
}
