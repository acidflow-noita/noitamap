/**
 * poi-spatial-index.ts
 *
 * Builds a Flatbush spatial index over all POIs from a GenerationResult,
 * and loads the static spritesheet + atlas for rendering markers.
 */

import Flatbush from "flatbush";
import type { GenerationResult, POI } from "./telescope-adapter";
import { applySpoilerFree } from "../spoiler-free";
import { isSkipCreatures } from "../skip-creatures";
import spells from "../data/spells.json";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Sprite offset X (hotspot X from left edge) */
  ox?: number;
  /** Sprite offset Y (hotspot Y from top edge) */
  oy?: number;
}

export interface MarkerItem {
  poi: POI;
  pw: number;
  spriteKey: string | string[];
  osdX: number;
  osdY: number;
  w: number;
  h: number;
}

export interface MarkerData {
  index: Flatbush;
  spritesheet: HTMLImageElement;
  atlas: Record<string, AtlasEntry>;
  items: MarkerItem[];
  /** Bounding box origin in OSD viewport coordinates. */
  originX: number;
  originY: number;
  /** Bounding box dimensions in OSD viewport coordinates. */
  bboxWidth: number;
  bboxHeight: number;
}

// ─── Spritesheet + Atlas cache ──────────────────────────────────────────────

let cachedSpritesheet: HTMLImageElement | null = null;
let cachedAtlas: Record<string, AtlasEntry> | null = null;

async function loadSpritesheet(): Promise<HTMLImageElement> {
  if (cachedSpritesheet) return cachedSpritesheet;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cachedSpritesheet = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = "./assets/spritesheet.png";
  });
}

async function loadAtlas(): Promise<Record<string, AtlasEntry>> {
  if (cachedAtlas) return cachedAtlas;
  // Bundled at build time so we don't trip CSP `connect-src` (the deployed
  // site has it set to `none`, which broke marker sprites on FF/Debian).
  const mod = await import("../data/atlas.json");
  cachedAtlas = (mod as any).default || (mod as any);
  return cachedAtlas!;
}

// ─── Coordinate conversion ─────────────────────────────────────────────────

// ─── Multi-frame sprite first-frame dimensions ─────────────────────────────
export const FIRST_FRAME_SIZE: Record<string, { w: number; h: number }> = {
  "item:torch": { w: 16, h: 16 },
  "item:heart": { w: 20, h: 20 },
  "item:heart_extrahp": { w: 20, h: 20 },
  "item:heart_extrahp_evil": { w: 20, h: 20 },
};

// ─── Container types ────────────────────────────────────────────────────────

