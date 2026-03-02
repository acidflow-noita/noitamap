/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Adds tile canvases as simple image overlays, POI sprites as HTML overlays,
 * and pixel scenes as image overlays.
 *
 * All telescope coordinates use the Noita world pixel system where
 * world center is at chunk (35, 14) for NG0.  OSD in noitamap already
 * uses world-pixel coordinates (the DZI TopLeft shifts take care of
 * aligning tiles).  For dynamic maps we position items directly in
 * world-pixel space.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from './telescope-adapter';
// @ts-ignore
import { VISUAL_TILE_OFFSET_X, VISUAL_TILE_OFFSET_Y, CHUNK_SIZE } from 'noita-telescope/constants.js';
// @ts-ignore
import { getWorldSize, getWorldCenter } from 'noita-telescope/utils.js';

// OSD viewer type — use `any` because the installed OSD types bundle
// does not export Viewer/TiledImage/Point as named exports; they are
// available on the global OpenSeadragon object loaded via CDN script.
type OSDViewer = any;

// Track items we've added so we can clear them on regeneration
let dynamicTiledImages: any[] = [];
let dynamicOverlayElements: HTMLElement[] = [];

// ─── Clear ──────────────────────────────────────────────────────────────────

/**
 * Remove all dynamic map overlays from the viewer.
 */
export function clearDynamicOverlays(viewer: any): void {
  // Remove tiled images (tile canvases, pixel scenes)
  for (const item of dynamicTiledImages) {
    try {
      viewer.world.removeItem(item);
    } catch {
      // item may already be removed
    }
  }
  dynamicTiledImages = [];

  // Remove HTML overlays (POI sprites)
  for (const el of dynamicOverlayElements) {
    try {
      viewer.removeOverlay(el);
      el.remove();
    } catch {
      // overlay may already be removed
    }
  }
  dynamicOverlayElements = [];
}

// ─── Tile rendering ─────────────────────────────────────────────────────────

/**
 * Add generated tile canvases to the OSD viewer as simple images.
 *
 * Telescope's correctedX/correctedY are in world-pixel space relative to
 * the world center at (worldCenter*512, 14*512).  We add the center offset
 * so the tiles are positioned correctly in absolute world-pixel coords.
 */
export function addTileLayers(
  viewer: OSDViewer,
  result: GenerationResult,
): void {
  const { tileLayers, worldCenter, isNGP } = result;

  for (const layer of tileLayers) {
    if (!layer.canvas) continue;

    const dataUrl = layer.canvas.toDataURL('image/png');

    // Position in absolute world-pixel coords
    const x = layer.correctedX + VISUAL_TILE_OFFSET_X;
    const y = layer.correctedY + VISUAL_TILE_OFFSET_Y;

    viewer.addSimpleImage({
      url: dataUrl,
      x,
      y,
      width: layer.w,
    });
  }

  // Track the items we just added
  // OSD adds them to the world, we need to capture them
  // (addSimpleImage fires 'add-item' but doesn't return the item directly)
  // We'll capture them after a microtask
  setTimeout(() => {
    const count = viewer.world.getItemCount();
    // The last N items are the ones we just added
    const newItems: any[] = [];
    for (let i = count - tileLayers.length; i < count; i++) {
      if (i >= 0) newItems.push(viewer.world.getItemAt(i));
    }
    dynamicTiledImages.push(...newItems);
  }, 0);
}

// ─── Pixel scene rendering ──────────────────────────────────────────────────

/**
 * Add pixel scenes for all parallel worlds to the viewer.
 */
export function addPixelScenes(
  viewer: OSDViewer,
  result: GenerationResult,
): void {
  const { pixelScenesByPW, worldCenter, worldSize, isNGP } = result;

  let addedCount = 0;

  for (const [pwKey, scenes] of Object.entries(pixelScenesByPW)) {
    const [pwStr] = pwKey.split(',');
    const pw = parseInt(pwStr);

    for (const scene of scenes) {
      if (!scene || !scene.imgElement) continue;

      const dataUrl = scene.imgElement.toDataURL('image/png');

      // Pixel scene positions: scene.x/y are already in world coordinates
      // but need the world center offset and PW shift
      const x = scene.x + worldCenter * CHUNK_SIZE - pw * worldSize * CHUNK_SIZE;
      const y = scene.y + 14 * CHUNK_SIZE;

      viewer.addSimpleImage({
        url: dataUrl,
        x,
        y,
        width: scene.width,
      });
      addedCount++;
    }
  }

  // Track items
  setTimeout(() => {
    const count = viewer.world.getItemCount();
    const newItems: any[] = [];
    for (let i = count - addedCount; i < count; i++) {
      if (i >= 0) newItems.push(viewer.world.getItemAt(i));
    }
    dynamicTiledImages.push(...newItems);
  }, 0);
}

