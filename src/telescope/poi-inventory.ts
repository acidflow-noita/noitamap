import type { GenerationResult, POI } from "./telescope-adapter";
import { isAchievementPillarSegment } from "../data/pillars";
import { CONTAINER_TYPES, CHEST_ONLY_TYPES } from "./poi-containers";

/** These contain conditional rewards, not items already present in the seed.
 * Do not infer this from coordinates or from CONTAINER_TYPES: that set also
 * includes real shops, spawn groups, loadouts, and fixed scene pickups.
 *
 * Kolmisilmä (boss_centipede) is deliberately absent: its Sampo is already on
 * the pedestal BEFORE the fight. It remains an independently searchable item. */
export const BOSS_REWARD_TYPES = new Set([
  "triangle_boss",
  "alchemist_boss",
  "pyramid_boss",
  "dragon",
  "boss_spirit",
  "boss_wizard",
  "boss_ghost",
  "friend",
  "boss_sky",
  "islandspirit",
  "boss_robot",
  "boss_meat",
  "boss_pit",
  "boss_fish",
  "tiny",
]);

export type WorldPOI = POI & {
  pw: number;
  worldX: number;
  worldY: number;
  parentType?: string;
  parentId?: string;
  /** Display only: these objects are already emitted as independent records. */
  previewItems?: POI[];
  /** Conditional loot, intentionally absent from world-object search/counts. */
  rewards?: POI[];
};

/** Preserve card previews without reintroducing them into the counted data.
 * Only UI rendering should combine these fields. World totals use the flat
 * records; loot-specific totals may inspect unexpanded `items`, never count
 * previews again, and must distinguish conditional rewards. */
export function getPoiPreviewItems(poi: {
  [key: string]: unknown;
  items?: unknown;
  previewItems?: unknown;
  rewards?: unknown;
}): POI[] | undefined {
  for (const values of [poi.items, poi.previewItems, poi.rewards]) {
    if (Array.isArray(values)) return values;
  }
  return undefined;
}

/** Shared search / Pro stats inventory, projected from live OR baked/cached
 * generation. Never mutate the raw generation: map markers and boss tooltips
 * still need the original loot, and changing counts must not require a rebake.
 *
 * An item is owned exactly once: either inside an unexpanded chest's `items`,
 * or as a standalone world record. Boss loot is separate `rewards` metadata. */
export function getAllPOIsFlat(
  result: Pick<GenerationResult, "poisByPW">,
): WorldPOI[] {
  const flat: WorldPOI[] = [];
  for (const [pwKey, pois] of Object.entries(result.poisByPW)) {
    const pw = Number.parseInt(pwKey.split(",")[0], 10);
    for (const poi of pois) {
      if (poi.item === "pillar_segment" && !isAchievementPillarSegment(poi))
        continue;
      const children = Array.isArray(poi.items)
        ? poi.items.filter((item: POI) => !item.ignore)
        : [];
      const isSpawnGroup = poi.type === "enemies" || poi.type === "props";
      const isRewardOwner = BOSS_REWARD_TYPES.has(poi.type);
      const expands =
        CONTAINER_TYPES.has(poi.type) && !CHEST_ONLY_TYPES.has(poi.type);
      const position = { pw, worldX: poi.x, worldY: poi.y };

      if (!isSpawnGroup) {
        if (isRewardOwner || expands) {
          const { items: _items, ...identity } = poi;
          flat.push({
            ...identity,
            ...position,
            ...(isRewardOwner
              ? { rewards: children }
              : { previewItems: children }),
          });
        } else {
          flat.push({ ...poi, ...position });
        }
      }
      if (expands && !isRewardOwner) {
        for (const child of children) {
          flat.push({
            ...child,
            pw,
            parentType: poi.type,
            parentId: poi.id,
            biome: child.biome || poi.biome,
            worldX: child.x ?? poi.x,
            worldY: child.y ?? poi.y,
          });
        }
      }
    }
  }
  return flat;
}
