import type { GenerationResult, POI } from "./telescope-adapter";

type Scene = { name: string; x: number; y: number };
type World = {
  pw: number;
  worldSize: number;
  worldCenter: number;
  biomeData: { pixels: ArrayLike<number>; w?: number };
  scenes: Scene[];
};

// Real bosses only. parallel_alchemist / parallel_tentacles are separate
// creatures, never aliases for their non-shadow counterparts.
const BOSS_TYPES: Record<string, string> = {
  boss_dragon: "dragon",
  boss_gate: "triangle_boss",
  boss_alchemist: "alchemist_boss",
  boss_limbs: "pyramid_boss",
  maggot_tiny: "tiny",
  fish_giga: "boss_fish",
  boss_spirit: "islandspirit",
  friend_boss: "friend",
  mestari_boss: "boss_wizard",
  dragon: "dragon",
  triangle_boss: "triangle_boss",
  alchemist_boss: "alchemist_boss",
  pyramid_boss: "pyramid_boss",
  tiny: "tiny",
  boss_fish: "boss_fish",
  islandspirit: "islandspirit",
  friend: "friend",
  boss_wizard: "boss_wizard",
  boss_ghost: "boss_ghost",
  boss_robot: "boss_robot",
  boss_meat: "boss_meat",
  boss_sky: "boss_sky",
  boss_pit: "boss_pit",
  boss_centipede: "boss_centipede",
};
const MAIN_ONLY = new Set([
  "tiny", "pyramid_boss", "boss_pit", "boss_fish", "boss_sky", "islandspirit", "boss_centipede",
]);
const bossType = (poi: POI) => BOSS_TYPES[poi.type === "entity" ? String(poi.entity) : poi.type];

// These biome scripts EntityLoad their boss without a PW guard:
// data/scripts/biomes/{mestari_secret,ghost_secret,roboroom,meatroom}.lua.
// Keep the map's existing display offsets (not exact entity spawn pixels),
// but anchor them to the actual biome cell, in the actual world's dimensions.
// Names/nameKeys are the existing common.csv entries, not inferred translations.
const ROOM_BOSSES = [
  {
    color: 0x1f3b62, biome: "mestari_secret", dx: 285, dy: 330,
    type: "boss_wizard", name: "Mestarien mestari", nameKey: "animal_boss_wizard",
    items: [
      { type: "item", item: "wandstone", nameKey: "item_wandstone", name: "Sauvan Ydin" },
      ...["RESET", "ADD_TRIGGER", "ADD_TIMER", "ADD_DEATH_TRIGGER", "DUPLICATE"].map(
        (spell) => ({ type: "item", item: "spell", spell }),
      ),
    ],
  },
  {
    color: 0x1f3b64, biome: "ghost_secret", dx: 256, dy: 256,
    type: "boss_ghost", name: "Unohdettu", nameKey: "animal_boss_ghost",
    items: [
      { type: "item", item: "sunseed", name: "Sun Seed" },
      { type: "item", item: "full_heal", name: "Full Health Regeneration" },
    ],
  },
  {
    color: 0x9d893d, biome: "roboroom", dx: 163, dy: 371,
    type: "boss_robot", name: "Kolmisilmän silmä", nameKey: "animal_boss_robot",
    items: [{ type: "item", item: "perk", perk: "map", name: "Spatial Awareness" }],
  },
  {
    color: 0x796620, biome: "meatroom", dx: 259, dy: 256,
    type: "boss_meat", name: "Kolmisilmän sydän", nameKey: "animal_boss_meat",
    items: [{ type: "wand", sprite: "custom/chainsaw", name: "Saha" }],
  },
];

/** One policy after BOTH main-thread and PW-worker generation. Also used by
 * the baker through generateDynamicMap; never duplicate native RNG boss loot.
 * Missing room biomes (e.g. NG+/Nightmare) do not get invented fixed bosses.
 */