const CONTAINER_TYPES = new Set([
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
const CHEST_ONLY_TYPES = new Set(["chest", "pacifist_chest", "great_chest"]);
// ─── Sprite key resolution ──────────────────────────────────────────────────

// Spell ID → atlas sprite key (handles ID/filename mismatches like
// LASER_LUMINOUS_DRILL → spell:luminous_drill_timer)
let _spellIdToSpriteKey: Map<string, string> | null = null;
function resolveSpellKey(spellId: string): string {
  if (!_spellIdToSpriteKey) {
    _spellIdToSpriteKey = new Map();
    for (const s of spells) {
      _spellIdToSpriteKey.set(s.id, `spell:${s.sprite.replace(/\.png$/, "")}`);
    }
  }
  // Some spawners emit lowercase ids (e.g. static_spawns' 'rainbow_trail');
  // spells.json ids are UPPERCASE, so normalize before the exact-match lookup.
  return (
    _spellIdToSpriteKey.get(spellId) ??
    _spellIdToSpriteKey.get(spellId.toUpperCase()) ??
    `spell:${spellId.toLowerCase()}`
  );
}

// Telescope wand `sprite` values that don't line up with any committed atlas
// `wand:` key. Map them to the real atlas key so they render on the map (the
// marker renderer only draws from the atlas — no per-marker data.zip fallback).
//
// NOTE: custom/kantele, custom/flute, and custom/experimental_wand_1/2 are NOT
// remapped here — build-spritesheet bakes rotated wand:custom/<name> sprites
// from their source PNGs, so resolveWandSpriteKey's full-path lookup finds them
// directly (correct image + correct tip-up orientation).
const WAND_SPRITE_REMAP: Record<string, string> = {};

// A handful of perk ids don't match their atlas icon filename (the atlas keys
// are item:perks/<icon filename>, not item:perks/<perk id>). Map the id to the
// real icon file so the marker/card/search icon resolves.
const PERK_ICON_REMAP: Record<string, string> = {
  wand_radar: "radar_wand",
  item_radar: "radar_item",
  moon_radar: "radar_moon",
  bleed_oil: "oil_blood",
  bleed_gas: "gas_blood",
  no_more_knockback: "no_player_knockback",
};

/** Atlas key for a perk id's in-world icon (item:perks/<icon filename>). */
export function perkAtlasKey(perkId: string): string {
  const id = String(perkId).toLowerCase();
  return `item:perks/${PERK_ICON_REMAP[id] || id}`;
}

/**
 * Resolve a telescope wand `sprite` string to an atlas key.
 *
 * Telescope sprites come as either a bare name ("wand_0001"), a "custom/<name>"
 * path, or a starting-loadout basename ("custom/handgun"). The baked atlas keys
 * are `wand:<relative path under items_gfx/wands>` — which for custom wands KEEPS
 * the "custom/" segment (wand:custom/good_01) but for handgun/bomb_wand is just
 * the basename (wand:handgun). So try, in order: explicit remap, the full path,
 * then the basename. Returns the first key present in the atlas; if none match
 * (atlas missing in tests, or sprite genuinely absent) falls back to the
 * full-path key so the data.zip fallback in getPOISpriteFirstFrame can try.
 */
function resolveWandSpriteKey(sprite: string, atlas?: Record<string, AtlasEntry>): string {
  const clean = sprite.replace(/\.png$/, "");
  const remapped = WAND_SPRITE_REMAP[clean];
  if (remapped) {
    if (!atlas || atlas[remapped]) return remapped;
  }
  const fullKey = `wand:${clean}`;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const baseKey = `wand:${base}`;
  if (atlas) {
    if (atlas[fullKey]) return fullKey;
    if (atlas[baseKey]) return baseKey;
    if (remapped && atlas[remapped]) return remapped;
  }
  return fullKey;
}

function getSpriteKey(poi: POI, atlas?: Record<string, AtlasEntry>): string | string[] | null {
  // Spells inside containers have {type: 'item', item: 'spell', spell: 'SPELL_ID'}
  if (poi.type === "item" && poi.item === "spell" && (poi as any).spell) {
    return resolveSpellKey(String((poi as any).spell));
  }

  if (poi.type === "spell" && (poi as any).item) {
    return resolveSpellKey(String((poi as any).item));
  }

  if (poi.type === "wand" && poi.sprite) {
    return resolveWandSpriteKey(poi.sprite, atlas);
  }

  if (poi.type === "item" && poi.item) {
    const item = poi.item;
    if (item === "potion" || item === "potion_normal") {
      const mat = (poi as any).material;
      if (atlas && mat) {
        const key = `item:potion:${mat}`;
        if (atlas[key]) return key;
      }
      return "item:potion";
    }
    if (item === "pouch" || item === "powder_stash_pouch") {
      const mat = (poi as any).material;
      if (atlas && mat) {
        const key = `item:pouch:${mat}`;
        if (atlas[key]) return key;
      }
      return "item:pouch";
    }
    if (item === "powder_stash") return "item:powder_stash";
    if (item === "gold" || item === "goldnugget") return "item:goldnugget_01";
    if (item === "heart") return "item:heart_extrahp";
    if (item === "heart_bigger" || item === "heart_extra") return "item:heart_extrahp";
    // Heart mimic ("Pahan muisto") disguises as the extra-HP heart pickup.
    if (item === "heart_mimic") return "item:heart_extrahp";
    if (item === "full_heal") return "item:heart";
    if (item === "chest") return "item:chest";
    if (item === "great_chest") return "item:chest_random_super";
    if (item === "chest_present") return "item:chest_present";
    if (item === "spell_refresh") return "item:spell_refresh";
    if (item === "broken_wand") return "item:broken_wand";
    if (item === "jar") return "item:jar";
    // The raw items_gfx bomb icon (item:bomb) is an 8x8 sprite that reads as a
    // gold blob on the map. Use the recognizable Bomb spell action icon instead.
    if (item === "bomb") return "spell:bomb";
    if (item === "bomb_holy") return "item:bomb_holy";
    if (item === "bomb_holy_giga") return "item:bomb_holy_giga";
    if (item === "torch") return "item:torch";
    // Wand Core (Sauvan Ydin): the items_gfx sprite is a tiny 8x8 stone; the
    // ui_gfx icon is the recognizable inventory version.
    if (item === "wandstone") return "ui_item:wandstone";
    // Essences (Essence of Earth/Air/Water/Spirits/Fire). The id carried in
    // `material` maps to atlas essence:<material>. Earth uses the 'laser' key.
    if (item === "essence") {
      const mat = (poi as any).material;
      if (mat) {
        const key = `essence:${mat}`;
        if (!atlas || atlas[key]) return key;
      }
      return "essence:laser";
    }
    if (item === "orb") {
      if ((poi as any).collected) return "item:orbs/orb"; // empty orb — spell already collected
      // Orb with spell still inside — show specific orb image
      const orbIdx = (poi as any).orbIndex;
      if (typeof orbIdx === "number") {
        const specificKey = `item:orbs/orb_${String(orbIdx).padStart(2, "0")}`;
        if (atlas && atlas[specificKey]) return specificKey;
      }
      return "item:orb"; // fallback
    }
    if (item === "perk") {
      // Parallel-world perks are travel-order dependent and unknowable — show
      // the "unidentified" question-mark sprite instead of a concrete perk.
      if ((poi as any).unknown) return "spell:unidentified";
      // Specific perk by id (e.g. {item:'perk', perk:'critical_hit'} →
      // item:perks/critical_hit). Falls back to the generic perk icon.
      const perkId = (poi as any).perk;
      if (perkId) {
        const id = String(perkId).toLowerCase();
        const key = `item:perks/${PERK_ICON_REMAP[id] || id}`;
        if (!atlas || atlas[key]) return key;
      }
      return "item:perk";
    }
    if (item === "emerald_tablet") return "item:emerald_tablet";
    if (item === "egg" || item.startsWith("egg_")) return `item:${item}`;
    // Karl (racecar) and Essence Eater have no item:* sprite — use the entity sprite.
    if (item === "karl") return "enemy:racing_cart";
    if (item === "essence_eater") return "enemy:essence_eater";
    // Kuulokivi: the items_gfx sprite is tiny; use the ui_gfx inventory icon.
    if (item === "musicstone") return "ui_item:musicstone";
    if (item === "music_machine") return "prop:music_machine";
    return `item:${item}`;
  }

  // Containers — show the chest sprite on the map
  if (poi.type === "chest") {
    // Crystal-Key chests use their own building sprite; regular chests use the
    // generic random-chest icon.
    const variant = (poi as any).chestVariant;
    if (variant === "dark") return "building:chest_dark";
    if (variant === "coral") return "building:chest_light";
    return "item:chest_random";
  }
  if (poi.type === "pacifist_chest") return "item:chest_random";
  if (poi.type === "great_chest") return "item:chest_random_super";
  if (poi.type === "shop") return null;
  if (poi.type === "holy_mountain_shop") return null; // HM shops are shown via their contents
  if (poi.type === "laboratory") return null;
  if (poi.type === "eye_room") return null;

  // Boss types — map to their full creature sprites in the atlas
  // Can be a string, or an array of strings to composite multiple sprite layers (drawn sequentially at 0,0 offset).
  const BOSS_SPRITE_KEYS: Record<string, string | string[]> = {
    alchemist_boss: "enemy:boss_alchemist_boss_alchemist",
    pyramid_boss: "enemy:boss_limbs_body",
    dragon: "enemy:dragon_head",
    boss_wizard: [
      "enemy:boss_wizard_wizard_body",
      "enemy:boss_wizard_wizard_hand",
      "enemy:boss_wizard_wizard_hand",
      "enemy:boss_wizard_wizard_head",
      "enemy:boss_wizard_wizard_helmet",
    ],
    boss_ghost: "enemy:boss_ghost_body",
    friend: "enemy:friend",
    boss_sky: "enemy:boss_sky_boss_sky",
    islandspirit: "enemy:boss_spirit_boss_spirit",
    boss_centipede: "enemy:boss_centipede_body",
    boss_robot: "enemy:boss_robot_body",
    boss_meat: "enemy:boss_meat_body",
    boss_pit: "enemy:boss_pit",
    // Syväolento (Leviathan): no body sprite in the atlas. Its eye (last open
    // frame, baked as enemy:boss_fish_eye_open) IS the boss marker.
    boss_fish: "enemy:boss_fish_eye_open",
    tiny: "enemy:maggot_tiny",
  };
  if (BOSS_SPRITE_KEYS[poi.type]) {
    return BOSS_SPRITE_KEYS[poi.type];
  }

  // Starting loadout (Mina's spawn): show the player character sprite as the
  // marker instead of nothing. Its contents (wands/flask) are unwrapped and
  // rendered separately above the player.
  if (poi.type === "starting_loadout") {
    return "enemy:player";
  }

  // Enemy/prop spawn containers — don't render the container itself, only inner items
  if (poi.type === "enemies" || poi.type === "props") {
    return null;
  }

  // Individual entity from an enemy spawn — map to atlas enemy sprite
  if (poi.type === "entity" && (poi as any).entity) {
    const entityName = String((poi as any).entity).toLowerCase();
    const key = `enemy:${entityName}`;
    if (atlas && atlas[key]) return key;
    return key; // return even if not in atlas — the renderer will skip if missing
  }

  // Wand altars / special wand sources — also skip base icons
  if (poi.type === "wand_altar" || poi.type === "snowy_room" || poi.type === "robot_egg") {
    return null;
  }

  return null;
}

// ─── Build marker data ──────────────────────────────────────────────────────

// ─── Marker Y-offset overrides ─────────────────────────────────────────────
// Some sprites need to be lifted up so they don't half-bury into the ground
// or the container they spawn on. Lookup is by atlas sprite key (the same
// key returned by getSpriteKey).
//
// 1. Exact match in MARKER_Y_OFFSET wins
// 2. Otherwise the first matching prefix in MARKER_Y_OFFSET_PREFIXES wins
// 3. Default is 0 (no shift)
//
// Negative numbers move the sprite UP. Coordinates are in OSD viewport units,
// which match world pixels at 1:1 — so -5 is "up by 5 in-game pixels".

const MARKER_Y_OFFSET: Record<string, number> = {
  // Hearts already include their visual stem in the sprite — no shift.
  "item:heart": 0,
  "item:heart_extrahp": 0,
  "item:heart_extrahp_evil": 0,
};

const MARKER_Y_OFFSET_PREFIXES: Array<{ prefix: string; offset: number }> = [
  // Wands need the most lift so they look held above the ground/altar.
  { prefix: "wand:", offset: -5 },
  // Items in pouches/potions/etc rest on a surface — slight lift.
  { prefix: "item:potion", offset: -3 },
  { prefix: "item:pouch", offset: -3 },
  { prefix: "item:bomb", offset: -3 },
  { prefix: "item:goldnugget", offset: -3 },
  // Generic item fallback (covers torch, broken_wand, jar, perk, egg, etc).
  { prefix: "item:", offset: -3 },
];

function resolveMarkerYOffset(spriteKey: string): number {
  if (MARKER_Y_OFFSET[spriteKey] !== undefined) return MARKER_Y_OFFSET[spriteKey];
  for (const { prefix, offset } of MARKER_Y_OFFSET_PREFIXES) {
    if (spriteKey.startsWith(prefix)) return offset;
  }
  return 0;
}

function addMarkerItem(
  items: MarkerItem[],
  poi: POI,
  pw: number,
  worldCenter: number,
  atlas: Record<string, AtlasEntry>,
): void {
  const keyRaw = getSpriteKey(poi, atlas);
  if (!keyRaw) return;
  const rootKey = Array.isArray(keyRaw) ? keyRaw[0] : keyRaw;
  if (!atlas[rootKey]) return;

  const entry = atlas[rootKey];
  const frame = FIRST_FRAME_SIZE[rootKey];
  const yOffset = resolveMarkerYOffset(rootKey);
  items.push({
    poi,
    pw,
    spriteKey: keyRaw,
    osdX: poi.x,
    osdY: poi.y + yOffset,
    w: frame ? frame.w : entry.w,
    h: frame ? frame.h : entry.h,
  });
}

/**
 * Add an invisible, clickable hit-area for a POI that is already painted into
 * the baked background (e.g. the Gate Guardian, whose sprite is captured when
 * the world background is rendered). spriteKey is empty so the marker renderer
 * skips drawing it, but it still lands in the Flatbush click index.
 */
function addClickOnlyMarker(items: MarkerItem[], poi: POI, pw: number, w = 64, h = 64): void {
  items.push({
    poi,
    pw,
    spriteKey: "",
    osdX: poi.x,
    osdY: poi.y,
    w,
    h,
  });
}

/** Boss container types whose drops should be offset to avoid overlapping the boss sprite. */
const BOSS_DROP_TYPES = new Set([
  "triangle_boss",
  "alchemist_boss",
  "pyramid_boss",
  "dragon",
  "boss_wizard",
  "boss_ghost",
  "boss_sky",
  "islandspirit",
  "boss_centipede",
  "boss_robot",
  "boss_meat",
  "boss_pit",
  "boss_fish",
  "tiny",
]);

/** Enemy/prop spawn containers: spread inner items to avoid overlap. */
const ENEMY_SPAWN_TYPES = new Set(["enemies", "props"]);

/**
 * Some "container" entities visually contain another entity that spawns when
 * the container is broken. Both are emitted as siblings in the POI's items
 * array, but rendering both produces duplicate markers (e.g. one Houre + one
 * Houre Crystal at the same spot). Skip the contained entity when its
 * container sibling is present.
 *
 * Format: [containerEntityPathRegex, containedEntityPathRegex].
 */
const CONTAINED_BY_SIBLING: Array<[RegExp, RegExp]> = [[/\/buildings\/ghost_crystal/, /\/animals\/ghost\.xml$/]];

function shouldSkipDueToContainer(item: any, siblings: any[]): boolean {
  const itemEntity = String(item?.entity || "");
  if (!itemEntity) return false;
  for (const [containerRe, containedRe] of CONTAINED_BY_SIBLING) {
    if (!containedRe.test(itemEntity)) continue;
    if (siblings.some((s) => s !== item && containerRe.test(String(s?.entity || "")))) {
      return true;
    }
  }
  return false;
}

export async function buildMarkerData(result: GenerationResult): Promise<MarkerData> {
  const [spritesheet, atlas] = await Promise.all([loadSpritesheet(), loadAtlas()]);

  const { poisByPW, worldCenter } = result;
  const items: MarkerItem[] = [];
  const skipCreatures = isSkipCreatures();

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      // "Don't add creatures" toggle: skip enemy/prop spawn containers and
      // their unwrapped contents entirely.
      if (skipCreatures && (poi.type === "enemies" || poi.type === "props")) continue;

      // Add the POI itself as a marker
      if (poi.type === "triangle_boss") {
        // Gate Guardian is already painted into the baked background — add only
        // an invisible click target so the card opens on map click.
        addClickOnlyMarker(items, poi, pw);
      } else {
        addMarkerItem(items, poi, pw, worldCenter, atlas);
      }

      // Unwrap container contents as separate markers (except chest types which just show the chest icon)
      if (CONTAINER_TYPES.has(poi.type) && !CHEST_ONLY_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
        const innerItems = poi.items.filter((i: any) => !i.ignore);
        const count = innerItems.length;
        const isBoss = BOSS_DROP_TYPES.has(poi.type);
        for (let ci = 0; ci < count; ci++) {
          const innerItem = innerItems[ci];
          if (shouldSkipDueToContainer(innerItem, innerItems)) continue;
          if (isBoss) {
            // Boss drops: spread horizontally + push down below the boss sprite.
            // Drops may omit their own x/y (most hardcoded boss drops do), so
            // anchor to the boss POI's position. Without this the offset math
            // yields NaN coords, which makes the marker's bbox match EVERY
            // click query (drop card opens on empty map clicks).
            const baseX = Number.isFinite(innerItem.x) ? innerItem.x : poi.x;
            const baseY = Number.isFinite(innerItem.y) ? innerItem.y : poi.y;
            const pushDown = poi.type === "triangle_boss" ? 70 : 50;
            const offsetPoi =
              count > 1
                ? { ...innerItem, x: baseX + (ci - (count - 1) / 2) * 20, y: baseY + pushDown }
                : { ...innerItem, x: baseX, y: baseY + pushDown };
            addMarkerItem(items, offsetPoi, pw, worldCenter, atlas);
          } else if (poi.type === "starting_loadout") {
            // Mina's loadout: spread horizontally, lifted above the player
            // sprite and nudged right so all three items stay clear of Mina.
            const offsetPoi =
              count > 1
                ? { ...innerItem, x: innerItem.x + (ci - (count - 1) / 2) * 18 + 6, y: innerItem.y - 51 }
                : { ...innerItem, x: innerItem.x + 6, y: innerItem.y - 51 };
            addMarkerItem(items, offsetPoi, pw, worldCenter, atlas);
          } else if (ENEMY_SPAWN_TYPES.has(poi.type)) {
            // Enemy spawns: spread items in a small circle around the spawn point
            // to avoid overlap when multiple creatures share the same position
            const angle = (ci / count) * 2 * Math.PI;
            const radius = count > 1 ? 12 : 0;
            const offsetPoi = {
              ...innerItem,
              isHorde: true, // tag for tooltip display
              biome: innerItem.biome || poi.biome, // propagate biome from parent
              x: innerItem.x + Math.cos(angle) * radius,
              y: innerItem.y + Math.sin(angle) * radius,
            };
            addMarkerItem(items, offsetPoi, pw, worldCenter, atlas);
          } else {
            addMarkerItem(items, innerItem, pw, worldCenter, atlas);
          }
        }
      }
    }
  }

  // Compute bounding box
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const item of items) {
    const left = item.osdX - item.w / 2;
    const top = item.osdY - item.h / 2;
    const right = item.osdX + item.w / 2;
    const bottom = item.osdY + item.h / 2;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }

  const pad = 50;
  if (items.length > 0) {
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
  } else {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  const originX = minX;
  const originY = minY;
  const bboxWidth = maxX - minX;
  const bboxHeight = maxY - minY;

  const index = new Flatbush(items.length || 1);
  for (const item of items) {
    index.add(
      item.osdX - item.w / 2 - originX,
      item.osdY - item.h / 2 - originY,
      item.osdX + item.w / 2 - originX,
      item.osdY + item.h / 2 - originY,
    );
  }
  index.finish();

  console.log(
    `[POISpatialIndex] Built index with ${items.length} markers, bbox: (${Math.round(originX)},${Math.round(originY)}) ${Math.round(bboxWidth)}x${Math.round(bboxHeight)}`,
  );
  return { index, spritesheet, atlas, items, originX, originY, bboxWidth, bboxHeight };
}

