/** Visual/grouping containers. Being in this set does NOT make a boss's drops
 * already-spawned world objects. See the separate inventory projection. */
export const CONTAINER_TYPES = new Set([
  "holy_mountain_shop",
  "shop",
  "eye_room",
  "pacifist_chest",
  "triangle_boss",
  "alchemist_boss",
  "pyramid_boss",
  "dragon",
  "wand_altar",
  "snowy_room",
  "robot_egg",
  "chest",
  "great_chest",
  "utility_box",
  "laboratory",
  "enemies",
  "props",
  "boss_sky",
  "islandspirit",
  "boss_wizard",
  "boss_ghost",
  "boss_centipede",
  "boss_robot",
  "boss_meat",
  "boss_pit",
  "boss_fish",
  "tiny",
  "starting_loadout",
]);

/** Chest-like containers: show only the chest sprite on map, contents in popup/search only. */
export const CHEST_ONLY_TYPES = new Set([
  "chest",
  "pacifist_chest",
  "great_chest",
  "utility_box",
]);
