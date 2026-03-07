/**
 * poi-spatial-index.ts
 *
 * Builds a Flatbush spatial index over all POIs from a GenerationResult,
 * and loads the static spritesheet + atlas for rendering markers.
 */

import Flatbush from "flatbush";
import type { GenerationResult, POI } from "./telescope-adapter";

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

/**
 * Same logic as getCorrectedWorldPos in telescope-osd-bridge.ts.
 * Maps raw Noita world coordinates to linearized OSD image coordinates.
 */
function getCorrectedWorldPos(
  rawX: number,
  rawY: number,
  worldCenter: number,
): { x: number; y: number } {
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

// ─── Sprite key resolution ──────────────────────────────────────────────────

/**
 * Determine the atlas sprite key for a given POI.
 */
function getSpriteKey(poi: POI): string | null {
  if (poi.type === "spell" && (poi as any).item) {
    // spell IDs are UPPERCASE in spells.json but lowercase in atlas.json
    return `spell:${String((poi as any).item).toLowerCase()}`;
  }

  if (poi.type === "wand" && poi.sprite) {
    // poi.sprite can be a filename like "wand_0001" or a full path
    // like "data/items_gfx/wands/wand_0001.png". The atlas keys use
    // the filename without extension, e.g. "wand:wand_0001".
    const parts = poi.sprite.split("/");
    const filename = parts[parts.length - 1].replace(/\.png$/, "");
    return `wand:${filename}`;
  }

  if (poi.type === "item" && poi.item) {
    const item = poi.item;
    // Map common item names to atlas keys
    if (item === "potion" || item === "potion_normal") return "item:potion";
    if (item === "pouch" || item === "powder_stash_pouch") return "item:pouch";
    if (item === "powder_stash") return "item:powder_stash";
    if (item === "gold" || item === "goldnugget") return "item:goldnugget_01";
    if (item === "heart") return "item:heart";
    if (item === "heart_bigger" || item === "heart_extra") return "item:heart_extrahp";
    if (item === "full_heal") return "item:heart_extrahp_evil";
    if (item === "chest") return "item:chest";
    if (item === "chest_present") return "item:chest_present";
    if (item === "spell_refresh") return "item:spell_refresh";
    if (item === "egg" || item.startsWith("egg_")) return `item:${item}`;
    // Fall through to generic lookup
    const key = `item:${item}`;
    return key;
  }

  // Containers
  if (poi.type === "chest") return "item:chest";
  if (poi.type === "shop" || poi.type === "holy_mountain_shop") return "item:chest";
  if (poi.type === "eye_room") return "item:evil_eye";

  return null;
}

// ─── Build marker data ──────────────────────────────────────────────────────

/**
 * Flatten all POIs from the generation result, unwrapping containers,
 * and build a Flatbush spatial index + parallel items array.
 */
export async function buildMarkerData(
  result: GenerationResult,
): Promise<MarkerData> {
  const [spritesheet, atlas] = await Promise.all([loadSpritesheet(), loadAtlas()]);

  const { poisByPW, worldCenter } = result;
  const items: MarkerItem[] = [];

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      // Unwrap container POIs
      if (
        (poi.type === "holy_mountain_shop" || poi.type === "shop" || poi.type === "eye_room") &&
        poi.items &&
        Array.isArray(poi.items)
      ) {
        for (const innerItem of poi.items) {
          if (innerItem.ignore) continue;
          const key = getSpriteKey(innerItem);
          if (!key || !atlas[key]) continue;
          const entry = atlas[key];
          const { x, y } = getCorrectedWorldPos(innerItem.x, innerItem.y, worldCenter);
          items.push({
            poi: innerItem,
            pw,
            spriteKey: key,
            osdX: x,
            osdY: y,
            w: entry.w,
            h: entry.h,
          });
        }
        continue;
      }

      const key = getSpriteKey(poi);
      if (!key || !atlas[key]) continue;
      const entry = atlas[key];
      const { x, y } = getCorrectedWorldPos(poi.x, poi.y, worldCenter);
      items.push({
        poi,
        pw,
        spriteKey: key,
        osdX: x,
        osdY: y,
        w: entry.w,
        h: entry.h,
      });
    }
  }

  // Compute bounding box of all markers in OSD viewport coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

  // Add padding so edge markers aren't clipped
  const pad = 50;
  if (items.length > 0) {
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
  } else {
    minX = 0; minY = 0; maxX = 1; maxY = 1;
  }

  const originX = minX;
  const originY = minY;
  const bboxWidth = maxX - minX;
  const bboxHeight = maxY - minY;

  // Build Flatbush index using coordinates LOCAL to the bounding box origin.
  // This ensures the tile source's internal coordinate system (0-based) matches
  // the Flatbush index directly.
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

  console.log(`[POISpatialIndex] Built index with ${items.length} markers, bbox: (${Math.round(originX)},${Math.round(originY)}) ${Math.round(bboxWidth)}x${Math.round(bboxHeight)}`);
  return { index, spritesheet, atlas, items, originX, originY, bboxWidth, bboxHeight };
}

/**
 * Get the cached atlas (for use by getPOISpriteFirstFrame in the bridge).
 */
export function getAtlas(): Record<string, AtlasEntry> | null {
  return cachedAtlas;
}

/**
 * Get the cached spritesheet image.
 */
export function getSpritesheet(): HTMLImageElement | null {
  return cachedSpritesheet;
}

/**
 * Eagerly load both spritesheet and atlas (for use before buildMarkerData).
 */
export async function loadSpritesheetAndAtlas(): Promise<{
  spritesheet: HTMLImageElement;
  atlas: Record<string, AtlasEntry>;
}> {
  const [spritesheet, atlas] = await Promise.all([loadSpritesheet(), loadAtlas()]);
  return { spritesheet, atlas };
}

/** Expose getSpriteKey for external use. */
export { getSpriteKey };