/**
 * Native (unscaled) pixel size of a sprite in the atlas, so callers can display
 * it at an integer multiple (×2, ×3) for crisp nearest-neighbour scaling.
 * Returns null if the atlas isn't loaded or the key is missing.
 */
export function getSpriteNativeSize(keyRaw: string | string[]): { w: number; h: number } | null {
  if (!cachedAtlas) return null;
  const key = Array.isArray(keyRaw) ? keyRaw[0] : keyRaw;
  const resolved = applySpoilerFree(key, cachedAtlas);
  const e = cachedAtlas[resolved] || cachedAtlas[key];
  if (!e) return null;
  const frame = FIRST_FRAME_SIZE[resolved] || FIRST_FRAME_SIZE[key];
  return { w: frame ? frame.w : e.w, h: frame ? frame.h : e.h };
}

/**
 * Draw a sprite (or array of sprite layers) from the atlas directly onto a canvas element.
 * Synchronous — no blob URL creation needed.
 * Returns the canvas, or null if all sprite keys are missing.
 */
export function drawSpriteToCanvas(
  keyRaw: string | string[],
  displayW: number,
  displayH: number,
): HTMLCanvasElement | null {
  if (!cachedSpritesheet || !cachedAtlas) return null;
  const keys = Array.isArray(keyRaw) ? keyRaw : [keyRaw];
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let rootScale = 1;
  let rootCenterX = displayW / 2;
  let rootCenterY = displayH / 2;

  for (const key of keys) {
    const resolvedKey = applySpoilerFree(key, cachedAtlas);
    const entry = cachedAtlas[resolvedKey];
    if (!entry) continue;

    if (!canvas || !ctx) {
      canvas = document.createElement("canvas");
      canvas.width = displayW;
      canvas.height = displayH;
      canvas.style.imageRendering = "pixelated";
      ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;

      // Determine root dimensions to anchor the piece origins
      const rootResolved = applySpoilerFree(keys[0], cachedAtlas);
      const rootEntry = cachedAtlas[rootResolved] || entry; // fallback to current if 0 is missing
      const rootFrame = FIRST_FRAME_SIZE[keys[0]];
      const rootW = rootFrame ? rootFrame.w : rootEntry.w;
      const rootH = rootFrame ? rootFrame.h : rootEntry.h;
      rootScale = Math.min(displayW / rootW, displayH / rootH, 1);

      const r_ox = rootEntry.ox ?? rootW / 2;
      const r_oy = rootEntry.oy ?? rootH / 2;
      // We want root's origin to be perfectly centered, adjusted for its size taking up space
      const rootDrawW = rootW * rootScale;
      const rootDrawH = rootH * rootScale;
      rootCenterX = (displayW - rootDrawW) / 2 + r_ox * rootScale;
      rootCenterY = (displayH - rootDrawH) / 2 + r_oy * rootScale;
    }

    const frame = FIRST_FRAME_SIZE[key];
    const srcW = frame ? frame.w : entry.w;
    const srcH = frame ? frame.h : entry.h;
    const l_ox = entry.ox ?? srcW / 2;
    const l_oy = entry.oy ?? srcH / 2;

    const drawW = srcW * rootScale;
    const drawH = srcH * rootScale;
    const drawX = rootCenterX - l_ox * rootScale;
    const drawY = rootCenterY - l_oy * rootScale;

    ctx.drawImage(cachedSpritesheet, entry.x, entry.y, srcW, srcH, drawX, drawY, drawW, drawH);
  }

  return canvas;
}

