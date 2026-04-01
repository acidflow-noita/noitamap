/**
 * poi-spatial-index.ts
 *
 * Builds a Flatbush spatial index over all POIs from a GenerationResult,
 * and loads the static spritesheet + atlas for rendering markers.
 */

import Flatbush from "flatbush";
import type { GenerationResult, POI } from "./telescope-adapter";
import { applySpoilerFree } from "../spoiler-free";
import spells from "../data/spells.json";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarkerItem {
  poi: POI;
  pw: number;
  spriteKey: string;
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
  const resp = await fetch("./assets/atlas.json");
  cachedAtlas = await resp.json();
  return cachedAtlas!;
}

// ─── Coordinate conversion ─────────────────────────────────────────────────

function getCorrectedWorldPos(rawX: number, rawY: number, worldCenter: number): { x: number; y: number } {
  const chunkX = Math.floor(rawX / 512) + worldCenter;
  const chunkY = Math.floor(rawY / 512) + 14;

  const div5x = Math.floor(chunkX / 5);
  const mod5x = ((chunkX % 5) + 5) % 5;
  const correctedX = (div5x * 256 + mod5x * 51) * 10;

  const div5y = Math.floor(chunkY / 5);
  const mod5y = ((chunkY % 5) + 5) % 5;
  let correctedY = (div5y * 256 + mod5y * 51) * 10;
  if (mod5y > 0) correctedY += 10;

  const localX = ((rawX % 512) + 512) % 512;
  const localY = ((rawY % 512) + 512) % 512;

  const chunkW = mod5x === 4 ? 52 : 51;
  const chunkH = mod5y === 4 ? 52 : 51;

  const finalX = correctedX + (localX * chunkW * 10) / 512;
  const finalY = correctedY + (localY * chunkH * 10) / 512;

  return {
    x: finalX - worldCenter * 512,
    y: finalY - 14 * 512,
  };
}

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
  return _spellIdToSpriteKey.get(spellId) ?? `spell:${spellId.toLowerCase()}`;
}

