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

function getSpriteKey(poi: POI, atlas?: Record<string, AtlasEntry>): string | string[] | null {
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
  if (poi.type === "shop") return "enemy:necromancer_shop";
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
  };
  if (BOSS_SPRITE_KEYS[poi.type]) {
    return BOSS_SPRITE_KEYS[poi.type];
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
  const keyRaw = getSpriteKey(poi, atlas);
  if (!keyRaw) return;
  const rootKey = Array.isArray(keyRaw) ? keyRaw[0] : keyRaw;
  if (!atlas[rootKey]) return;

  const entry = atlas[rootKey];
  const frame = FIRST_FRAME_SIZE[rootKey];
  items.push({
    poi,
    pw,
    spriteKey: keyRaw,
    osdX: poi.x,
    osdY: poi.y,
    w: frame ? frame.w : entry.w,
    h: frame ? frame.h : entry.h,
  });
}

/** Boss container types whose drops should be offset to avoid overlapping the boss sprite. */
const BOSS_DROP_TYPES = new Set(["triangle_boss", "alchemist_boss", "pyramid_boss", "dragon", "boss_wizard", "boss_ghost", "boss_sky", "islandspirit", "boss_centipede", "boss_robot", "boss_meat"]);

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
const CONTAINED_BY_SIBLING: Array<[RegExp, RegExp]> = [
  [/\/buildings\/ghost_crystal/, /\/animals\/ghost\.xml$/],
];

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
          if (shouldSkipDueToContainer(innerItem, innerItems)) continue;
          if (isBoss) {
            // Boss drops: spread horizontally + push down below the boss sprite
            const pushDown = poi.type === "triangle_boss" ? 70 : 50;
            const offsetPoi = count > 1
              ? { ...innerItem, x: innerItem.x + (ci - (count - 1) / 2) * 20, y: innerItem.y + pushDown }
              : { ...innerItem, y: innerItem.y + pushDown };
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
 * Draw a sprite (or array of sprite layers) from the atlas directly onto a canvas element.
 * Synchronous — no blob URL creation needed.
 * Returns the canvas, or null if all sprite keys are missing.
 */
export function drawSpriteToCanvas(keyRaw: string | string[], displayW: number, displayH: number): HTMLCanvasElement | null {
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
      rootCenterX = (displayW - rootDrawW) / 2 + (r_ox * rootScale);
      rootCenterY = (displayH - rootDrawH) / 2 + (r_oy * rootScale);
    }

    const frame = FIRST_FRAME_SIZE[key];
    const srcW = frame ? frame.w : entry.w;
    const srcH = frame ? frame.h : entry.h;
    const l_ox = entry.ox ?? srcW / 2;
    const l_oy = entry.oy ?? srcH / 2;

    const drawW = srcW * rootScale;
    const drawH = srcH * rootScale;
    const drawX = rootCenterX - (l_ox * rootScale);
    const drawY = rootCenterY - (l_oy * rootScale);

    ctx.drawImage(cachedSpritesheet, entry.x, entry.y, srcW, srcH, drawX, drawY, drawW, drawH);
  }

  return canvas;
}

/**
 * Get the sprite's hotspot offset as pixel values relative to the displayed size.
 * Returns { dx, dy } — CSS translate values to shift the sprite so the hotspot
 * aligns with the entity position. If no offset data, returns center offset.
 */
export function getSpriteOffset(keyRaw: string | string[], displayW: number, displayH: number): { dx: number; dy: number } {
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