/**
 * Get the sprite's hotspot offset as pixel values relative to the displayed size.
 * Returns { dx, dy } — CSS translate values to shift the sprite so the hotspot
 * aligns with the entity position. If no offset data, returns center offset.
 */
export function getSpriteOffset(
  keyRaw: string | string[],
  displayW: number,
  displayH: number,
): { dx: number; dy: number } {
  if (!cachedAtlas) return { dx: -displayW / 2, dy: -displayH / 2 };
  const key = Array.isArray(keyRaw) ? keyRaw[0] : keyRaw; // use root body component for offsets
  const resolvedKey = applySpoilerFree(key, cachedAtlas);
  const entry = cachedAtlas[resolvedKey];
  if (!entry) return { dx: -displayW / 2, dy: -displayH / 2 };
  const srcW = entry.w || 1;
  const srcH = entry.h || 1;
  const ox = entry.ox ?? srcW / 2;
  const oy = entry.oy ?? srcH / 2;
  // Scale offsets to display size
  return { dx: -(ox / srcW) * displayW, dy: -(oy / srcH) * displayH };
}

export function getAtlas(): Record<string, AtlasEntry> | null {
  return cachedAtlas;
}

export function getSpritesheet(): HTMLImageElement | null {
  return cachedSpritesheet;
}

export async function loadSpritesheetAndAtlas(): Promise<{
  spritesheet: HTMLImageElement;
  atlas: Record<string, AtlasEntry>;
}> {
  const [spritesheet, atlas] = await Promise.all([loadSpritesheet(), loadAtlas()]);
  return { spritesheet, atlas };
}

export { getSpriteKey, resolveSpellKey, CONTAINER_TYPES, CHEST_ONLY_TYPES };
