import { canonicalEntityId } from './entity-canonical';

/** New baked decorations include all mimic item icons. */
export const MIMIC_SPRITES_VERSION = 1;

/** Telescope emits these creatures as loot items, including inside chests.
 * Their names and animal icons still belong to the actual creature species. */
const MIMIC_ENTITIES = new Map([
  ['mimic', 'chest_mimic'],
  ['chest_leggy', 'chest_leggy'],
  ['heart_mimic', 'dark_alchemist'],
  ['refresh_mimic', 'shaman_wind'],
  ['mimic_potion', 'mimic_potion'],
]);
const MIMIC_ITEMS = new Map([...MIMIC_ENTITIES].map(([item, entity]) => [entity, item]));

export function getMimicEntityId(poi: { type: string; item?: unknown; entity?: unknown }): string | null {
  if (poi.type === 'item') return MIMIC_ENTITIES.get(String(poi.item)) ?? null;
  if (poi.type === 'entity' && poi.entity) {
    const entity = canonicalEntityId(String(poi.entity));
    return MIMIC_ITEMS.has(entity) ? entity : null;
  }
  return null;
}

export function getMimicSpriteKey(poi: { type: string; item?: unknown; entity?: unknown }): string | null {
  const entity = getMimicEntityId(poi);
  return entity ? `item:${MIMIC_ITEMS.get(entity)}` : null;
}