function getSpriteKey(poi: POI, atlas?: Record<string, AtlasEntry>): string | null {
  // Spells inside containers have {type: 'item', item: 'spell', spell: 'SPELL_ID'}
  if (poi.type === "item" && poi.item === "spell" && (poi as any).spell) {
    return resolveSpellKey(String((poi as any).spell));
  }

  if (poi.type === "spell" && (poi as any).item) {
    return resolveSpellKey(String((poi as any).item));
  }

  if (poi.type === "wand" && poi.sprite) {
    const parts = poi.sprite.split("/");
    const filename = parts[parts.length - 1].replace(/\.png$/, "");
    return `wand:${filename}`;
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
    if (item === "full_heal") return "item:heart";
    if (item === "chest") return "item:chest";
    if (item === "chest_present") return "item:chest_present";
    if (item === "spell_refresh") return "item:spell_refresh";
    if (item === "broken_wand") return "item:broken_wand";
    if (item === "jar") return "item:jar";
    if (item === "bomb") return "item:bomb";
    if (item === "bomb_holy") return "item:bomb_holy";
    if (item === "bomb_holy_giga") return "item:bomb_holy_giga";
    if (item === "torch") return "item:torch";
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
    if (item === "perk") return "item:perk";
    if (item === "emerald_tablet") return "item:emerald_tablet";
    if (item === "egg" || item.startsWith("egg_")) return `item:${item}`;
    return `item:${item}`;
  }

  // Containers — show the chest sprite on the map
  if (poi.type === "chest") return "item:chest_random";
  if (poi.type === "pacifist_chest") return "item:chest_random";
  if (poi.type === "great_chest") return "item:chest_random_super";
  if (poi.type === "shop" || poi.type === "holy_mountain_shop") return null;
  if (poi.type === "laboratory") return null;
  if (poi.type === "eye_room") return null;

  // Boss types — no boss sprites in atlas, skip rendering the boss entity.
  // Drops are still shown via container unwrapping below.
  // dragon, fish_giga (leviathan), gate_monster_a (gate boss), islandspirit — hidden/prebaked, skip.
  // triangle_boss, alchemist_boss, pyramid_boss, boss_centipede, friend — skip sprite (none in atlas).
  if (
    poi.type === "triangle_boss" ||
    poi.type === "alchemist_boss" ||
    poi.type === "pyramid_boss" ||
    poi.type === "dragon"
  ) {
    return null;
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

function addMarkerItem(
  items: MarkerItem[],
  poi: POI,
  pw: number,
  worldCenter: number,
  atlas: Record<string, AtlasEntry>,
): void {
  const key = getSpriteKey(poi, atlas);
  if (!key || !atlas[key]) return;
  const entry = atlas[key];
  const frame = FIRST_FRAME_SIZE[key];
  const { x, y } = getCorrectedWorldPos(poi.x, poi.y, worldCenter);
  items.push({
    poi,
    pw,
    spriteKey: key,
    osdX: x,
    osdY: y,
    w: frame ? frame.w : entry.w,
    h: frame ? frame.h : entry.h,
  });
}

/** Boss container types whose drops should be offset to avoid overlapping the boss sprite. */
const BOSS_DROP_TYPES = new Set(["triangle_boss", "alchemist_boss", "pyramid_boss", "dragon"]);

/** Enemy/prop spawn containers: spread inner items to avoid overlap. */
const ENEMY_SPAWN_TYPES = new Set(["enemies", "props"]);

export async function buildMarkerData(result: GenerationResult): Promise<MarkerData> {
  const [spritesheet, atlas] = await Promise.all([loadSpritesheet(), loadAtlas()]);

  const { poisByPW, worldCenter } = result;
  const items: MarkerItem[] = [];

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      // Add the POI itself as a marker
      addMarkerItem(items, poi, pw, worldCenter, atlas);

      // Unwrap container contents as separate markers (except chest types which just show the chest icon)
      if (CONTAINER_TYPES.has(poi.type) && !CHEST_ONLY_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
        const innerItems = poi.items.filter((i: any) => !i.ignore);
        const count = innerItems.length;
        const isBoss = BOSS_DROP_TYPES.has(poi.type);
        for (let ci = 0; ci < count; ci++) {
          const innerItem = innerItems[ci];
          if (isBoss) {
            // Boss drops: spread horizontally + push down below the boss sprite
            const offsetPoi = count > 1
              ? { ...innerItem, x: innerItem.x + (ci - (count - 1) / 2) * 20, y: innerItem.y + 50 }
              : { ...innerItem, y: innerItem.y + 50 };
            addMarkerItem(items, offsetPoi, pw, worldCenter, atlas);
          } else if (ENEMY_SPAWN_TYPES.has(poi.type)) {
            // Enemy spawns: spread items in a small circle around the spawn point
            // to avoid overlap when multiple creatures share the same position
            const angle = (ci / count) * 2 * Math.PI;
            const radius = count > 1 ? 12 : 0;
            const offsetPoi = {
              ...innerItem,
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
 * Draw a sprite from the atlas directly onto a canvas element.
 * Synchronous — no blob URL creation needed.
 * Returns the canvas, or null if the sprite key isn't in the atlas.
 */
export function drawSpriteToCanvas(key: string, displayW: number, displayH: number): HTMLCanvasElement | null {
  if (!cachedSpritesheet || !cachedAtlas) return null;
  const resolvedKey = applySpoilerFree(key, cachedAtlas);
  const entry = cachedAtlas[resolvedKey];
  if (!entry) return null;

  const frame = FIRST_FRAME_SIZE[key];
  const srcW = frame ? frame.w : entry.w;
  const srcH = frame ? frame.h : entry.h;

  const canvas = document.createElement("canvas");
  canvas.width = displayW;
  canvas.height = displayH;
  canvas.style.imageRendering = "pixelated";
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cachedSpritesheet, entry.x, entry.y, srcW, srcH, 0, 0, displayW, displayH);
  return canvas;
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