export function completeBossPOIs(pois: POI[], world: World): POI[] {
  const result: POI[] = [];
  const seen = new Map<string, number>();
  for (let poi of pois) {
    const type = bossType(poi);
    if (!type) {
      result.push(poi);
      continue;
    }
    if (world.pw !== 0 && MAIN_ONLY.has(type)) continue;
    if (type === "boss_robot") {
      poi = { ...poi, name: "Kolmisilmän silmä", nameKey: "animal_boss_robot" };
    }
    // NG+ can contain several dragons at different locations. Collapse only
    // repeat emissions of the SAME dragon (including vertical-scan repeats).
    const key = type === "dragon" ? `${type}:${poi.x},${poi.y}` : type;
    const index = seen.get(key);
    if (index === undefined) {
      seen.set(key, result.length);
      result.push(poi);
    } else if (result[index].type !== type && poi.type === type) {
      result[index] = poi; // Prefer the native loot-bearing boss over an entity alias.
    }
  }

  const add = (poi: POI) => {
    const type = bossType(poi);
    if (type && seen.has(type)) return;
    if (type) seen.set(type, result.length);
    result.push(poi);
  };
  const pixels = world.biomeData.pixels;
  const width = world.biomeData.w || pixels.length / 48;
  if (!Number.isInteger(width) || width <= 0) return result;
  const offsetX = world.pw * world.worldSize * 512;
  for (let i = 0; i < pixels.length; i++) {
    const room = ROOM_BOSSES.find((r) => r.color === (pixels[i] & 0xffffff));
    if (!room) continue;
    const x = ((i % width) - world.worldCenter) * 512 + offsetX;
    const y = (Math.floor(i / width) - 14) * 512;
    add({
      type: room.type, name: room.name, nameKey: room.nameKey, biome: room.biome,
      x: x + room.dx, y: y + room.dy,
      items: room.items.map((item) => ({ ...item })),
    });
  }

  // friend_1..6.lua use the same SetRandomSeed(24, 32) in every world.
  // Use Telescope's already-selected inhabited cavern, not a second RNG roll
  // or an empty friendroom. Preserve the existing representative companion
  // marker and display spacing; the cavern itself contains no entity sprites.
  for (const scene of world.scenes) {
    if (scene.name !== "cavern") continue;
    const col = Math.floor((scene.x - offsetX) / 512) + world.worldCenter;
    const row = Math.floor(scene.y / 512) + 14;
    if (col < 0 || col >= width || row < 0 || row >= 48) continue;
    const room = (pixels[row * width + col] & 0xffffff) - 0x6db559;
    if (room < 1 || room > 6) continue;
    const biome = `friend_${room}`;
    add({
      type: "friend", name: "Toveri", nameKey: "animal_friend", biome,
      x: scene.x + 256, y: scene.y + 256,
      items: [{ type: "item", item: "full_heal", name: "Full Health Regeneration" }],
    });
    if (!result.some((p) => p.type === "entity" && p.entity === "ultimate_killer")) {
      result.push({
        type: "entity", entity: "ultimate_killer", name: "Kauhuhirviö", biome,
        x: scene.x + 186, y: scene.y + 256,
      });
    }
    for (let i = 0; i < result.length; i++) {
      const poi = result[i];
      if (poi.type === "item" && poi.item === "gourd" && poi.biome === biome) {
        result[i] = { ...poi, y: scene.y + 430 };
      }
    }
  }
  return result;
}

/** Repair previously baked POIs too; terrain pixels themselves have not changed. */
export function completeGenerationBossPOIs<T extends Pick<GenerationResult, "poisByPW" | "pixelScenesByPW" | "worldSize" | "worldCenter" | "biomeData">>(result: T): T {
  const poisByPW = { ...result.poisByPW };
  for (const [key, pois] of Object.entries(poisByPW)) {
    const [pw, vertical] = key.split(",").map(Number);
    if (vertical !== 0) continue;
    poisByPW[key] = completeBossPOIs(pois, {
      pw, worldSize: result.worldSize, worldCenter: result.worldCenter,
      biomeData: result.biomeData, scenes: result.pixelScenesByPW?.[key] ?? [],
    });
  }
  return { ...result, poisByPW };
}