// ─── POI rendering ──────────────────────────────────────────────────────────

/**
 * Add POI markers as OSD HTML overlays with actual game sprites.
 * Each POI gets an <img> element positioned at its world coordinates.
 */
export function addPOIOverlays(
  viewer: OSDViewer,
  result: GenerationResult,
): void {
  const { poisByPW, worldCenter, worldSize, isNGP } = result;

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(',');
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      const el = createPOIElement(poi);
      if (!el) continue;

      // POI positions: poi.x/y are in world-pixel coords with PW shift baked in
      // We need to un-shift the PW and add the world center offset
      const x = poi.x - pw * worldSize * CHUNK_SIZE + worldCenter * CHUNK_SIZE;
      const y = poi.y + 14 * CHUNK_SIZE;

      viewer.addOverlay({
        element: el,
        location: new (OpenSeadragon as any).Point(x, y),
        placement: (OpenSeadragon as any).Placement.CENTER,
      });

      dynamicOverlayElements.push(el);
    }
  }
}

/**
 * Create an HTML element for a POI.
 * Uses actual game sprites where available, falls back to a colored dot.
 */
function createPOIElement(poi: POI): HTMLElement | null {
  const el = document.createElement('div');
  el.className = 'dynamic-poi';
  el.dataset.poiType = poi.type;
  if (poi.item) el.dataset.poiItem = poi.item;

  // Determine sprite path based on POI type
  const spritePath = getPOISpritePath(poi);

  if (spritePath) {
    const img = document.createElement('img');
    img.src = spritePath;
    img.style.cssText = 'width:32px;height:32px;image-rendering:pixelated;pointer-events:none;';
    img.draggable = false;
    el.appendChild(img);
  } else {
    // Fallback: colored circle
    const color = getPOIColor(poi);
    el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.5);pointer-events:none;`;
  }

  return el;
}

/**
 * Get a sprite image path for a POI, or null if no sprite is available.
 * Sprites are loaded from data.zip via the fetch interceptor.
 */
function getPOISpritePath(poi: POI): string | null {
  // TODO: Build a proper sprite mapping once data.zip sprite paths are confirmed
  // For now, use the fetch interceptor path for known item sprites
  if (poi.type === 'item' && poi.item) {
    if (poi.item.includes('potion') || poi.item === 'pouch') {
      return './data/item_sprites/potion.png';
    }
    if (poi.item.includes('heart')) {
      return './data/item_sprites/heart.png';
    }
  }
  // Wand sprites require specific wand type info — use fallback for now
  return null;
}

/**
 * Get a fallback color for a POI type.
 */
function getPOIColor(poi: POI): string {
  switch (poi.type) {
    case 'wand': return '#00FFFF';
    case 'item':
      if (poi.item?.includes('heart')) return '#FF0000';
      if (poi.item?.includes('potion') || poi.item === 'pouch') return '#0000FF';
      if (poi.item === 'portal') return '#800080';
      return '#FFFF00';
    case 'utility_box': return '#FF00FF';
    case 'chest':
    case 'pacifist_chest': return '#FFA500';
    case 'great_chest': return '#FF5500';
    case 'holy_mountain_shop': return '#00FF00';
    default: return '#FFFFFF';
  }
}

// ─── Full render ────────────────────────────────────────────────────────────

/**
 * Render all generation results onto the OSD viewer.
 * Clears previous dynamic overlays first.
 */
export function renderGenerationResult(
  viewer: OSDViewer,
  result: GenerationResult,
): void {
  clearDynamicOverlays(viewer);
  addTileLayers(viewer, result);
  addPixelScenes(viewer, result);
  addPOIOverlays(viewer, result);
}

/**
 * Get all POIs from a generation result as a flat array with world-pixel coords,
 * suitable for indexing into FlexSearch.
 */
export function getAllPOIsFlat(result: GenerationResult): Array<POI & { pw: number; worldX: number; worldY: number }> {
  const flat: Array<POI & { pw: number; worldX: number; worldY: number }> = [];
  const { poisByPW, worldCenter, worldSize } = result;

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(',');
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      flat.push({
        ...poi,
        pw,
        // World-pixel coordinates (absolute, with PW baked in)
        worldX: poi.x,
        worldY: poi.y,
      });
    }
  }

  return flat;
}
