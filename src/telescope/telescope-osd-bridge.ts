/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Adds biome overlays progressively (per-biome, per-PW) for visual feedback.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./telescope-adapter";
import { getPixelSceneImgElement, recolorPixelSceneForBiome, TILE_OVERLAY_COLORS } from "./telescope-adapter";
import { getDataZip } from "../data-archive";
import { installTelescopeShim, isCanvasTainted } from "./telescope-dom-shim";
import { installFetchInterceptor, installImageSrcInterceptor } from "./telescope-data-bridge";
import { decodePngToRgba, rgbaToPngBlobUrl, rgbaToPngBlob } from "./png-decode";
import { getCachedBiomeRender, cacheBiomeRender, getCachedSceneBitmap, cacheSceneBitmap, getCachedSceneBitmapKeys, getCachedSceneBitmapsBulk, getCachedBiomeRendersForKey } from "./tile-cache";
import i18next from "../i18n";
import { attachAlwaysCastPopover, dismissPopovers } from "../popover-util";
import {
  getActiveDescriptor,
  setActiveDescriptor,
  primaryDescriptor,
  isModSourced,
  isVariantReady,
  onAltReady,
  getPoiVariant,
  requestVariant,
  type UnlockDescriptor,
} from "../unlocks-toggle";
import { getCurrentIsDaily } from "../dynamic-map";
import {
  buildMarkerData,
  getAtlas,
  getSpritesheet,
  getSpriteKey,
  resolveSpellKey,
  loadSpritesheetAndAtlas,
  FIRST_FRAME_SIZE,
  CONTAINER_TYPES,
  CHEST_ONLY_TYPES,
  drawSpriteToCanvas,
  getSpriteNativeSize,
} from "./poi-spatial-index";
import type { MarkerData, MarkerItem } from "./poi-spatial-index";
import { createMarkerTileSource } from "./marker-tile-source";
import { addBakedDZIsToOSD, type BakedDziPlacement } from "./baked-dzi-loader";
import { gameTranslator } from "../game-translations/translator";
import { isSpoilerFree, getSpoilerCategory, getSpoilerLabel, applySpoilerFree } from "../spoiler-free";
import { isLightMode } from "../light-mode";
import { clearTargetPoiId } from "../data_sources/url";
import spells from "../data/spells.json";
import { CREATURE_DATA } from "../data/creature-data";
import { buildExtendedSection } from "../extended-info";

declare const OpenSeadragon: any;

// Spell ID → English display name lookup (lazy-init)
let _spellNameById: Map<string, string> | null = null;
function getSpellName(id: string): string {
  if (!_spellNameById) {
    _spellNameById = new Map();
    for (const s of spells) _spellNameById.set(s.id, s.name);
  }
  return _spellNameById.get(id) ?? id;
}

let CHUNK_SIZE: number;
let BIOME_CONFIG: any;
let GENERATOR_CONFIG: any;
let TILE_FOREGROUND_COLORS: any;
let BIOME_COLOR_LOOKUP: any;
let createTileOverlaysCheap: any;
let getWorldSize: any;
let _telescopeModulesLoaded = false;
let privacyToastShown = false;

// ─── Biome Render Order ─────────────────────────────────────────────────────

/** Ordered list of biome keys for progressive rendering. */
const BIOME_RENDER_ORDER: string[] = [
  // Main biomes
  "coalmine",
  "coalmine_alt",
  "excavationsite",
  "fungicave",
  "snowcave",
  "snowcastle",
  "rainforest",
  "rainforest_open",
  "vault",
  "crypt",
  "liquidcave",
  "pyramid",
  "wandcave",
  "sandcave",
  "the_end",
  "fungiforest",
  "rainforest_dark",
  "wizardcave",
  "robobase",
  "meat",
  "vault_frozen",
  "clouds",
  "the_sky",
  "snowchasm",
  // Tower variants
  "tower_end",
  "tower_crypt",
  "tower_vault",
  "tower_rainforest",
  "tower_fungicave",
  "tower_snowcastle",
  "tower_snowcave",
  "tower_excavationsite",
  "tower_coalmine",
  // Extra generation biomes
  "boss_arena",
  "snowcave_secret_chamber",
  "excavationsite_cube_chamber",
  "snowcastle_cavern",
  "snowcastle_hourglass_chamber",
  "pyramid_top",
  "robot_egg",
  "secret_lab",
  "wizardcave_entrance",
  "dragoncave",
];

/** Biomes already baked into the static OSD background map — skip overlay rendering AND biome backgrounds. */
const SKIP_BIOMES = new Set([
  "temple_altar",
  "dragoncave",
  "snowcastle_hourglass_chamber",
  "snowcastle_cavern",
  "snowcave_secret_chamber",
  "excavationsite_cube_chamber",
  "secret_lab",
  "lavalake",
  "biome_watchtower",
  "biome_potion_mimics",
  "biome_darkness",
  "biome_boss_sky",
  "biome_barren",
  "lake_deep",
]);

// ─── Sprite Cache ───────────────────────────────────────────────────────────

const spriteUrlCache: Map<string, string> = new Map();
const rotatedSpriteUrlCache: Map<string, { url: string; w: number; h: number }> = new Map();

/**
 * Fetch an unrotated sprite from data.zip and return a blob URL.
 */
export async function getWandSprite(spriteName: string): Promise<string | null> {
  if (spriteUrlCache.has(spriteName)) return spriteUrlCache.get(spriteName)!;

  const zip = await getDataZip();
  if (!zip) return null;

  const paths = [
    `data/items_gfx/wands/${spriteName}.png`,
    `data/items_gfx/wands/${spriteName}`,
    // Some starting/special wands live one level up (e.g. data/items_gfx/bomb_wand.png).
    `data/items_gfx/${spriteName}.png`,
    `data/items_gfx/${spriteName}`,
    spriteName.startsWith("data/") ? spriteName : null,
  ];
  const lastSlash = spriteName.lastIndexOf("/");
  if (lastSlash >= 0) {
    const base = spriteName.slice(lastSlash + 1);
    paths.push(`data/items_gfx/wands/${base}.png`);
    paths.push(`data/items_gfx/${base}.png`);
  }
  const filtered = paths.filter(Boolean) as string[];

  for (const path of filtered) {
    const file = zip.file(path);
    if (file) {
      const blob = await file.async("blob");
      const url = URL.createObjectURL(blob);
      spriteUrlCache.set(spriteName, url);
      return url;
    }
  }
  return null;
}

/**
 * Fetch the wand_ghost (Taikasauva) bestiary icon from data.zip. Falls back
 * to the spell:summon_wandghost atlas sprite if the data.zip fetch fails.
 */
export async function getTaikasauvaIcon(): Promise<string | null> {
  const cacheKey = "ui_animal_icons/wand_ghost";
  if (spriteUrlCache.has(cacheKey)) return spriteUrlCache.get(cacheKey)!;
  const zip = await getDataZip();
  if (zip) {
    const file = zip.file("data/ui_gfx/animal_icons/wand_ghost.png");
    if (file) {
      const blob = await file.async("blob");
      const url = URL.createObjectURL(blob);
      spriteUrlCache.set(cacheKey, url);
      return url;
    }
  }
  // Fallback: summon_wandghost spell icon (always in atlas)
  return getPOISpriteFirstFrame({ type: "spell", item: "SUMMON_WANDGHOST" });
}

/**
 * Fetch a sprite from data.zip, rotate it 90deg CCW, and return a blob URL + dimensions.
 */
export async function getRotatedWandSprite(spriteName: string): Promise<{ url: string; w: number; h: number } | null> {
  if (rotatedSpriteUrlCache.has(spriteName)) return rotatedSpriteUrlCache.get(spriteName)!;

  const zip = await getDataZip();
  if (!zip) return null;

  const paths = [
    `data/items_gfx/wands/${spriteName}.png`,
    `data/items_gfx/wands/${spriteName}`,
    // Some starting/special wands live one level up (e.g. data/items_gfx/bomb_wand.png).
    `data/items_gfx/${spriteName}.png`,
    `data/items_gfx/${spriteName}`,
    spriteName.startsWith("data/") ? spriteName : null,
  ];

  // Also try the basename only — starting loadout sprites come through as
  // "custom/handgun" / "custom/bomb_wand" but the actual files are at
  // data/items_gfx/handgun.png and data/items_gfx/bomb_wand.png (no "custom/"
  // prefix in the real archive).
  const lastSlash = spriteName.lastIndexOf("/");
  if (lastSlash >= 0) {
    const base = spriteName.slice(lastSlash + 1);
    paths.push(`data/items_gfx/wands/${base}.png`);
    paths.push(`data/items_gfx/${base}.png`);
  }
  const filtered = paths.filter(Boolean) as string[];

  let file = null;
  for (const path of filtered) {
    file = zip.file(path);
    if (file) break;
  }
  if (!file) return null;

  const buf = await file.async("arraybuffer");
  const srcImg = decodePngToRgba(buf);
  const sw = srcImg.width;
  const sh = srcImg.height;

  // Rotate 90° CCW: output is sh wide, sw tall
  const outW = sh;
  const outH = sw;
  const rotated = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const srcIdx = (y * sw + x) * 4;
      // 90° CCW: new(x, y) = old(sw-1-y, x) ... actually CCW: new pixel at (y, sw-1-x)
      const dstX = y;
      const dstY = sw - 1 - x;
      const dstIdx = (dstY * outW + dstX) * 4;
      rotated[dstIdx] = srcImg.data[srcIdx];
      rotated[dstIdx + 1] = srcImg.data[srcIdx + 1];
      rotated[dstIdx + 2] = srcImg.data[srcIdx + 2];
      rotated[dstIdx + 3] = srcImg.data[srcIdx + 3];
    }
  }

  const url = await rgbaToPngBlobUrl(rotated, outW, outH);
  const result = { url, w: outW, h: outH };
  rotatedSpriteUrlCache.set(spriteName, result);
  return result;
}

async function ensureTelescopeModules(): Promise<void> {
  if (_telescopeModulesLoaded) return;

  // Ensure interceptors are installed before importing telescope modules.
  // image_processing.js has a top-level await that loads PNGs via new Image().src,
  // which needs the Image src interceptor to resolve from data.zip.
  // On cache-hit paths, initTelescope() is skipped, so these may not be installed yet.
  await getDataZip();
  installTelescopeShim({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
  });
  installFetchInterceptor();
  installImageSrcInterceptor();

  const telescope = await import("./telescope-exports");
  const constantsMod = telescope.constantsMod;
  const biomeMod = telescope.biomeGenMod;
  const genMod = telescope.genConfigMod;
  const imageMod = telescope.imageProcessingMod;
  const utilsMod = telescope.utilsMod;
  const settingsMod = telescope.settingsMod;

  // Push our settings into telescope's centralized appSettings object
  settingsMod.updateSettings({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
    enableStaticPixelScenes: 'all',
    skipCosmeticScenes: false,
    excludeTaikasauva: false,
    excludeEdgeCases: false,
    showEnemies: true,
  });

  CHUNK_SIZE = constantsMod.CHUNK_SIZE;
  BIOME_CONFIG = biomeMod.BIOME_CONFIG;
  GENERATOR_CONFIG = genMod.GENERATOR_CONFIG;
  TILE_FOREGROUND_COLORS = imageMod.TILE_FOREGROUND_COLORS;
  BIOME_COLOR_LOOKUP = imageMod.BIOME_COLOR_LOOKUP;
  createTileOverlaysCheap = imageMod.createTileOverlaysCheap;
  getWorldSize = utilsMod.getWorldSize;

  // Apply truthy color hack: the library uses `if (foregroundColor)` which
  // fails for color 0 (black). Change 0→1 (near-black) to make it truthy.
  if (TILE_FOREGROUND_COLORS) {
    for (const [key, val] of Object.entries(TILE_FOREGROUND_COLORS)) {
      if (val === 0) (TILE_FOREGROUND_COLORS as any)[key] = 1;
    }
  }

  _telescopeModulesLoaded = true;
}

type OSDViewer = any;

/**
 * Identify a tiled image as removable seed content, regardless of whether its
 * source.__bakedDzi tag has been set yet. The tag is only applied inside the
 * OSD `success` callback, which fires asynchronously after the first tile
 * loads — between addTiledImage() and success the item is already in the
 * world but un-tagged. A reseed in that window would otherwise treat the
 * in-flight DZI as a base layer (string tilesUrl, no tag) and leave it
 * lingering on top of the new map. Matching the worker hostnames closes the
 * race deterministically.
 */
function isDynamicSeedItem(item: any): boolean {
  const src = item?.source as any;
  if (!src) return false;
  if (src.__simplisticBase) return false;
  if (src.__bakedDzi) return true;
  const url: unknown = src.tilesUrl;
  if (typeof url !== "string") {
    // Custom (non-DZI) tile sources: marker layers, biome bg blob URLs, etc.
    return true;
  }
  // Baked DZIs come from the daily-{left,middle,right}.acidflow.stream and
  // previous-daily-{left,middle,right}.acidflow.stream workers. Anything from
  // those origins is seed-content and must be removable on reseed.
  return /^https:\/\/(?:previous-)?daily-(?:left|middle|right)\.acidflow\.stream\//.test(url);
}

const dynamicTiledImages: Set<any> = new Set();
let dynamicOverlayElements: HTMLElement[] = [];
let dynamicBlobUrls: string[] = [];

/**
 * ID of the currently active generation. Used to abort rendering
 * if a newer generation starts while we're awaiting async operations.
 */
let currentGenerationId = 0;

/**
 * Remove all dynamic map overlays from the viewer.
 */
export function clearDynamicOverlays(viewer: any): void {
  // Invalidate any in-flight async generation so it won't render on top of the new map
  currentGenerationId++;

  markerTiledImage = null;

  // Remove ALL world items that aren't base static DZI tiles.
  // This is more robust than tracking individual items, because addTiledImage
  // success callbacks are async and can slip past Set-based tracking.
  try {
    const world = viewer.world;
    for (let i = world.getItemCount() - 1; i >= 0; i--) {
      const item = world.getItemAt(i);
      // Skip base layers: static DZI tiles (string tilesUrl) and the
      // simplistic flat-PNG background. isDynamicSeedItem also matches baked
      // DZIs by worker hostname, so in-flight items whose success callback
      // hasn't yet set __bakedDzi still get cleaned up.
      if (item && isDynamicSeedItem(item)) {
        world.removeItem(item);
      }
    }
  } catch {}
  dynamicTiledImages.clear();

  for (const el of dynamicOverlayElements) {
    try {
      viewer.removeOverlay(el);
      el.remove();
    } catch {}
  }
  dynamicOverlayElements = [];
  activeOrbTargets = [];

  // Drop any HV ring overlays from the previous generation. The predicate is
  // retained — when the new markerData is set the rings rebuild for that map.
  clearHighValueOverlays(viewer);
  activeMarkerData = null;

  // Delay revocation to give OSD time to release the resources
  const urlsToRevoke = [...dynamicBlobUrls];
  dynamicBlobUrls = [];
  setTimeout(() => {
    for (const url of urlsToRevoke) {
      URL.revokeObjectURL(url);
    }
  }, 2000);
}

/**
 * Check if dynamic overlays are still present in the OSD viewer.
 */
export function hasDynamicOverlays(): boolean {
  return dynamicTiledImages.size > 0;
}

// ─── Biome background layer ─────────────────────────────────────────────────

const BIOME_BG_CACHE_NAME = "noitamap-biome-bg-v1";
const BIOME_BG_CACHE_KEY = "/biome_bg_composite.png";

/** In-memory cache of the composite blob + positioning metadata */
let _bgCompositeBlob: Blob | null = null;
let _bgGeometry: { gx: number; gy: number; w: number; h: number } | null = null;
let _bgInitPromise: Promise<void> | null = null;

/**
 * Initialize the biome background system: render or load the composite,
 * cache in memory, and add to OSD as a preview. Safe to call multiple times.
 */
export function ensurePersistentBiomeBackgrounds(viewer: any): Promise<void> {
  if (!_bgInitPromise) {
    _bgInitPromise = _initBiomeBg(viewer);
  }
  return _bgInitPromise;
}

/**
 * Reset so biome backgrounds will be re-initialized on next call.
 * Called when switching away from the dynamic map (setMap → world.removeAll).
 * Keeps the in-memory blob cache so re-init is instant.
 */
export function resetPersistentBiomeBackgrounds(): void {
  _bgInitPromise = null;
}

/**
 * Add biome background layers to OSD from the in-memory cached blob.
 * This is FAST (no rendering, no network) — just creates blob URLs
 * and calls addTiledImage. Used after clearDynamicOverlays to immediately
 * restore the biome background layer.
 *
 * Returns immediately if the blob hasn't been loaded yet (preview not ready).
 */
export function addBiomeBgToOSD(viewer: any): void {
  if (!_bgCompositeBlob || !_bgGeometry) return;
  const { gx, gy, w } = _bgGeometry;
  const pwOffsetPixels = 70 * 512;
  const pws = isLightMode() ? [0] : [-1, 0, 1];
  for (const pw of pws) {
    const url = URL.createObjectURL(_bgCompositeBlob);
    viewer.addTiledImage({
      tileSource: { type: "image", url, buildPyramid: false },
      x: gx + pw * pwOffsetPixels,
      y: gy,
      width: w,
    });
  }
}

async function _initBiomeBg(viewer: any): Promise<void> {
  // Compute geometry (only once)
  if (!_bgGeometry) {
    const boundaryData = (await import("../data/biome_boundries_py.json")).default;
    if (!boundaryData?.biomes) return;

    const biomesWithBg = boundaryData.biomes.filter(
      (b: any) => b.filename && BIOME_BACKGROUND_MAP[b.filename] && !SKIP_BIOMES.has(b.filename),
    );
    if (biomesWithBg.length === 0) return;

    const CHUNK_SIZE = 512;
    const BIOME_IMAGE_TOP_Y = -14 * CHUNK_SIZE;
    const MAP_TOP_LEFT_X = -17920;

    let globalMinGX = Infinity, globalMinGY = Infinity, globalMaxGX = -Infinity, globalMaxGY = -Infinity;
    for (const biome of biomesWithBg) {
      const rawParts = biome.svg_map_path.split(" ");
      let isX = true;
      for (const part of rawParts) {
        if (part === "M" || part === "L" || part === "Z") { isX = true; continue; }
        const v = Number(part);
        if (isX) {
          const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
          globalMinGX = Math.min(globalMinGX, gx); globalMaxGX = Math.max(globalMaxGX, gx);
          isX = false;
        } else {
          const gy = v * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
          globalMinGY = Math.min(globalMinGY, gy); globalMaxGY = Math.max(globalMaxGY, gy);
          isX = true;
        }
      }
    }
    if (!isFinite(globalMinGX)) return;

    const regionW = globalMaxGX - globalMinGX;
    const regionH = globalMaxGY - globalMinGY;
    if (regionW <= 0 || regionH <= 0) return;

    _bgGeometry = { gx: globalMinGX, gy: globalMinGY, w: regionW, h: regionH };
  }

  // Load or render the composite blob (only once)
  if (!_bgCompositeBlob) {
    // Try Cache API first
    try {
      const cache = await caches.open(BIOME_BG_CACHE_NAME);
      const cached = await cache.match(BIOME_BG_CACHE_KEY);
      if (cached) {
        _bgCompositeBlob = await cached.blob();
        console.log(`[OSD Bridge] Biome bg composite loaded from cache (${_bgCompositeBlob.size} bytes)`);
      }
    } catch (e) {
      console.warn("[OSD Bridge] Cache API read failed:", e);
    }

    // Render if not cached
    if (!_bgCompositeBlob) {
      const boundaryData = (await import("../data/biome_boundries_py.json")).default;
      const biomesWithBg = boundaryData.biomes.filter(
        (b: any) => b.filename && BIOME_BACKGROUND_MAP[b.filename] && !SKIP_BIOMES.has(b.filename),
      );
      console.log("[OSD Bridge] Rendering biome bg composite...");
      _bgCompositeBlob = await _renderBiomeComposite(
        biomesWithBg, _bgGeometry.gx, _bgGeometry.gy, _bgGeometry.w, _bgGeometry.h,
      );
      if (!_bgCompositeBlob) return;

      // Cache for next page load
      try {
        const cache = await caches.open(BIOME_BG_CACHE_NAME);
        await cache.put(BIOME_BG_CACHE_KEY, new Response(_bgCompositeBlob, {
          headers: { "Content-Type": "image/png" },
        }));
        console.log(`[OSD Bridge] Biome bg composite cached (${_bgCompositeBlob.size} bytes)`);
      } catch (e) {
        console.warn("[OSD Bridge] Cache API write failed:", e);
      }
    }
  }

  // Add initial preview to OSD
  addBiomeBgToOSD(viewer);
  console.log("[OSD Bridge] Biome bg preview added to OSD (3 PWs)");
}

/** Render the biome background composite on an OffscreenCanvas. */
async function _renderBiomeComposite(
  biomesWithBg: any[],
  globalMinGX: number, globalMinGY: number,
  regionW: number, regionH: number,
): Promise<Blob | null> {
  const CHUNK_SIZE = 512;
  const BIOME_IMAGE_TOP_Y = -14 * CHUNK_SIZE;
  const MAP_TOP_LEFT_X = -17920;

  // Load textures from static URLs
  const neededPaths = new Set<string>();
  for (const b of biomesWithBg) {
    neededPaths.add(BIOME_BACKGROUND_MAP[b.filename]);
  }

  const bgCache = new Map<string, ImageBitmap>();
  await Promise.all([...neededPaths].map(async (zipPath) => {
    try {
      const filename = zipPath.split("/").pop()!;
      const resp = await fetch(`./biome_bg/${filename}`);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      bgCache.set(zipPath, bmp);
    } catch {}
  }));

  const scale = 0.1;
  const cw = Math.ceil(regionW * scale);
  const ch = Math.ceil(regionH * scale);
  if (cw <= 0 || ch <= 0) return null;

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (const biome of biomesWithBg) {
    const bgPath = BIOME_BACKGROUND_MAP[biome.filename];
    const bgBitmap = bgCache.get(bgPath);
    if (!bgBitmap) continue;

    const rawParts = biome.svg_map_path.split(" ");
    let minGX = Infinity, minGY = Infinity, maxGX = -Infinity, maxGY = -Infinity;
    let isX = true;
    for (const part of rawParts) {
      if (part === "M" || part === "L" || part === "Z") { isX = true; continue; }
      const v = Number(part);
      if (isX) {
        const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
        minGX = Math.min(minGX, gx); maxGX = Math.max(maxGX, gx); isX = false;
      } else {
        const gy = v * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
        minGY = Math.min(minGY, gy); maxGY = Math.max(maxGY, gy); isX = true;
      }
    }
    if (!isFinite(minGX)) continue;

    ctx.save();
    ctx.beginPath();
    let isXp = true;
    for (let j = 0; j < rawParts.length; j++) {
      const part = rawParts[j];
      if (part === "M" || part === "L" || part === "Z") {
        if (part === "Z") ctx.closePath();
        isXp = true; continue;
      }
      const v = Number(part);
      if (isXp) {
        const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
        const nextPart = rawParts[j + 1];
        if (nextPart !== undefined) {
          const gy = Number(nextPart) * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
          const cx = (gx - globalMinGX) * scale;
          const cy = (gy - globalMinGY) * scale;
          const prevCmd = rawParts[j - 1];
          if (prevCmd === "M") ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        }
        isXp = false;
      } else { isXp = true; }
    }
    ctx.clip();

    const tw = Math.max(1, Math.round(bgBitmap.width * scale));
    const th = Math.max(1, Math.round(bgBitmap.height * scale));
    const tileMinX = Math.floor(((minGX - globalMinGX) * scale) / tw) * tw;
    const tileMinY = Math.floor(((minGY - globalMinGY) * scale) / th) * th;
    const tileMaxX = Math.ceil((maxGX - globalMinGX) * scale);
    const tileMaxY = Math.ceil((maxGY - globalMinGY) * scale);
    for (let ty = tileMinY; ty < tileMaxY; ty += th) {
      for (let tx = tileMinX; tx < tileMaxX; tx += tw) {
        ctx.drawImage(bgBitmap, 0, 0, bgBitmap.width, bgBitmap.height, tx, ty, tw, th);
      }
    }
    ctx.restore();
  }

  return canvas.convertToBlob({ type: "image/png" });
}


/**
 * Convert an OffscreenCanvas to a blob URL.
 */
async function offscreenCanvasToBlobUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await offscreenCanvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  dynamicBlobUrls.push(url);
  return url;
}

/**
 * Convert an OffscreenCanvas to a PNG Blob (used for caching to IndexedDB).
 * Mirrors offscreenCanvasToBlobUrl's fingerprint-protection-friendly path.
 */
async function offscreenCanvasToBlob(canvas: OffscreenCanvas): Promise<Blob> {
  const rawData = (canvas as any).__noitamap_rawImageData as ImageData | undefined;
  if (rawData) {
    return await rgbaToPngBlob(rawData.data, rawData.width, rawData.height);
  }
  try {
    const ctx = canvas.getContext("2d");
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return await rgbaToPngBlob(imageData.data, imageData.width, imageData.height);
    }
  } catch {}
  return await canvas.convertToBlob({ type: "image/png" });
}

/**
 * Convert an HTMLCanvasElement to a blob URL.
 */
async function canvasToBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  const rawData = (canvas as any).__noitamap_rawImageData as ImageData | undefined;
  if (rawData) {
    const url = await rgbaToPngBlobUrl(rawData.data, rawData.width, rawData.height);
    dynamicBlobUrls.push(url);
    return url;
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });

  if (!blob) throw new Error("Failed to create blob from canvas");

  const url = URL.createObjectURL(blob);
  dynamicBlobUrls.push(url);
  return url;
}



// ─── Biome Background Tiling ────────────────────────────────────────────────

/**
 * Authoritative biome → tileable background PNG mapping,
 * extracted from Noita's biome XML files in data.zip.
 */
const BIOME_BACKGROUND_MAP: Record<string, string> = {
  coalmine: "data/weather_gfx/background_coalmine.png",
  coalmine_alt: "data/weather_gfx/background_coalmine.png",
  excavationsite: "data/weather_gfx/background_excavationsite.png",
  excavationsite_cube_chamber: "data/weather_gfx/background_cave_04_alt3.png",
  snowcave: "data/weather_gfx/background_snowcave.png",
  snowcave_secret_chamber: "data/weather_gfx/background_snowcave.png",
  snowcastle: "data/weather_gfx/background_snowcastle.png",
  snowcastle_cavern: "data/weather_gfx/background_cave_02.png",
  snowcastle_hourglass_chamber: "data/weather_gfx/background_cave_04_alt3.png",
  fungicave: "data/weather_gfx/background_fungicave_01.png",
  fungiforest: "data/weather_gfx/background_fungiforest_01.png",
  rainforest: "data/weather_gfx/background_rainforest.png",
  rainforest_open: "data/weather_gfx/background_rainforest.png",
  rainforest_dark: "data/weather_gfx/background_rainforest_dark.png",
  vault: "data/weather_gfx/background_vault.png",
  vault_frozen: "data/weather_gfx/background_vault_frozen.png",
  crypt: "data/weather_gfx/background_crypt.png",
  wandcave: "data/weather_gfx/background_wandcave.png",
  wizardcave: "data/weather_gfx/background_wizardcave.png",
  robobase: "data/weather_gfx/background_robobase.png",
  the_end: "data/weather_gfx/background_the_end.png",
  meat: "data/weather_gfx/background_the_end.png",
  pyramid: "data/weather_gfx/background_pyramid.png",
  liquidcave: "data/weather_gfx/background_cave_04_alt.png",
  sandcave: "data/weather_gfx/background_cave_09.png",
  dragoncave: "data/weather_gfx/background_cave_02.png",
  lavalake: "data/weather_gfx/background_cave_04_alt.png",
  temple_altar: "data/weather_gfx/background_cave_02.png",
  secret_lab: "data/weather_gfx/background_snowcave.png",
  winter_caves: "data/weather_gfx/background_snowcave.png",
  // Tower floors (top to bottom = main biomes in reverse)
  solid_wall_tower_9: "data/weather_gfx/background_the_end.png",
  solid_wall_tower_8: "data/weather_gfx/background_crypt.png",
  solid_wall_tower_7: "data/weather_gfx/background_vault.png",
  solid_wall_tower_6: "data/weather_gfx/background_rainforest.png",
  solid_wall_tower_5: "data/weather_gfx/background_fungicave_01.png",
  solid_wall_tower_4: "data/weather_gfx/background_snowcastle.png",
  solid_wall_tower_3: "data/weather_gfx/background_snowcave.png",
  solid_wall_tower_2: "data/weather_gfx/background_excavationsite.png",
  solid_wall_tower_1: "data/weather_gfx/background_coalmine.png",
  solid_wall_tower_10: "data/weather_gfx/background_crypt.png",
};

/** Cache of loaded background ImageBitmaps, keyed by zip path */
const _bgBitmapCache = new Map<string, ImageBitmap>();

/** Load a tileable background image from data.zip, caching the result. */
async function loadBiomeBackground(zipPath: string): Promise<ImageBitmap | null> {
  const cached = _bgBitmapCache.get(zipPath);
  if (cached) return cached;
  const { readImage } = await import("../data-archive");
  const bmp = await readImage(zipPath).catch(() => null);
  if (bmp) _bgBitmapCache.set(zipPath, bmp);
  return bmp;
}

/**
 * Parse an SVG path string (M x y L x y ... Z) into a Path2D.
 * Coordinates are game-world coordinates (pixels).
 */
function svgPathToPath2D(svgPath: string): Path2D {
  const p = new Path2D();
  const parts = svgPath.split(" ");
  let i = 0;
  while (i < parts.length) {
    const cmd = parts[i];
    if (cmd === "M" || cmd === "L") {
      const x = Number(parts[i + 1]);
      const y = Number(parts[i + 2]);
      if (cmd === "M") p.moveTo(x, y);
      else p.lineTo(x, y);
      i += 3;
    } else if (cmd === "Z") {
      p.closePath();
      i++;
    } else {
      i++;
    }
  }
  return p;
}

/**
 * Add pre-baked biome background layers using biome boundary shapes.
 * Each biome's exact shape (from biome_boundries_py.json) is used as a clip
 * mask. The bg texture is tiled at native resolution within the clip, then
 * the canvas is added as a static OSD layer below biome overlays.
 */
async function addBiomeBackgrounds(viewer: OSDViewer, generationId: number): Promise<void> {
  const boundaryData = (await import("../data/biome_boundries_py.json")).default;
  if (!boundaryData?.biomes) return;

  // Determine which biomes need backgrounds
  const biomesWithBg = boundaryData.biomes.filter(
    (b: any) => b.filename && BIOME_BACKGROUND_MAP[b.filename] && !SKIP_BIOMES.has(b.filename),
  );
  if (biomesWithBg.length === 0) return;

  // Pre-load all needed background textures
  const neededPaths = new Set<string>();
  for (const b of biomesWithBg) {
    neededPaths.add(BIOME_BACKGROUND_MAP[b.filename]);
  }
  await Promise.all([...neededPaths].map((p) => loadBiomeBackground(p)));
  console.log(`[OSD Bridge] Pre-loaded ${neededPaths.size} biome background textures`);

  const CHUNK_SIZE = 512;
  const BIOME_IMAGE_TOP_Y = -14 * CHUNK_SIZE; // -7168

  // Build the single bg canvas once (PW 0), then replicate for each PW via offset
  const MAP_TOP_LEFT_X = -17920; // PW 0 origin

  // Compute global bounding box across ALL biomes
  let globalMinGX = Infinity, globalMinGY = Infinity, globalMaxGX = -Infinity, globalMaxGY = -Infinity;
  for (const biome of biomesWithBg) {
    const rawParts = biome.svg_map_path.split(" ");
    let isX = true;
    for (const part of rawParts) {
      if (part === "M" || part === "L" || part === "Z") { isX = true; continue; }
      const v = Number(part);
      if (isX) {
        const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
        globalMinGX = Math.min(globalMinGX, gx); globalMaxGX = Math.max(globalMaxGX, gx);
        isX = false;
      } else {
        const gy = v * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
        globalMinGY = Math.min(globalMinGY, gy); globalMaxGY = Math.max(globalMaxGY, gy);
        isX = true;
      }
    }
  }
  if (!isFinite(globalMinGX)) return;

  const regionW = globalMaxGX - globalMinGX;
  const regionH = globalMaxGY - globalMinGY;
  if (regionW <= 0 || regionH <= 0) return;

  const scale = 0.1;
  const cw = Math.ceil(regionW * scale);
  const ch = Math.ceil(regionH * scale);
  if (cw <= 0 || ch <= 0) return;

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (const biome of biomesWithBg) {
    if (currentGenerationId !== generationId) return;
    const bgPath = BIOME_BACKGROUND_MAP[biome.filename];
    const bgBitmap = _bgBitmapCache.get(bgPath);
    if (!bgBitmap) continue;

    const rawParts = biome.svg_map_path.split(" ");
    let minGX = Infinity, minGY = Infinity, maxGX = -Infinity, maxGY = -Infinity;
    let isX = true;
    for (const part of rawParts) {
      if (part === "M" || part === "L" || part === "Z") { isX = true; continue; }
      const v = Number(part);
      if (isX) {
        const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
        minGX = Math.min(minGX, gx); maxGX = Math.max(maxGX, gx); isX = false;
      } else {
        const gy = v * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
        minGY = Math.min(minGY, gy); maxGY = Math.max(maxGY, gy); isX = true;
      }
    }
    if (!isFinite(minGX)) continue;

    ctx.save();
    ctx.beginPath();
    let isXp = true;
    for (let j = 0; j < rawParts.length; j++) {
      const part = rawParts[j];
      if (part === "M" || part === "L" || part === "Z") {
        if (part === "Z") ctx.closePath();
        isXp = true; continue;
      }
      const v = Number(part);
      if (isXp) {
        const gx = v * CHUNK_SIZE + MAP_TOP_LEFT_X;
        const nextPart = rawParts[j + 1];
        if (nextPart !== undefined) {
          const gy = Number(nextPart) * CHUNK_SIZE + BIOME_IMAGE_TOP_Y;
          const cx = (gx - globalMinGX) * scale;
          const cy = (gy - globalMinGY) * scale;
          const prevCmd = rawParts[j - 1];
          if (prevCmd === "M") ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        }
        isXp = false;
      } else { isXp = true; }
    }
    ctx.clip();

    const tw = Math.max(1, Math.round(bgBitmap.width * scale));
    const th = Math.max(1, Math.round(bgBitmap.height * scale));
    const tileMinX = Math.floor(((minGX - globalMinGX) * scale) / tw) * tw;
    const tileMinY = Math.floor(((minGY - globalMinGY) * scale) / th) * th;
    const tileMaxX = Math.ceil((maxGX - globalMinGX) * scale);
    const tileMaxY = Math.ceil((maxGY - globalMinGY) * scale);
    for (let ty = tileMinY; ty < tileMaxY; ty += th) {
      for (let tx = tileMinX; tx < tileMaxX; tx += tw) {
        ctx.drawImage(bgBitmap, 0, 0, bgBitmap.width, bgBitmap.height, tx, ty, tw, th);
      }
    }
    ctx.restore();
  }

  // Create blob URL once, reuse for all PWs
  const url = await offscreenCanvasToBlobUrl(canvas);
  if (currentGenerationId !== generationId) return;

  // Add the bg canvas for PW 0, -1, and +1 (skip side PWs in light mode)
  const pwOffsetPixels = 70 * 512; // TODO: use isNGP for 72
  const bgPws = isLightMode() ? [0] : [-1, 0, 1];
  for (const pw of bgPws) {
    const pwX = globalMinGX + pw * pwOffsetPixels;
    viewer.addTiledImage({
      tileSource: { type: "image", url, buildPyramid: false },
      x: pwX,
      y: globalMinGY,
      width: regionW,
      success: (event: any) => {
        if (currentGenerationId !== generationId) {
          try { viewer.world.removeItem(event.item); } catch {}
          return;
        }
        dynamicTiledImages.add(event.item);
      },
    });
  }

  console.log(`[OSD Bridge] Gen ${generationId}: Added biome backgrounds for 3 PWs`);
}

// ─── Progressive Biome Rendering ────────────────────────────────────────────

/**
 * Progressively add biome tile overlays to OSD, one biome at a time.
 * Center world (PW 0) renders first, then east (PW 1), then west (PW -1).
 *
 * For each PW, we call createTileOverlaysCheap once to compute all overlays,
 * then iterate through biomes in render order — converting each small overlay
 * canvas to a blob URL and adding it to OSD individually. Each overlay canvas
 * is small (100-500px), so PNG encode per biome is near-instant.
 */
async function addBiomeLayersProgressively(
  viewer: OSDViewer,
  result: GenerationResult,
  generationId: number,
  onFirstPwReady?: () => void,
  cacheKey?: string,
): Promise<void> {
  // Fire a 0% event before the blocking ensureTelescopeModules() call
  // so the loading bar becomes visible/active immediately.
  window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: 0 } }));
  await ensureTelescopeModules();

  const { tileLayers, biomeData, isNGP, worldCenter, parallelWorlds } = result;
  const w = isNGP ? 72 : 70;
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];

  // Sort PWs: center (0) first, then positive (east), then negative (west)
  const pwOrder = [...pws].sort((a, b) => {
    if (a === 0) return -1;
    if (b === 0) return 1;
    return b - a;
  });

  // Build biomeName → layer indices lookup (biomes can have multiple parts)
  const layerIndicesByBiome = new Map<string, number[]>();
  for (let i = 0; i < tileLayers.length; i++) {
    const layer = tileLayers[i];
    if (layer.biomeName) {
      const arr = layerIndicesByBiome.get(layer.biomeName);
      if (arr) arr.push(i);
      else layerIndicesByBiome.set(layer.biomeName, [i]);
    }
  }

  // Build ordered render list (skip prebaked biomes, include fallbacks)
  const orderedBiomes = BIOME_RENDER_ORDER.filter((b) => !SKIP_BIOMES.has(b));
  const orderedSet = new Set<string>(orderedBiomes);
  const unorderedBiomes: string[] = [];
  for (const [biomeName] of layerIndicesByBiome) {
    if (!orderedSet.has(biomeName) && !SKIP_BIOMES.has(biomeName)) {
      unorderedBiomes.push(biomeName);
    }
  }
  const allBiomesToRender = [...orderedBiomes, ...unorderedBiomes];
  console.log(`[OSD Bridge] biome layer names in tileLayers:`, Array.from(layerIndicesByBiome.keys()));
  console.log(`[OSD Bridge] unordered biomes to render:`, unorderedBiomes);

  const anchorY = -(14 * 512);

  // Count total steps for progress: each PW × number of active vertical planes
  // Order: main world first (0), then heaven (-1), then hell (1)
  const pvtList = [0, -1, 1].filter((pvt) => {
    if (pvt < 0 && !biomeData.heavenPixels) return false;
    if (pvt > 0 && !biomeData.hellPixels) return false;
    return true;
  });
  const totalSteps = pwOrder.length * pvtList.length;
  let stepsDone = 0;

  // Bulk-fetch all cached biome renders for this seed in one IDB transaction.
  // Way faster than N separate IDB reads (each transaction has high overhead in
  // Brave/FF — ~5s extra on F5 with 9 PWs).
  const bulkBiomeCache = cacheKey ? await getCachedBiomeRendersForKey(cacheKey) : new Map();

  for (let pwIdx = 0; pwIdx < pwOrder.length; pwIdx++) {
    const pw = pwOrder[pwIdx];
    if (currentGenerationId !== generationId) return;

    for (const pvt of pvtList) {
      // Report progress before CPU-heavy work
      const progress = Math.round((stepsDone / totalSteps) * 100);
      window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: progress } }));

      // Yield briefly so the browser can paint the progress update before we block the main thread.
      await new Promise((r) => setTimeout(r, 0));
      if (currentGenerationId !== generationId) return;

      const isFirstPw = pw === 0 && pvt === 0;

      // ── Cache fast path: blob already rendered for this (seed, pw, pvt) ──
      if (cacheKey) {
        const cached = bulkBiomeCache.get(`${pw},${pvt}`);
        if (cached) {
          const url = URL.createObjectURL(cached.blob);
          dynamicBlobUrls.push(url);
          viewer.addTiledImage({
            tileSource: { type: "image", url, buildPyramid: false },
            x: cached.minX,
            y: cached.minY,
            width: cached.osdWidth,
            success: (event: any) => {
              if (currentGenerationId !== generationId) {
                try { viewer.world.removeItem(event.item); } catch {}
                return;
              }
              dynamicTiledImages.add(event.item);
            },
          });
          if (isFirstPw && onFirstPwReady) {
            try { onFirstPwReady(); } catch (e) { console.warn("[OSD Bridge] onFirstPwReady threw:", e); }
            await new Promise((r) => setTimeout(r, 0));
            await new Promise((r) => requestAnimationFrame(() => r(null)));
          }
          stepsDone++;
          continue;
        }
      }

      // Compute all overlays for this PW at once (CPU-bound, ~1-2s)
      const overlays: (OffscreenCanvas | null)[] = createTileOverlaysCheap(
        biomeData,
        tileLayers,
        pw,
        pvt,
        isNGP,
      );

      if (currentGenerationId !== generationId) return;

      // ── Composite all biome overlays into one canvas per PW ──────────────
      // Instead of adding 50+ individual TiledImages (which overwhelms the
      // canvas drawer in Firefox), we merge them into a single image.

      // First pass: determine bounding box across all non-empty overlays
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const validOverlays: { overlay: OffscreenCanvas; x: number; y: number; osdWidth: number }[] = [];

      for (const biomeName of allBiomesToRender) {
        const layerIdxArr = layerIndicesByBiome.get(biomeName);
        if (!layerIdxArr) continue;

        for (const layerIdx of layerIdxArr) {
          const overlay = overlays[layerIdx];
          if (!overlay || overlay.width === 0 || overlay.height === 0) continue;

          const layer = tileLayers[layerIdx];
          const x = -(worldCenter * 512) + pw * pwOffsetPixels + layer.correctedX;
          const y = anchorY + layer.correctedY + pvt * 24576;
          const osdWidth = overlay.width * 10;
          const osdHeight = overlay.height * 10;

          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + osdWidth);
          maxY = Math.max(maxY, y + osdHeight);

          validOverlays.push({ overlay, x, y, osdWidth });
        }
      }

      if (validOverlays.length === 0) { stepsDone++; continue; }

      // Create a composited canvas at the same pixel density (1 pixel = 10 OSD units)
      const compositeW = Math.ceil((maxX - minX) / 10);
      const compositeH = Math.ceil((maxY - minY) / 10);
      const compositeCanvas = new OffscreenCanvas(compositeW, compositeH);
      const compositeCtx = compositeCanvas.getContext("2d")!;

      // Show privacy browser warning toast once per session if canvas tainting detected
      if (isCanvasTainted() && !privacyToastShown) {
        privacyToastShown = true;
        const toastEl = document.getElementById("privacyBrowserToast");
        if (toastEl) {
          // @ts-ignore — Bootstrap is loaded globally
          new bootstrap.Toast(toastEl).show();
        }
      }

      // ── GPU-accelerated compositing (all browsers) ──
      for (const { overlay, x, y } of validOverlays) {
        const px = Math.round((x - minX) / 10);
        const py = Math.round((y - minY) / 10);
        compositeCtx.drawImage(overlay, px, py);
      }
      const blob = await offscreenCanvasToBlob(compositeCanvas);
      const url = URL.createObjectURL(blob);
      dynamicBlobUrls.push(url);
      if (currentGenerationId !== generationId) return;

      const osdWidth = compositeW * 10;
      // Persist the rendered blob so future loads of this seed skip the
      // ~100-200ms tile-overlay computation per PW.
      if (cacheKey) {
        cacheBiomeRender(cacheKey, pw, pvt, blob, { minX, minY, osdWidth }).catch((e) =>
          console.warn("[OSD Bridge] cacheBiomeRender failed:", e),
        );
      }
      viewer.addTiledImage({
        tileSource: { type: "image", url, buildPyramid: false },
        x: minX,
        y: minY,
        width: osdWidth,
        success: (event: any) => {
          if (currentGenerationId !== generationId) {
            try { viewer.world.removeItem(event.item); } catch {}
            return;
          }
          dynamicTiledImages.add(event.item);
        },
      });

      if (isFirstPw && onFirstPwReady) {
        // Fire after queueing PW 0,0 (don't wait for OSD's success callback —
        // it's blocked by the loop's subsequent CPU-heavy iterations).
        // Yield twice so the browser can paint the indicator hiding before
        // the next PW iteration blocks the main thread for ~100ms.
        try { onFirstPwReady(); } catch (e) { console.warn("[OSD Bridge] onFirstPwReady threw:", e); }
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }

      stepsDone++;
    }
  }

  // Report 100% completion
  window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: 100 } }));
}

// ─── Headless biome-region export (build-daily-seed-images.cjs) ─────────────

export interface BiomeRegionImage {
  pw: number;
  pvt: number;
  /** OSD top-left corner (seed-anchored world coords) — the x/y the live render
   *  passes to viewer.addTiledImage. Use as-is when re-loading the pyramid. */
  minX: number;
  minY: number;
  /** OSD width of the placed image (= compositeW * scale). */
  osdWidth: number;
  /** Nearest-neighbour factor OSD applies on display. The 10x upscale + bg
   *  composite happens downstream in build-daily-seed-images.cjs. */
  scale: number;
  compositeW: number;
  compositeH: number;
  /** PNG bytes (base64) of the native overlay composite. */
  small: string;
  /** PNG bytes (base64) of the per-pixel biome-bg index mask, at the same
   *  scale as `small`. RGB encodes a biome index (look up in biomeIndex);
   *  alpha=255 means "use that biome's bg PNG", alpha=0 means "outside biome —
   *  transparent, let static bg show through". Only present for pvt=0 (main
   *  world); heaven/hell regions skip the mask and emit transparent gaps. */
  mask?: string;
}

export interface BiomeRegionExportResult {
  /** Per-region output. */
  regions: BiomeRegionImage[];
  /** Biome-index lookup: index -> biome bg PNG filename (basename of
   *  noitamap/public/biome_bg/<filename>). Indices are RGB-encoded in the
   *  per-region mask PNGs. Stable across one bake's regions. */
  biomeIndex: Record<number, string>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
  }
  return btoa(bin);
}

// ─── Decoration bake export (pixel scenes + POI marker sprites) ─────────────
//
// The bake page calls prepareDecorationExport() once (builds the full draw
// list: every scene composite + every marker sprite at world coords), then
// exportDecorationCell() per non-empty 2048px grid cell. The node compositor
// alpha-blends the cells onto the upscaled region fulls before stitching, so
// the deployed pyramids carry scenes + creatures in their pixels and the live
// map skips both visual layers entirely (clicks keep working off the spatial
// index; see renderGenerationResult's decorBaked path).

interface DecorDraw {
  img: CanvasImageSource;
  // Optional spritesheet source rect (markers); scenes draw the full bitmap.
  sx?: number; sy?: number; sw?: number; sh?: number;
  x: number; y: number; w: number; h: number;
  // Taikasauva ("alive") wands draw rotated 90deg CCW (tip-up -> tip-left).
  rot?: boolean;
}
const DECOR_CELL = 2048;
let _decorDraws: DecorDraw[] | null = null;

export async function prepareDecorationExport(
  result: GenerationResult,
): Promise<{ cellSize: number; cells: { cx: number; cy: number }[] } | null> {
  const draws: DecorDraw[] = [];

  // 1. Pixel scenes (z-order below markers, so pushed first).
  const built = await buildSceneBitmaps(result, null);
  if (!built) return null;
  for (const scene of built.validScenes) {
    const bmp = built.bitmapByKey.get(scene.key);
    if (!bmp) continue;
    draws.push({ img: bmp, x: scene.x, y: scene.y, w: scene.width, h: scene.height });
  }
  const sceneCount = draws.length;

  // 2. POI marker sprites. Mirrors marker-tile-source.ts at drawScale=1 with
  // no spoiler scrub (bake is always full-detail; spoiler-free is disabled on
  // baked seeds client-side).
  const md = await buildMarkerData(result);
  for (const item of md.items) {
    const keys = Array.isArray(item.spriteKey) ? item.spriteKey : [item.spriteKey];
    const isTaikasauva = !!(item.poi && (item.poi as any).isTaikasauva);
    let isMain = true;
    let rootOX = 0, rootOY = 0;
    for (const k of keys) {
      const a = md.atlas[k];
      if (!a) continue;
      if (isMain) {
        isMain = false;
        rootOX = a.ox ?? item.w / 2;
        rootOY = a.oy ?? item.h / 2;
      }
      // Same math as the tile source: layer top-left = marker centre minus the
      // root layer's origin (per-layer l_ox cancels out at drawScale=1).
      draws.push({
        img: md.spritesheet,
        sx: a.x, sy: a.y, sw: a.w, sh: a.h,
        x: item.osdX - rootOX, y: item.osdY - rootOY, w: a.w, h: a.h,
        rot: isTaikasauva,
      });
    }
  }
  _decorDraws = draws;

  // Non-empty cells on the absolute world grid (cell x0 = cx * DECOR_CELL).
  const cellSet = new Set<string>();
  for (const d of draws) {
    const cx0 = Math.floor(d.x / DECOR_CELL), cx1 = Math.floor((d.x + d.w - 1) / DECOR_CELL);
    const cy0 = Math.floor(d.y / DECOR_CELL), cy1 = Math.floor((d.y + d.h - 1) / DECOR_CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cellSet.add(`${cx},${cy}`);
  }
  const cells = [...cellSet].map((s) => {
    const [cx, cy] = s.split(",").map(Number);
    return { cx, cy };
  });
  console.log(
    `[OSD Bridge] Decor export prepared: ${sceneCount} scenes + ${draws.length - sceneCount} sprite layers, ${cells.length} cells`,
  );
  return { cellSize: DECOR_CELL, cells };
}

/** Render one decor grid cell; returns a PNG data URL or null when empty. */
export function exportDecorationCell(cx: number, cy: number): string | null {
  if (!_decorDraws) return null;
  const x0 = cx * DECOR_CELL, y0 = cy * DECOR_CELL;
  const hits = _decorDraws.filter(
    (d) => d.x < x0 + DECOR_CELL && d.x + d.w > x0 && d.y < y0 + DECOR_CELL && d.y + d.h > y0,
  );
  if (hits.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = DECOR_CELL;
  canvas.height = DECOR_CELL;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  for (const d of hits) {
    if (d.sw !== undefined) {
      if (d.rot) {
        const cx = d.x - x0 + d.w / 2;
        const cy = d.y - y0 + d.h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2); // tip-up -> tip-left
        ctx.drawImage(d.img, d.sx!, d.sy!, d.sw!, d.sh!, -d.w / 2, -d.h / 2, d.w, d.h);
        ctx.restore();
      } else {
        ctx.drawImage(d.img, d.sx!, d.sy!, d.sw!, d.sh!, d.x - x0, d.y - y0, d.w, d.h);
      }
    } else {
      ctx.drawImage(d.img, d.x - x0, d.y - y0, d.w, d.h);
    }
  }
  return canvas.toDataURL("image/png");
}

export function releaseDecorationExport(): void {
  _decorDraws = null;
}


/**
 * Re-render the 9 biome regions (3 horizontal PWs × 3 verticals: main/heaven/
 * hell) for a finished generation, plus per-region biome-bg masks (main world
 * only) so a downstream Node compositor can stamp the live map's biome
 * backgrounds in at native scale before stitching. Heaven/hell regions get a
 * solid black bg downstream (matches the live map, which doesn't paint biome
 * bgs in those planes). Empty regions are skipped and logged.
 */
export async function exportBiomeRegionImages(
  result: GenerationResult,
): Promise<BiomeRegionExportResult> {
  await ensureTelescopeModules();

  const { tileLayers, biomeData, isNGP, worldCenter, parallelWorlds } = result;
  const w = isNGP ? 72 : 70;
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];
  const pwOrder = [...pws].sort((a, b) => {
    if (a === 0) return -1;
    if (b === 0) return 1;
    return b - a;
  });

  const layerIndicesByBiome = new Map<string, number[]>();
  for (let i = 0; i < tileLayers.length; i++) {
    const layer = tileLayers[i];
    if (layer.biomeName) {
      const arr = layerIndicesByBiome.get(layer.biomeName);
      if (arr) arr.push(i);
      else layerIndicesByBiome.set(layer.biomeName, [i]);
    }
  }
  const orderedBiomes = BIOME_RENDER_ORDER.filter((b) => !SKIP_BIOMES.has(b));
  const orderedSet = new Set<string>(orderedBiomes);
  const unorderedBiomes: string[] = [];
  for (const [biomeName] of layerIndicesByBiome) {
    if (!orderedSet.has(biomeName) && !SKIP_BIOMES.has(biomeName)) unorderedBiomes.push(biomeName);
  }
  const allBiomesToRender = [...orderedBiomes, ...unorderedBiomes];

  const anchorY = -(14 * 512);
  const pvtList = [0, -1, 1].filter((pvt) => {
    if (pvt < 0 && !biomeData.heavenPixels) return false;
    if (pvt > 0 && !biomeData.hellPixels) return false;
    return true;
  });

  // Load the static-map biome boundary polygons (same source the live bg
  // renderer uses). Polygons live in static-map coords:
  //   gx = svgX * CHUNK_SIZE + MAP_TOP_LEFT_X
  //   gy = svgY * CHUNK_SIZE + BIOME_IMAGE_TOP_Y
  // Per pw the bg translates by pw * pwOffsetPixels horizontally.
  const boundaryData = (await import("../data/biome_boundries_py.json")).default as any;
  const biomesWithBg = (boundaryData?.biomes ?? []).filter(
    (b: any) => b.filename && BIOME_BACKGROUND_MAP[b.filename] && !SKIP_BIOMES.has(b.filename),
  );
  // Stable index assignment: each biome's `filename` -> integer index ≥ 1.
  // 0 is reserved for "no biome" (alpha=0 in the mask).
  const biomeIndex: Record<number, string> = {};
  const indexByFilename = new Map<string, number>();
  biomesWithBg.forEach((b: any, i: number) => {
    const idx = i + 1;
    indexByFilename.set(b.filename, idx);
    // Value is the bg PNG basename so the Node side can fetch
    // noitamap/public/biome_bg/<file>.
    const bgPath = BIOME_BACKGROUND_MAP[b.filename];
    biomeIndex[idx] = bgPath.split("/").pop() || bgPath;
  });

  const CHUNK = 512;
  const MAP_TOP_LEFT_X = -17920;
  const BIOME_IMAGE_TOP_Y = -14 * CHUNK;

  const out: BiomeRegionImage[] = [];

  for (const pw of pwOrder) {
    for (const pvt of pvtList) {
      const overlays: (OffscreenCanvas | null)[] = createTileOverlaysCheap(
        biomeData, tileLayers, pw, pvt, isNGP,
      );

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const validOverlays: { overlay: OffscreenCanvas; x: number; y: number }[] = [];
      for (const biomeName of allBiomesToRender) {
        const layerIdxArr = layerIndicesByBiome.get(biomeName);
        if (!layerIdxArr) continue;
        for (const layerIdx of layerIdxArr) {
          const overlay = overlays[layerIdx];
          if (!overlay || overlay.width === 0 || overlay.height === 0) continue;
          const layer = tileLayers[layerIdx];
          const x = -(worldCenter * 512) + pw * pwOffsetPixels + layer.correctedX;
          const y = anchorY + layer.correctedY + pvt * 24576;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + overlay.width * 10);
          maxY = Math.max(maxY, y + overlay.height * 10);
          validOverlays.push({ overlay, x, y });
        }
      }
      if (validOverlays.length === 0) {
        console.warn(`[export] skipped empty region pw=${pw} pvt=${pvt}`);
        continue;
      }

      const compositeW = Math.ceil((maxX - minX) / 10);
      const compositeH = Math.ceil((maxY - minY) / 10);
      const compositeCanvas = new OffscreenCanvas(compositeW, compositeH);
      const compositeCtx = compositeCanvas.getContext("2d")!;
      for (const { overlay, x, y } of validOverlays) {
        compositeCtx.drawImage(overlay, Math.round((x - minX) / 10), Math.round((y - minY) / 10));
      }

      const smallData = compositeCtx.getImageData(0, 0, compositeW, compositeH);
      // Force overlay alpha to binary (0/255 with 128 threshold). The overlay
      // bitmaps from createTileOverlaysCheap can carry soft-alpha edge pixels
      // which blend badly when the upscale step composites biome bgs
      // underneath. Snapping alpha kills the fringe at the source. The final
      // flatten-to-opaque-black happens later, in upscalePngWithBg, AFTER the
      // bgs are baked underneath.
      for (let i = 3; i < smallData.data.length; i += 4) {
        smallData.data[i] = smallData.data[i] >= 128 ? 255 : 0;
      }
      const osdWidth = compositeW * 10;
      const scale = osdWidth / compositeW;
      const small = await blobToBase64(await rgbaToPngBlob(smallData.data, compositeW, compositeH));

      // Per-region biome-index mask. Main world only — biome polygons are
      // anchored to the static-map (boundary JSON only covers main-world
      // biomes), so heaven/hell skip the mask and emit transparent gaps.
      let mask: string | undefined;
      if (pvt === 0) {
        const maskCanvas = new OffscreenCanvas(compositeW, compositeH);
        const maskCtx = maskCanvas.getContext("2d")!;
        // Translate biome-polygon static-map coords into this region's local
        // (compositeW, compositeH) space. The region's top-left is (minX, minY)
        // in OSD coords; biomes' static-map gx/gy translate by pw horizontally.
        const pwShift = pw * pwOffsetPixels;
        for (const biome of biomesWithBg) {
          const idx = indexByFilename.get(biome.filename);
          if (!idx) continue;
          const rawParts = (biome.svg_map_path as string).split(" ");
          maskCtx.beginPath();
          let prev: string | null = null;
          for (let j = 0; j < rawParts.length; j++) {
            const part = rawParts[j];
            if (part === "M" || part === "L" || part === "Z") {
              if (part === "Z") maskCtx.closePath();
              prev = part;
              continue;
            }
            const xVal = Number(part);
            const yPart = rawParts[j + 1];
            if (yPart === undefined) break;
            const yVal = Number(yPart);
            const gx = xVal * CHUNK + MAP_TOP_LEFT_X + pwShift;
            const gy = yVal * CHUNK + BIOME_IMAGE_TOP_Y;
            // Convert to local mask coords (1px = 10 OSD units).
            const cx = (gx - minX) / 10;
            const cy = (gy - minY) / 10;
            if (prev === "M") maskCtx.moveTo(cx, cy);
            else maskCtx.lineTo(cx, cy);
            j++; // skip the y part we just consumed
            prev = "L";
          }
          maskCtx.fillStyle = `rgb(${(idx >> 16) & 0xff}, ${(idx >> 8) & 0xff}, ${idx & 0xff})`;
          maskCtx.fill();
        }
        const maskData = maskCtx.getImageData(0, 0, compositeW, compositeH);
        // Force alpha to 255 wherever any biome was painted, 0 elsewhere — so
        // the Node side has a clean alpha=255 / alpha=0 mask with no
        // antialiased edges. (Canvas2D may have anti-aliased polygon edges.)
        for (let i = 0; i < maskData.data.length; i += 4) {
          const any = maskData.data[i] | maskData.data[i + 1] | maskData.data[i + 2];
          maskData.data[i + 3] = any ? 255 : 0;
        }
        mask = await blobToBase64(await rgbaToPngBlob(maskData.data, compositeW, compositeH));
      }

      out.push({
        pw, pvt,
        minX: Math.round(minX), minY: Math.round(minY),
        osdWidth, scale, compositeW, compositeH,
        small, mask,
      });
    }
  }

  return { regions: out, biomeIndex };
}

// ─── Pixel Scene Config ─────────────────────────────────────────────────────

/** Runtime pixel scene toggle config. Categories can be turned on/off. */
export const pixelSceneConfig = {
  /** Master toggle — disables all pixel scenes when false */
  enabled: true,
  /** Skip lists by scene name */
  skipNames: new Set([
    // Player rooms — not relevant for map
    "essence_altar",
    "essence_altar_desert",
    "fishing_hut",
    "scale",
    "meatroom",
    "roboroom",
    "gourd_room",
    "ocarina",
    "funroom",
    "lavalake_racing",
    "secret_lab",
    "altar_top",
    "altar_top_ending",
    "hourglass_chamber",
    "watercave",
    "altar_top_water",
    "altar_top_lava",
    "altar_top_blood",
    "altar_top_oil",
    "altar_top_radioactive",
    "teleportroom",
    "mystery_teleport",
    "robot_egg",
    "secret_chamber",
    "cube_chamber",
    "alchemist_secret",
    "alchemist_secret_music",
    "null_room",
    "eyespot",
    "orbroom",
    "yourroom",
    "yourroom_entrance",
    "yourroom_npc",
    "yourroom_coffin",
    "yourroom_coffin_entrance",
    "yourroom_coffin_npc",
    // Boss/special scenes — misplaced if duplicated from scanner
    "boss_arena",
    "boss_arena_top",
    "boss_victoryroom",
    // Spliced scenes prebaked in map capture
    "tree",
    "mountain_lake",
    "lavalake2",
    "lavalake_pit_bottom",
    "skull",
    "skull_in_desert",
    "lake_statue",
    // Static scenes prebaked in map capture
    "lavalake_pit",
    "lavalake_pit_cracked",
    "cauldron",
    "cliff",
    "rainbow_cloud",
    "huussi",
    "snowy_ruins_eye_pillar",
    "desert_ruins_base_01",
    "music_machine_stand",
    "bunker",
    "bunker2",
    "greed_treasure",
    // Biome color scenes prebaked in map capture
    "dragoncave",
    "roadblock",
    "wizardcave_entrance",
    // Pyramid scenes - prebaked in map art
    "left",
    "right",
    // Hidden cavern - prebaked in OSD
    "solid_wall_hidden_cavern",
  ]),
  /** Skip lists by biome prefix in scene key */
  skipBiomes: new Set([
    "dragoncave", // prebaked in static map art
    "mountain", // mountain scenes are prebaked in map capture
    "pyramid", // pyramid scenes are prebaked in map capture
  ]),
  /** Category toggles */
  categories: {
    static: true, // hardcoded-position scenes (pyramid boss, fishing hut, etc.)
    biomeChunk: true, // biome-color-driven chunk scenes (orbrooms, essencerooms, etc.)
    spawned: true, // scenes placed by spawn functions (shops, oiltanks, etc.)
    spliced: true, // spliced scenes (moon, watercave edges, mountain_lake, etc.)
    temple: true, // holy mountain altar scenes
    friendRoom: true, // friend caves
    watercave: true, // watercave layouts
    snowcastle: true, // snowcastle_cavern (hiisi hourglass shop)
  } as Record<string, boolean>,
  /** Custom skip function — return true to skip a scene. */
  skipFn: ((s: { name: string; key: string; x: number; y: number }) => {
    // Skip lake essenceroom (prebaked at ~-14000,13570) but keep tower one (~10000,4350)
    if (s.name === "essenceroom" && s.x < 0) return true;
    return false;
  }) as ((scene: { name: string; key: string; x: number; y: number }) => boolean) | null,
  /** Global per-layer toggles for compositing */
  layers: {
    background: true, // _background.png (bottom layer)
    mid: true, // imgElement/recolored (middle layer from telescope)
    visual: true, // _visual.png (top layer)
  },
  /**
   * Per-scene layer overrides. Keyed by scene name (e.g. "friendroom", "altar_top").
   * Each value: { background?: boolean, mid?: boolean, visual?: boolean }
   * Unset properties fall back to global `layers` defaults.
   * Example: layerOverrides["friendroom"] = { background: false, mid: true, visual: true }
   */
  layerOverrides: {} as Record<string, { background?: boolean; mid?: boolean; visual?: boolean }>,
};

// Expose to console for debug toggling
(window as any).__pixelSceneConfig = pixelSceneConfig;

/** Last loaded scene list for debug introspection */
let _lastLoadedScenes: Array<{ name: string; key: string; x: number; y: number; category: string | null }> = [];

/** Debug panel (off by default, call window.__pixelSceneDebug() to open) */
(window as any).__pixelSceneDebug = () => {
  const cfg = pixelSceneConfig;
  console.group("%c[Pixel Scene Debug]", "color: #0af; font-weight: bold");
  console.log("Master enabled:", cfg.enabled);
  console.log("Skip names:", [...cfg.skipNames]);
  console.log("Skip biomes:", [...cfg.skipBiomes]);
  console.log("Categories:", { ...cfg.categories });
  console.log("");
  console.log("Commands:");
  console.log("  __pixelSceneList()              // list all loaded scenes");
  console.log("  __pixelSceneToggle('name')      // toggle a scene name on/off in skipNames");
  console.log("  __pixelSceneHover(true)         // enable hover to show scene names");
  console.log("  __pixelSceneHover(false)        // disable hover");
  console.log("");
  console.log("Layer toggles (re-enter seed after changing):");
  console.log("  __pixelSceneConfig.layers.background = false // global: skip _background.png");
  console.log("  __pixelSceneConfig.layers.mid = false        // global: skip imgElement (recolored)");
  console.log("  __pixelSceneConfig.layers.visual = false     // global: skip _visual.png");
  console.log("");
  console.log("Per-scene layer overrides (re-enter seed after changing):");
  console.log("  __pixelSceneConfig.layerOverrides['friendroom'] = { background: false }");
  console.log("  __pixelSceneConfig.layerOverrides['altar_top'] = { mid: false, visual: true }");
  console.log("  delete __pixelSceneConfig.layerOverrides['friendroom'] // reset to global");
  console.log("");
  console.log("Other:");
  console.log("  __pixelSceneConfig.enabled = false           // disable all");
  console.log("  __pixelSceneConfig.categories.temple = false // disable temple scenes");
  console.log("  __pixelSceneConfig.skipNames.add('orbroom')  // skip orbroom");
  console.log("  __pixelSceneConfig.skipBiomes.delete('dragoncave') // unblock dragoncave");
  console.log("After changing, re-enter the seed to regenerate.");
  console.groupEnd();
};

/** List all loaded pixel scenes, grouped by category */
(window as any).__pixelSceneList = () => {
  if (_lastLoadedScenes.length === 0) {
    console.log("[Pixel Scenes] No scenes loaded yet. Generate a seed first.");
    return;
  }
  const byCategory = new Map<string, typeof _lastLoadedScenes>();
  for (const s of _lastLoadedScenes) {
    const cat = s.category || "uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(s);
  }
  console.group(`%c[Pixel Scenes] ${_lastLoadedScenes.length} scenes loaded`, "color: #0af; font-weight: bold");
  for (const [cat, scenes] of byCategory) {
    const enabled = pixelSceneConfig.categories[cat] !== false;
    console.group(`${cat} (${scenes.length}) ${enabled ? "✓" : "✗ DISABLED"}`);
    const uniqueNames = [...new Set(scenes.map((s) => s.name))].sort();
    for (const name of uniqueNames) {
      const count = scenes.filter((s) => s.name === name).length;
      const skipped = pixelSceneConfig.skipNames.has(name);
      console.log(`  ${skipped ? "✗" : "✓"} ${name} (×${count})${skipped ? " [SKIPPED]" : ""}`);
    }
    console.groupEnd();
  }
  console.groupEnd();
};

/** Toggle a scene name on/off in skipNames */
(window as any).__pixelSceneToggle = (name: string) => {
  if (pixelSceneConfig.skipNames.has(name)) {
    pixelSceneConfig.skipNames.delete(name);
    console.log(`[Pixel Scenes] "${name}" UN-SKIPPED. Re-enter seed to regenerate.`);
  } else {
    pixelSceneConfig.skipNames.add(name);
    console.log(`[Pixel Scenes] "${name}" SKIPPED. Re-enter seed to regenerate.`);
  }
};

/** Toggle base OSD map tiles visibility. Call __toggleBaseMap() from console. */
(window as any).__toggleBaseMap = () => {
  const osd = (window as any).__osdViewer;
  if (!osd) {
    console.log("No OSD viewer found. Set window.__osdViewer first.");
    return;
  }
  const world = osd.world;
  const count = world.getItemCount();
  // Items 0..N are base map tiles; dynamic overlays are tracked in dynamicTiledImages
  for (let i = 0; i < count; i++) {
    const item = world.getItemAt(i);
    if (!dynamicTiledImages.has(item)) {
      const cur = item.getOpacity();
      item.setOpacity(cur > 0 ? 0 : 1);
    }
  }
  console.log("[OSD] Toggled base map tiles visibility");
};

// ─── Pixel Scenes ───────────────────────────────────────────────────────────

/**
 * Categorize a pixel scene for config filtering.
 */
function getSceneCategory(scene: PixelScene): string | null {
  const key = scene.key;
  const name = scene.name;
  const biome = key.split("/")[0];

  if (biome === "spliced") return "spliced";
  if (biome.includes("temple")) return "temple";
  if (name === "friendroom" || name === "cavern") return "friendRoom";
  if (name.startsWith("watercave_layout")) return "watercave";
  if (name === "side_cavern_left" || name === "side_cavern_right") return "snowcastle";
  if (biome.startsWith("friend_")) return "friendRoom";
  if (biome === "snowcastle_cavern" || biome === "sandcave") return "snowcastle";

  return "spawned"; // default for spawn-function-generated scenes
}

/**
 * Convert a telescope imgElement (Uint8Array, Uint8ClampedArray, Canvas, or OffscreenCanvas)
 * to an ImageBitmap for drawing. Fixes magenta placeholder pixels (0xff00ff) and
 * air color (0x000042) by making them transparent.
 */
async function imgElementToBitmap(
  img: HTMLCanvasElement | OffscreenCanvas | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ImageBitmap | null> {
  try {
    if (img instanceof HTMLCanvasElement || img instanceof OffscreenCanvas) {
      return await createImageBitmap(img);
    }
    // Raw RGBA pixel data — fix placeholder colors
    const src = img instanceof Uint8ClampedArray ? img : new Uint8ClampedArray(img);
    const fixed = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const r = src[i],
        g = src[i + 1],
        b = src[i + 2];
      // Magenta placeholder (0xff00ff) → transparent
      if (r === 0xff && g === 0x00 && b === 0xff) {
        fixed[i + 3] = 0;
        continue;
      }
      // Air color (0x000042) → transparent
      if (r === 0x00 && g === 0x00 && b === 0x42) {
        fixed[i + 3] = 0;
        continue;
      }
      fixed[i] = r;
      fixed[i + 1] = g;
      fixed[i + 2] = b;
      fixed[i + 3] = src[i + 3];
    }
    const imageData = new ImageData(fixed, width, height);
    return await createImageBitmap(imageData);
  } catch (e) {
    console.warn("[OSD Bridge] imgElementToBitmap failed:", e);
    return null;
  }
}

/**
 * Pre-indexed lookup of _visual.png and _background.png files in data.zip.
 */
interface ScenePngIndex {
  visualByPath: Map<string, string>;
  visualByName: Map<string, string>;
  bgByPath: Map<string, string>;
  bgByName: Map<string, string>;
}
let _pngIndex: ScenePngIndex | null = null;

async function getScenePngIndex(): Promise<ScenePngIndex> {
  if (_pngIndex) return _pngIndex;
  const zip = await getDataZip();
  const visualByPath = new Map<string, string>();
  const visualByName = new Map<string, string>();
  const bgByPath = new Map<string, string>();
  const bgByName = new Map<string, string>();
  // Collect plain .png as fallback visuals (used when no _visual.png exists)
  // NOTE: plain .png in biome_impl are material color maps, NOT visuals.
  // Do not use them as visual fallbacks.
  if (zip) {
    zip.forEach((relativePath: string) => {
      if (!relativePath.startsWith("data/biome_impl/") || !relativePath.endsWith(".png")) return;
      const inner = relativePath.substring("data/biome_impl/".length);
      const addTo = (suffix: string, pathMap: Map<string, string>, nameMap: Map<string, string>) => {
        if (!inner.endsWith(suffix)) return;
        const key = inner.substring(0, inner.length - suffix.length);
        pathMap.set(key, relativePath);
        const slash = key.lastIndexOf("/");
        const nameOnly = slash >= 0 ? key.substring(slash + 1) : key;
        if (!nameMap.has(nameOnly)) nameMap.set(nameOnly, relativePath);
      };
      addTo("_visual.png", visualByPath, visualByName);
      addTo("_background.png", bgByPath, bgByName);
      addTo("_bg.png", bgByPath, bgByName);
      // Temple foreground scenes use _fg.png instead of _visual.png
      addTo("_fg.png", visualByPath, visualByName);
      // Top-level plain .png files (no subdirectory, no _visual/_background suffix) —
      // these are full pixel scene visuals like watercave_layout_X.png
      if (!inner.includes("/") && !inner.endsWith("_visual.png") && !inner.endsWith("_background.png")) {
        const key = inner.substring(0, inner.length - ".png".length);
        // Add as visual by name so resolveScenePath can find them
        if (!visualByName.has(key)) visualByName.set(key, relativePath);
      }
    });
  }
  _pngIndex = { visualByPath, visualByName, bgByPath, bgByName };
  console.log(`[OSD Bridge] Scene PNG index: ${visualByPath.size} visual, ${bgByPath.size} background`);
  return _pngIndex;
}

/** Resolve best matching zip path for a scene across lookup maps, with suffix-stripping fallback. */
function resolveScenePath(
  byPath: Map<string, string>,
  byName: Map<string, string>,
  biome: string,
  name: string,
  sceneKey: string,
): string | undefined {
  let found = byPath.get(sceneKey) || byName.get(name);
  if (found) return found;
  let base = name;
  while (base.includes("_")) {
    base = base.substring(0, base.lastIndexOf("_"));
    found = byPath.get(`${biome}/${base}`) || byName.get(base);
    if (found) return found;
  }
  return undefined;
}

// Spawn-marker colors found in temple wang templates (DEFAULT_SPAWNS + TEMPLES_COMMON_SPAWNS).
// These would otherwise show as visible dots on the map since the temple _fg.png bypasses
// telescope's normal spawn-pixel scanning pipeline.
const TEMPLE_SPAWN_STRIP_COLORS = new Set<number>([
  0xff0000, 0x800000, 0x00ff00, 0xc88d1a, 0xc88000, 0xc80040, 0xffff00, 0xff0aff, 0xff0080,
  0xff8000, 0xc84040, 0x804040, 0x96c850, 0x60a064, 0x50a000, 0xbca0f0, 0x00ff5a, 0x78ffff,
  0x50a0f0, 0xbf26a6, 0x04a977, 0xffd171, 0xffd181, 0xffff81, 0xc7eb28, 0xe8ff80, 0x2768de,
  0x2768df, 0x6b4f9b, 0xd7b3e8,
  0x805000, 0x397780, 0x00ffa0, 0x1ca7ff, 0xffeed0, 0xffeed1, 0xffeed2, 0xffeed3, 0xffeed4,
  0xffeed5, 0xffeed6, 0xffeeda, 0xffeedb, 0xffeedc, 0xffeedd, 0xffeede, 0xffeedf,
  0xffaaaa, 0xffaadd,
]);

/** Decode a PNG from data.zip, applying background transparency. */
async function decodeScenePng(zip: any, path: string): Promise<ImageData | null> {
  const file = zip.file(path);
  if (!file) return null;
  const buf = await file.async("arraybuffer");
  const decoded = decodePngToRgba(buf);
  const d = decoded.data;
  const tlR = d[0],
    tlG = d[1],
    tlB = d[2],
    tlA = d[3];
  if (tlA === 0) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 255) d[i + 3] = 0;
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 66) d[i + 3] = 0; // Noita air color
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0; // Magenta placeholder
    }
  } else {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === tlR && d[i + 1] === tlG && d[i + 2] === tlB) d[i + 3] = 0;
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 66) d[i + 3] = 0; // Noita air color
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0; // Magenta placeholder
    }
  }
  if (path.includes("/temples-assets/") && path.endsWith("_fg.png")) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (TEMPLE_SPAWN_STRIP_COLORS.has(c)) d[i + 3] = 0;
    }
  }
  return new ImageData(new Uint8ClampedArray(d as any), decoded.width, decoded.height);
}

/**
 * Load a pixel scene bitmap from data.zip.
 * Composites _background.png (below) + _visual.png (above) when both exist.
 */
const _visualPngMissLog = new Set<string>();

async function loadVisualPngBitmap(sceneKey: string): Promise<ImageBitmap | null> {
  const zip = await getDataZip();
  if (!zip) return null;

  const slashIdx = sceneKey.indexOf("/");
  if (slashIdx === -1) return null;

  const biome = sceneKey.substring(0, slashIdx);
  const name = sceneKey.substring(slashIdx + 1);

  const idx = await getScenePngIndex();

  const visualPath = resolveScenePath(idx.visualByPath, idx.visualByName, biome, name, sceneKey);
  // Skip backgrounds for biomes where the prebaked map already provides the bg
  const skipBg = biome === "temple" || biome === "general";
  const bgPath = skipBg ? undefined : resolveScenePath(idx.bgByPath, idx.bgByName, biome, name, sceneKey);

  if (!visualPath && !bgPath) {
    if (!_visualPngMissLog.has(sceneKey)) {
      _visualPngMissLog.add(sceneKey);
      console.log(`[OSD Bridge] No visual/bg PNG for "${sceneKey}", using imgElement fallback`);
    }
    return null;
  }

  try {
    const bgData = bgPath ? await decodeScenePng(zip, bgPath) : null;
    const visualData = visualPath ? await decodeScenePng(zip, visualPath) : null;

    if (!bgData && visualData) return await createImageBitmap(visualData);
    if (bgData && !visualData) return await createImageBitmap(bgData);

    // Composite: background underneath, visual on top
    // Skip tiny bg patches (material variant thumbnails ≤32px) — they're not real backgrounds
    if (bgData && visualData) {
      const useBg = bgData.width >= visualData.width / 2 && bgData.height >= visualData.height / 2;
      if (!useBg) return await createImageBitmap(visualData);
      const w = Math.max(bgData.width, visualData.width);
      const h = Math.max(bgData.height, visualData.height);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      const bgBmp = await createImageBitmap(bgData);
      ctx.drawImage(bgBmp, 0, 0);
      bgBmp.close();
      const visBmp = await createImageBitmap(visualData);
      ctx.drawImage(visBmp, 0, 0);
      visBmp.close();
      return await createImageBitmap(canvas);
    }
  } catch (e) {
    console.warn(`[OSD Bridge] Failed to load scene PNGs for "${sceneKey}":`, e);
  }
  return null;
}

/**
 * Composite a single pixel scene's three layers into one ImageBitmap (and
 * return its PNG-encoded blob for caching). Centralized here so both the
 * render path and the background prefetch use the same logic.
 *
 * Returns null when no layers can be loaded for this key.
 */
async function compositeSceneBitmap(
  key: string,
  scene: { imgElement: any; width: number; height: number; name: string; key: string },
  idx: { visualByPath: Map<string, string>; visualByName: Map<string, string>; bgByPath: Map<string, string>; bgByName: Map<string, string> },
): Promise<{ bitmap: ImageBitmap; blob: Blob | null; width: number; height: number; kind: "composite" | "fallback" } | null> {
  const slashIdx = key.indexOf("/");
  const biome = slashIdx >= 0 ? key.substring(0, slashIdx) : "";
  const name = slashIdx >= 0 ? key.substring(slashIdx + 1) : key;

  const skipBg = biome === "temple" || biome === "general";

  const override = pixelSceneConfig.layerOverrides[name] || pixelSceneConfig.layerOverrides[key];
  const wantBg = override?.background ?? pixelSceneConfig.layers.background;
  const wantMid = override?.mid ?? pixelSceneConfig.layers.mid;
  const wantVis = override?.visual ?? pixelSceneConfig.layers.visual;

  const visualPath = wantVis ? resolveScenePath(idx.visualByPath, idx.visualByName, biome, name, key) : undefined;
  const bgPath = skipBg || !wantBg ? undefined : resolveScenePath(idx.bgByPath, idx.bgByName, biome, name, key);

  const zip = await getDataZip();
  let bgData: ImageData | null = null;
  let visualData: ImageData | null = null;

  if (zip && bgPath) {
    bgData = await decodeScenePng(zip, bgPath).catch(() => null);
    if (bgData && scene.width > 0 && bgData.width < scene.width / 2) bgData = null;
  }
  if (zip && visualPath) {
    visualData = await decodeScenePng(zip, visualPath).catch(() => null);
  }

  let midBitmap: ImageBitmap | null = null;
  if (wantMid && scene.imgElement) {
    midBitmap = await imgElementToBitmap(scene.imgElement, scene.width, scene.height);
  } else if (wantMid) {
    const rawImgEl = getPixelSceneImgElement(scene.key);
    if (rawImgEl) {
      let recolored = rawImgEl;
      try {
        recolored = recolorPixelSceneForBiome(scene.name, rawImgEl, biome);
        for (let i = 0; i < recolored.length; i += 4) {
          if (recolored[i] === 0xff && recolored[i + 1] === 0x00 && recolored[i + 2] === 0xff) {
            if (recolored[i + 3] === 0xff) {
              recolored[i] = 0x5a;
              recolored[i + 1] = 0x63;
              recolored[i + 2] = 0x69;
            }
          }
        }
      } catch (e) {
        console.warn("[OSD Bridge] Failed to recolor pixel scene fallback:", scene.key, e);
      }
      midBitmap = await imgElementToBitmap(recolored, scene.width, scene.height);
    }
  }

  const hasBg = !!bgData;
  const hasMid = !!midBitmap;
  const hasVis = !!visualData;
  if (!hasBg && !hasMid && !hasVis) return null;

  // Determine canvas dimensions matching the original per-branch behavior:
  // single-layer paths used the source's own dimensions, multi-layer used
  // scene.width/height (or max of bg/vis as fallback). Going through a canvas
  // for every path is necessary so we can convertToBlob for the IDB cache.
  let cw: number;
  let ch: number;
  let kind: "composite" | "fallback";
  if (hasMid && !hasBg && !hasVis) {
    cw = midBitmap!.width;
    ch = midBitmap!.height;
    kind = "fallback";
  } else if (hasVis && !hasBg && !hasMid) {
    cw = visualData!.width;
    ch = visualData!.height;
    kind = "composite";
  } else if (hasBg && !hasMid && !hasVis) {
    cw = bgData!.width;
    ch = bgData!.height;
    kind = "composite";
  } else {
    cw = scene.width || Math.max(bgData?.width ?? 0, visualData?.width ?? 0);
    ch = scene.height || Math.max(bgData?.height ?? 0, visualData?.height ?? 0);
    kind = "composite";
  }
  if (cw <= 0 || ch <= 0) return null;

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  let bgBmp: ImageBitmap | null = null;
  let visBmp: ImageBitmap | null = null;
  if (bgData) {
    bgBmp = await createImageBitmap(bgData);
    ctx.drawImage(bgBmp, 0, 0);
  }
  if (midBitmap) ctx.drawImage(midBitmap, 0, 0);
  if (visualData) {
    visBmp = await createImageBitmap(visualData);
    ctx.drawImage(visBmp, 0, 0);
  }

  const bitmap = await createImageBitmap(canvas);
  let blob: Blob | null = null;
  try {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } catch (e) {
    console.warn("[OSD Bridge] convertToBlob failed (scene won't be cached):", key, e);
  }

  if (bgBmp) bgBmp.close();
  if (midBitmap) midBitmap.close();
  if (visBmp) visBmp.close();

  return { bitmap, blob, width: cw, height: ch, kind };
}

let _scenePrefetchInflight: Promise<void> | null = null;

/**
 * Composite and persist every pixel scene key telescope knows about,
 * skipping ones already in the IDB cache. Fires once per session in the
 * background after the first render so future seed switches have zero
 * pixel-scene compositing work.
 */
export function prefetchAllSceneBitmaps(): Promise<void> {
  if (_scenePrefetchInflight) return _scenePrefetchInflight;
  _scenePrefetchInflight = (async () => {
    try {
      const adapter = await import("./telescope-adapter");
      const allKeysFn = (adapter as any).getAllPixelSceneKeys as (() => string[]) | undefined;
      const dataFn = (adapter as any).getPixelSceneData as ((key: string) => any) | undefined;
      if (!allKeysFn || !dataFn) {
        console.warn("[OSD Bridge] Pixel-scene prefetch unavailable: telescope adapter did not export key list");
        return;
      }
      const allKeys = allKeysFn();
      if (allKeys.length === 0) return;
      const cached = await getCachedSceneBitmapKeys();
      const missing = allKeys.filter((k) => !cached.has(k));
      if (missing.length === 0) {
        console.log(`[OSD Bridge] Pixel-scene prefetch: all ${allKeys.length} keys already cached`);
        return;
      }
      console.log(`[OSD Bridge] Pixel-scene prefetch: ${missing.length}/${allKeys.length} missing — warming cache in background...`);
      const idx = await getScenePngIndex();
      let warmed = 0;
      let skipped = 0;
      const t0 = performance.now();
      // Process serially to keep main-thread pressure low.
      for (const key of missing) {
        const data = dataFn(key);
        if (!data) { skipped++; continue; }
        const scene = {
          imgElement: data.imgElement || null,
          width: data.width || 0,
          height: data.height || 0,
          name: data.name || key.substring(key.indexOf("/") + 1),
          key,
        };
        try {
          const composited = await compositeSceneBitmap(key, scene, idx);
          if (!composited) { skipped++; continue; }
          composited.bitmap.close();
          if (composited.blob) {
            await cacheSceneBitmap(key, composited.blob, composited.width, composited.height);
            warmed++;
          } else {
            skipped++;
          }
        } catch (e) {
          skipped++;
          console.warn("[OSD Bridge] Prefetch composite failed:", key, e);
        }
        // Yield between keys so UI stays responsive.
        await new Promise((r) => setTimeout(r, 0));
      }
      console.log(
        `[OSD Bridge] Pixel-scene prefetch: warmed ${warmed}, skipped ${skipped}, took ${((performance.now() - t0) / 1000).toFixed(2)}s`,
      );
    } catch (e) {
      console.warn("[OSD Bridge] Pixel-scene prefetch failed:", e);
    } finally {
      _scenePrefetchInflight = null;
    }
  })();
  return _scenePrefetchInflight;
}

/**
 * Add pixel scenes for all parallel worlds to the viewer.
 *
 * Loads _visual.png from data.zip for proper pre-colored images.
 * Falls back to telescope's imgElement if no _visual.png exists.
 * Groups by scene key for bitmap caching. Builds a Flatbush spatial index
 * and creates ONE custom OSD tile source for efficient rendering.
 */
/**
 * Build the composite bitmap for every renderable pixel scene in `result`.
 * Shared by the live scene tile source (addPixelScenes) and the decoration
 * bake export. Pass generationId=null to skip cancellation checks (bake).
 * Returns null when cancelled mid-build.
 */
async function buildSceneBitmaps(
  result: GenerationResult,
  generationId: number | null,
): Promise<{ validScenes: PixelScene[]; bitmapByKey: Map<string, ImageBitmap> } | null> {
  const allScenes = Object.values(result.pixelScenesByPW).flat();
  const validScenes = allScenes.filter((s) => {
    if (!s || s.width <= 0 || s.height <= 0) return false;
    if (pixelSceneConfig.skipNames.has(s.name)) return false;
    const biome = s.key.split("/")[0];
    if (pixelSceneConfig.skipBiomes.has(biome)) return false;
    const category = getSceneCategory(s);
    if (category && !pixelSceneConfig.categories[category]) return false;
    if (pixelSceneConfig.skipFn && pixelSceneConfig.skipFn(s)) return false;
    return true;
  });
  const bitmapByKey = new Map<string, ImageBitmap>();
  if (validScenes.length === 0) return { validScenes, bitmapByKey };

  const uniqueKeys = new Map<string, PixelScene>();
  for (const scene of validScenes) {
    if (!uniqueKeys.has(scene.key)) uniqueKeys.set(scene.key, scene);
  }

  // Per-key bitmaps are seed-independent — cache them in IDB so future seeds
  // reuse the work. Bulk-fetch every cached bitmap in one IDB transaction
  // (~138 separate read transactions add 1-3s on Brave/FF).
  const BATCH = 50;
  const keyArr = Array.from(uniqueKeys.entries());
  let compositeCount = 0;
  let cacheHitCount = 0;
  let fallbackCount = 0;
  let missingCount = 0;
  const idx = await getScenePngIndex();
  const bulkSceneCache = await getCachedSceneBitmapsBulk(keyArr.map(([k]) => k));

  for (let i = 0; i < keyArr.length; i += BATCH) {
    if (generationId !== null && currentGenerationId !== generationId) return null;
    const batch = keyArr.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ([key, scene]) => {
        // ── Cache fast path ────────────────────────────────────────────────
        const cached = bulkSceneCache.get(key);
        if (cached) {
          try {
            const bmp = await createImageBitmap(cached.blob);
            bitmapByKey.set(key, bmp);
            cacheHitCount++;
            return;
          } catch {
            // fall through to recompute
          }
        }

        const composited = await compositeSceneBitmap(key, scene, idx);
        if (!composited) {
          missingCount++;
          return;
        }
        bitmapByKey.set(key, composited.bitmap);
        if (composited.kind === "fallback") fallbackCount++;
        else compositeCount++;
        if (composited.blob) {
          cacheSceneBitmap(key, composited.blob, composited.width, composited.height).catch((e) =>
            console.warn("[OSD Bridge] cacheSceneBitmap failed:", key, e),
          );
        }
      }),
    );
  }

  console.log(
    `[OSD Bridge] Pixel scene bitmaps: ${bitmapByKey.size}/${uniqueKeys.size} ` +
      `(${cacheHitCount} cache, ${compositeCount} composite, ${fallbackCount} fallback, ${missingCount} missing)`,
  );
  return { validScenes, bitmapByKey };
}

export async function addPixelScenes(viewer: OSDViewer, result: GenerationResult, generationId: number): Promise<void> {
  if (!pixelSceneConfig.enabled) return;

  const { pixelScenesByPW, worldCenter } = result;

  const allScenes = Object.values(pixelScenesByPW).flat();

  // Debug: check for specific expected scenes
  const debugNames = new Set(["friendroom", "cavern", "side_cavern_left", "side_cavern_right"]);
  const found = allScenes.filter((s) => s && debugNames.has(s.name));
  if (found.length > 0) {
    console.log(
      `[OSD Bridge] Found expected scenes:`,
      found.map((s) => `${s.name} (${s.key}) at (${s.x},${s.y})`),
    );
  } else {
    console.log(
      `[OSD Bridge] Missing expected scenes: friendroom, cavern, side_cavern_*. Telescope may not be generating them.`,
    );
  }

  const built = await buildSceneBitmaps(result, generationId);
  if (!built) return; // cancelled
  const { validScenes, bitmapByKey } = built;
  if (validScenes.length === 0) return;

  // Populate debug scene list for __pixelSceneList()
  _lastLoadedScenes = allScenes.map((s) => ({
    name: s.name,
    key: s.key,
    x: s.x,
    y: s.y,
    category: getSceneCategory(s),
  }));

  console.log(
    `[OSD Bridge] Pixel scenes: ${allScenes.length} total, ${validScenes.length} valid`,
  );

  if (currentGenerationId !== generationId) return;

  // 3. Build items array and compute bounding box
  interface SceneItem {
    osdX: number;
    osdY: number;
    w: number;
    h: number;
    sceneKey: string;
  }
  const items: SceneItem[] = [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const scene of validScenes) {
    if (!bitmapByKey.has(scene.key)) continue;
    // Raw engine coordinates align exactly to 1:1 mapped grid.
    const x = scene.x;
    const y = scene.y;
    items.push({ osdX: x, osdY: y, w: scene.width, h: scene.height, sceneKey: scene.key });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + scene.width > maxX) maxX = x + scene.width;
    if (y + scene.height > maxY) maxY = y + scene.height;
  }

  if (items.length === 0) return;

  const pad = 50;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const originX = minX;
  const originY = minY;
  const bboxWidth = maxX - minX;
  const bboxHeight = maxY - minY;

  // 3. Build Flatbush spatial index
  const Flatbush = (await import("flatbush")).default;
  const index = new Flatbush(items.length);
  for (const item of items) {
    index.add(item.osdX - originX, item.osdY - originY, item.osdX + item.w - originX, item.osdY + item.h - originY);
  }
  index.finish();

  // 4. Create custom tile source
  const TILE_SIZE = 512;
  const maxDim = Math.max(bboxWidth, bboxHeight);
  const maxLevel = Math.max(0, Math.ceil(Math.log2(maxDim)));

  let maxSceneDim = 0;
  for (const item of items) {
    if (item.w > maxSceneDim) maxSceneDim = item.w;
    if (item.h > maxSceneDim) maxSceneDim = item.h;
  }

  function tileBounds(level: number, tx: number, ty: number) {
    const scale = Math.pow(2, maxLevel - level);
    return {
      bx: tx * TILE_SIZE * scale,
      by: ty * TILE_SIZE * scale,
      bw: TILE_SIZE * scale,
      bh: TILE_SIZE * scale,
    };
  }

  const source = new OpenSeadragon.TileSource({
    height: bboxHeight,
    width: bboxWidth,
    tileSize: TILE_SIZE,
    minLevel: 0,
    maxLevel,
  });

  source.getTileUrl = function (level: number, x: number, y: number) {
    return `pixel-scene-tile://${generationId}/${level}/${x}/${y}`;
  };
  source.hasTransparency = function () {
    return true;
  };

  source.tileExists = function (level: number, x: number, y: number) {
    const { bx, by, bw, bh } = tileBounds(level, x, y);
    const p = maxSceneDim;
    return index.search(bx - p, by - p, bx + bw + p, by + bh + p).length > 0;
  };

  let logCount = 0;
  source.downloadTileStart = function (context: any) {
    const tile = context.tile;
    const { bx, by, bw, bh } = tileBounds(tile.level, tile.x, tile.y);
    const p = maxSceneDim;
    const results = index.search(bx - p, by - p, bx + bw + p, by + bh + p);

    if (logCount < 3) {
      console.log(`[PixelSceneTile] level=${tile.level} (${tile.x},${tile.y}), hits=${results.length}`);
      logCount++;
    }

    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    if (results.length > 0) {
      const drawScale = TILE_SIZE / bw;
      for (const idx of results) {
        const item = items[idx];
        if (!item) continue;
        const bitmap = bitmapByKey.get(item.sceneKey);
        if (!bitmap) continue;
        // Round to integers and add 0.5px overlap to prevent Chrome subpixel seams
        const drawX = Math.floor((item.osdX - originX - bx) * drawScale);
        const drawY = Math.floor((item.osdY - originY - by) * drawScale);
        const drawW = Math.ceil(item.w * drawScale) + 1;
        const drawH = Math.ceil(item.h * drawScale) + 1;
        if (drawW < 1 || drawH < 1) continue;
        ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, drawX, drawY, drawW, drawH);
      }
    }

    queueMicrotask(() => {
      context.finish(canvas, null, "image");
    });
  };
  source.downloadTileAbort = function () {};

  // 5. Add as a single tiled image to OSD
  viewer.addTiledImage({
    tileSource: source,
    x: originX,
    y: originY,
    width: bboxWidth,
    success: (event: any) => {
      if (currentGenerationId !== generationId) {
        try {
          viewer.world.removeItem(event.item);
        } catch {}
        return;
      }
      dynamicTiledImages.add(event.item);
    },
  });

  console.log(`[OSD Bridge] Added ${items.length} pixel scenes as single tile source`);

  // Debug: expose hover query for pixel scene identification
  // Enable with: __pixelSceneHover(true)   Disable with: __pixelSceneHover(false)
  (window as any).__pixelSceneHover = (enable: boolean) => {
    const handlerKey = "__psHoverHandler";
    const osdCanvas = viewer.canvas as HTMLElement;
    if (!enable) {
      if ((window as any)[handlerKey]) {
        osdCanvas.removeEventListener("mousemove", (window as any)[handlerKey]);
        delete (window as any)[handlerKey];
        const el = document.getElementById("__ps-debug-tooltip");
        if (el) el.style.display = "none";
        console.log("[PixelScene] Hover debug disabled");
      }
      return;
    }
    const handler = (event: MouseEvent) => {
      const vp = viewer.viewport.windowToViewportCoordinates(new OpenSeadragon.Point(event.clientX, event.clientY));
      const wx = vp.x - originX;
      const wy = vp.y - originY;
      const hits = index.search(wx, wy, wx, wy);
      const el = document.getElementById("__ps-debug-tooltip")!;
      if (hits.length > 0) {
        const names = hits.map((i: number) => items[i]?.sceneKey).filter(Boolean);
        if (names.length > 0) {
          el.textContent = names.join("\n");
          el.style.left = event.clientX + 12 + "px";
          el.style.top = event.clientY + 12 + "px";
          el.style.display = "block";
        }
      } else {
        el.style.display = "none";
      }
    };
    (window as any)[handlerKey] = handler;
    osdCanvas.addEventListener("mousemove", handler);
    // Create tooltip element
    if (!document.getElementById("__ps-debug-tooltip")) {
      const el = document.createElement("div");
      el.id = "__ps-debug-tooltip";
      el.style.cssText =
        "position:fixed;background:#000c;color:#0f0;font:12px monospace;padding:4px 8px;pointer-events:none;z-index:99999;display:none;border-radius:4px;white-space:pre";
      document.body.appendChild(el);
    }
    console.log("[PixelScene] Hover debug enabled — hover over pixel scenes to see their keys");
  };
}

// ─── POI Overlays ───────────────────────────────────────────────────────────

/**
 * Add POI markers as OSD HTML overlays.
 */
export async function addPOIOverlays(viewer: OSDViewer, result: GenerationResult, generationId: number): Promise<void> {
  await ensureTelescopeModules();
  if (currentGenerationId !== generationId) return;

  const { poisByPW, worldCenter } = result;

  const allPois = Object.values(poisByPW).flat();
  const wandsOnly: any[] = allPois.filter((p) => p.type === "wand").map((p) => p);

  // Pull wand items out of starting_loadout containers so they render via the
  // dynamic data.zip path (with CCW rotation) — the static atlas pipeline
  // skips wands without baked wand:<filename> keys (e.g. bomb_wand).
  for (const poi of allPois) {
    if (poi.type !== "starting_loadout" || !Array.isArray((poi as any).items)) continue;
    const inner = ((poi as any).items as any[]).filter((i) => i && !i.ignore && i.type === "wand");
    const count = inner.length;
    for (let ci = 0; ci < count; ci++) {
      const item = inner[ci];
      const offsetX = count > 1 ? (ci - (count - 1) / 2) * 18 : 0;
      wandsOnly.push({ ...item, x: (item.x ?? poi.x) + offsetX, y: (item.y ?? poi.y) + 24 });
    }
  }

  if (wandsOnly.length === 0) {
    console.log("[OSD Bridge] No wand POIs to render");
    return;
  }

  // Parallelize sprite loading
  const uniqueSpriteNames = [...new Set(wandsOnly.map((p) => p.sprite))].filter(Boolean) as string[];
  const spriteMap = new Map<string, { url: string; w: number; h: number }>();

  await Promise.all(
    uniqueSpriteNames.map(async (name) => {
      try {
        const rotated = await getRotatedWandSprite(name);
        if (rotated) spriteMap.set(name, rotated);
      } catch (err) {
        console.warn(`[OSD Bridge] Failed to load wand sprite: ${name}`, err);
      }
    }),
  );

  if (currentGenerationId !== generationId) return;

  let addedCount = 0;
  for (const poi of wandsOnly) {
    if (currentGenerationId !== generationId) return;

    const rotated = spriteMap.get(poi.sprite!);
    if (!rotated) continue;

    const el = document.createElement("img");
    el.src = rotated.url;
    el.className = "dynamic-poi poi-wand";
    // Taikasauva ("alive" wand): blob is CCW-90 (tip-up); rotate another
    // CCW 90° so the tip points left, distinguishing it from regular wands.
    const isTaikasauva = (poi as any).isTaikasauva === true;
    el.style.cssText = `
      image-rendering: pixelated;
      width: 100%;
      height: 100%;
      cursor: pointer;
      ${isTaikasauva ? "transform: rotate(-90deg);" : ""}
    `;

    const x = poi.x;
    const y = poi.y;

    const worldW = rotated.w;
    const worldH = rotated.h;

    viewer.addOverlay({
      element: el,
      location: new (OpenSeadragon as any).Rect(x - worldW / 2, y - worldH / 2, worldW, worldH),
    });

    dynamicOverlayElements.push(el);
    addedCount++;
  }
  console.log(
    `[OSD Bridge] Added ${addedCount}/${wandsOnly.length} wand overlays (${spriteMap.size} unique sprites loaded)`,
  );
}

// ─── Active marker data (for tooltip click handling) ────────────────────────
let activeMarkerData: MarkerData | null = null;
let tooltipEl: HTMLDivElement | null = null;
let canvasClickHandler: ((event: any) => void) | null = null;
let markerTiledImage: any = null;

// Marker tooltips bake i18next translations into textContent at render time.
// Keep a rebuild closure on the active tooltip element so a mid-display
// language switch re-renders the same tooltip in place rather than dismissing
// it. If the closure is missing (older path), fall back to dismissing so the
// next hover/click can rebuild.
i18next.on("languageChanged", () => {
  const el = tooltipEl as (HTMLDivElement & { __rebuild?: () => void }) | null;
  if (!el) return;
  if (typeof el.__rebuild === "function") {
    el.__rebuild();
  } else {
    el.remove();
    tooltipEl = null;
  }
});

/** Access to the active marker tiled image so consumers can force a reset/redraw. */
export function getMarkerTiledImage(): any {
  return markerTiledImage;
}

// ─── High-value highlight overlays ─────────────────────────────────────────
// HV rings are rendered as DOM overlays (CSS border-radius circles) instead of
// rasterized into marker tiles. Vector rendering avoids the canvas-downsampling
// artifacts (blurry / "color squares") the rasterized ring suffered in Chrome,
// and lets the browser anti-alias the outline at every zoom level.
let _hvOverlayElements: HTMLDivElement[] = [];
let _hvPredicate: ((poi: any) => boolean) | null = null;
const HV_RING_COLOR = "oklch(74.6% 0.16 232.661 / 0.95)";

function clearHighValueOverlays(viewer: any): void {
  for (const el of _hvOverlayElements) {
    try { viewer.removeOverlay(el); } catch {}
    el.remove();
  }
  _hvOverlayElements = [];
}

function rebuildHighValueOverlays(): void {
  const viewer = (window as any).__osdViewer;
  if (!viewer) return;
  clearHighValueOverlays(viewer);
  if (!_hvPredicate || !activeMarkerData) return;

  const items = activeMarkerData.items;
  let added = 0;
  for (const item of items) {
    if (!_hvPredicate(item.poi)) continue;
    const r = Math.max(8, Math.max(item.w, item.h) * 0.8);
    const el = document.createElement("div");
    el.className = "poi-hv-ring";
    el.style.cssText =
      "width:100%;height:100%;border:2px solid " + HV_RING_COLOR +
      ";border-radius:50%;pointer-events:none;box-sizing:border-box;";
    viewer.addOverlay({
      element: el,
      location: new (OpenSeadragon as any).Rect(item.osdX - r, item.osdY - r, r * 2, r * 2),
    });
    _hvOverlayElements.push(el);
    added++;
  }
  console.log(`[HighValueFilter] applied ${added} ring overlays`);
}

/**
 * Set the high-value predicate and rebuild the ring overlays. Pass null to
 * clear. The predicate is retained across map regenerations so a freshly
 * generated map auto-applies the rings.
 */
export function applyHighValueOverlays(predicate: ((poi: any) => boolean) | null): void {
  _hvPredicate = predicate;
  rebuildHighValueOverlays();
}

// Orb click data — stored here so the canvas-click handler can detect orb clicks
interface OrbClickTarget {
  osdX: number;
  osdY: number;
  orb: { name?: string; text?: string; x: number; y: number };
  iconUrl: string;
}
let activeOrbTargets: OrbClickTarget[] = [];

/**
 * Resolve a wiki URL for a POI, mirroring telescope's tooltip_generator.js logic.
 * Returns null if no sensible wiki page can be determined.
 */
function getWikiUrl(poi: any): string | null {
  const type = poi.type || "";
  let name = poi.name || poi.item || type;
  let wikiName = name;

  // Boss type mappings
  const BOSS_WIKI: Record<string, string> = {
    alchemist_boss: "Ylialkemisti",
    pyramid_boss: "Kolmisilm\u00e4n_koipi",
    triangle_boss: "Gate_Guardian",
    dragon: "Suomuhauki",
    boss_wizard: "Mestarien_mestari",
    boss_ghost: "Unohdettu",
    boss_sky: "Kivi",
    islandspirit: "Tapion_vasalli",
    boss_centipede: "Kolmisilm\u00e4",
    boss_robot: "Kolmisilm\u00e4n_koipi",
    boss_meat: "Kolmisilm\u00e4n_syd\u00e4n",
    boss_pit: "Sauvojen_tuntija",
    tiny: "Limatoukka",
    friend: "Toveri",
  };
  if (BOSS_WIKI[type]) wikiName = BOSS_WIKI[type];

  // Spell
  if (type === "spell" || (type === "item" && poi.item === "spell")) {
    const spellId = poi.spell || poi.item || "";
    return `https://noita.wiki.gg/wiki/${spellId}`;
  }

  // Wand
  if (type === "wand") {
    const n = (name || "").toLowerCase();
    if (n.includes("ruusu")) wikiName = "Ruusu";
    else if (n.includes("kiekurakeppi")) wikiName = "Kiekurakeppi";
    else if (n.includes("valtikka")) wikiName = "Valtikka";
    else if (n.includes("vasta")) wikiName = "Vasta";
    else if (n.includes("vihta")) wikiName = "Vihta";
    else if (n.includes("arpaluu")) wikiName = "Arpaluu";
    else if (n.includes("varpuluuta")) wikiName = "Varpuluuta";
    else if (n.includes("taikasauva")) wikiName = "Taikasauva";
    else wikiName = "Wands";
  }

  // Shops
  if (type === "holy_mountain_shop" || type === "shop") wikiName = "Holy_Mountain";

  // Containers
  if (type === "chest") wikiName = "Treasure_Chest";
  if (type === "great_chest") wikiName = "Treasure_Chest";
  if (type === "eye_room") wikiName = "Eye_Room";

  // Item types
  if (type === "item") {
    const item = poi.item || "";
    if (item === "orb") wikiName = "Orb_of_True_Knowledge";
    else if (item === "heart" || item === "heart_bigger" || item === "full_heal") wikiName = "Health";
    else if (item === "gold" || item === "goldnugget") wikiName = "Gold";
    else if (item.includes("potion")) wikiName = "Potions";
    else if (item.includes("pouch") || item === "powder_stash") wikiName = "Powder_Pouch";
    else if (item === "emerald_tablet") wikiName = "Emerald_Tablet";
    else if (item.includes("egg")) wikiName = "Egg";
    else if (item === "meditation_cube") wikiName = "Meditation_Chamber";
    else wikiName = item;
  }

  // Entity / creature
  if (type === "entity" && poi.entity) {
    const rawEntity = String(poi.entity).split("/").pop()?.replace(".xml", "") || name;
    // Prefer the wikipage from CREATURE_DATA if we have it — many entities
    // (traps, nests, boss orbs, crystals) have entity names that don't
    // correspond to a real wiki page (e.g. "arrowtrap_left" → /wiki/Traps).
    const creature = CREATURE_DATA[rawEntity.toLowerCase()];
    wikiName = creature?.wikipage || rawEntity;
  }

  return `https://noita.wiki.gg/wiki/${wikiName.replace(/\s+/g, "_")}`;
}

/** Wrap an element in an anchor tag pointing to the wiki, with underline and external link icon. */
function wrapWithWikiLink(el: HTMLElement, poi: any): HTMLElement {
  const url = getWikiUrl(poi);
  if (!url) return el;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.style.cssText = "text-decoration:underline;text-decoration-color:rgba(255,255,255,0.3);color:inherit;display:inline-flex;align-items:center;gap:0.3em";
  a.onmouseenter = () => { a.style.textDecorationColor = "rgba(255,255,255,0.7)"; };
  a.onmouseleave = () => { a.style.textDecorationColor = "rgba(255,255,255,0.3)"; };
  a.appendChild(el);
  const icon = document.createElement("i");
  icon.className = "bi bi-box-arrow-up-right";
  icon.style.cssText = "font-size:0.75em;opacity:0.5;flex-shrink:0";
  a.appendChild(icon);
  return a;
}

/**
 * Pick a viewport-pixel position for the marker tooltip card such that:
 *  - the card never extends into a right-side overlay (the seed-report
 *    sidebar, when open) — its right edge is clamped against the visible
 *    canvas (canvas right minus sidebar width).
 *  - the card prefers the LEFT side of the marker when a sidebar is open,
 *    so the card lives on the opposite side of the screen from the sidebar.
 *  - if neither side fits, the card pins to whichever edge gives more room.
 *
 * Used by both the direct canvas-click handler and the seed-report
 * row-click flow, so click-anywhere POI cards stay clear of the sidebar.
 */
function placeTooltipForMarker(
  viewer: any,
  _item: MarkerItem,
  clickX: number,
  clickY: number,
): { x: number; y: number } {
  const canvasEl = viewer.canvas as HTMLElement;
  const canvasRect = canvasEl.getBoundingClientRect();
  const TOOLTIP_W = 32 * 14; // width: 32em at 14px base
  // Breathing room between the POI marker and the tooltip card. The old 16px
  // hugged the POI sprite tightly — bump to ~5vh (clamped) so the card sits
  // clearly away from the marker on any screen size.
  const TOOLTIP_GAP = Math.max(32, Math.round(window.innerHeight * 0.05));

  let sidebarPx = 0;
  const srEl = document.getElementById("seed-report-sidebar");
  if (srEl && srEl.classList.contains("open")) {
    sidebarPx = srEl.getBoundingClientRect().width;
  }

  // Right-most pixel the card may occupy.
  const rightEdge = canvasRect.right - sidebarPx - TOOLTIP_GAP;
  const leftEdge = canvasRect.left + 8;

  // When the sidebar is open, prefer LEFT placement (card on opposite side
  // from the sidebar). Otherwise default to right of the click.
  let x: number;
  if (sidebarPx > 0) {
    const leftAttempt = clickX - TOOLTIP_GAP - TOOLTIP_W;
    if (leftAttempt >= leftEdge) {
      x = leftAttempt;
    } else {
      // Not enough room on the left — try right, then pin to whichever edge fits.
      const rightAttempt = clickX + TOOLTIP_GAP;
      if (rightAttempt + TOOLTIP_W <= rightEdge) {
        x = rightAttempt;
      } else {
        x = leftEdge;
      }
    }
  } else {
    const rightAttempt = clickX + TOOLTIP_GAP;
    if (rightAttempt + TOOLTIP_W <= rightEdge) {
      x = rightAttempt;
    } else {
      const leftAttempt = clickX - TOOLTIP_GAP - TOOLTIP_W;
      x = leftAttempt >= leftEdge ? leftAttempt : leftEdge;
    }
  }

  let y = Math.min(clickY, canvasRect.top + canvasRect.height * 0.35);
  if (y < canvasRect.top + 8) y = canvasRect.top + 8;
  return { x, y };
}

function cleanupPopovers(el: HTMLElement): void {
  dismissPopovers(el);
}

function showMarkerTooltip(item: MarkerItem, screenX: number, screenY: number): void {
  // Remove previous popup
  if (tooltipEl) {
    cleanupPopovers(tooltipEl);
    tooltipEl.remove();
    tooltipEl = null;
  }

  tooltipEl = document.createElement("div");
  // Allow the languageChanged listener to rebuild this tooltip in place.
  (tooltipEl as any).__rebuild = () => showMarkerTooltip(item, screenX, screenY);
  tooltipEl.className = "marker-tooltip";
  tooltipEl.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: #1a1f2a;
    color: #e0e0e0;
    border: 0.15em solid #3a3a5c;
    border-radius: 0.5em;
    padding: 0.75em 1em;
    font-size: 14px;
    box-sizing: border-box;
    width: 32em;
    max-width: min(56em, 95vw);
    pointer-events: auto;
    box-shadow: 0 0.4em 1.4em rgba(0,0,0,0.7);
    font-family: monospace;
    line-height: 1.5;
  `;

  // Top controls container — in normal flow, pushed to right
  const topBar = document.createElement("div");
  topBar.style.cssText = `
    display: flex; gap: 0.4em; align-items: center; justify-content: flex-end;
    margin: -0.15em -0.4em 0.3em 0;
    flex-shrink: 0;
  `;

  const shareBtn = document.createElement("button");
  shareBtn.style.cssText = `
    background: rgba(255,255,255,0.1); border: 0.065em solid rgba(255,255,255,0.2);
    border-radius: 0.25em; color: #ccc; cursor: pointer; padding: 0.15em 0.5em;
    display: flex; align-items: center; justify-content: center; font-size: 0.85em;
    transition: all 0.2s;
  `;
  shareBtn.innerHTML = '<i class="bi bi-share"></i>';
  shareBtn.title = i18next.t("share.copyLink", { defaultValue: "Copy direct link" });
  shareBtn.onmouseenter = () => { shareBtn.style.background = "rgba(255,255,255,0.2)"; };
  shareBtn.onmouseleave = () => { shareBtn.style.background = "rgba(255,255,255,0.1)"; };

  // ── Unlocks lock/unlock toggle ───────────────────────────────────────
  // Only show on POI types whose contents are affected by spell unlocks.
  const UNLOCK_AFFECTED_TYPES = new Set([
    "wand", "spell", "holy_mountain_shop", "shop", "wand_altar",
    "chest", "great_chest", "pacifist_chest", "laboratory", "snowy_room",
    "starting_loadout",
  ]);
  const _poiType = item.poi.type;
  const _isSpellItem = _poiType === "item" && (item.poi as any).item === "spell";
  const showLockBtn = UNLOCK_AFFECTED_TYPES.has(_poiType) || _isSpellItem;

  let lockBtn: HTMLElement | null = null;
  if (showLockBtn) {
    // Three-button group: [None] [Mod] [All]. Each button switches directly
    // to its descriptor. The Mod button is disabled when no in-game unlock
    // data is available (i.e. the user hasn't opened the map via the
    // Noitamap mod yet, or never has).
    lockBtn = document.createElement("div");
    lockBtn.className = "btn-group btn-group-sm";
    lockBtn.setAttribute("role", "group");
    lockBtn.style.cssText = "font-size: 0.85em;";

    const modSourcedAtBuild = isModSourced();
    const hasCachedModData = (() => {
      try { return !!localStorage.getItem("noitamap-unlocks"); } catch { return false; }
    })();
    const modAvailable = modSourcedAtBuild || hasCachedModData;

    // ── Helper: native Bootstrap hover popover with small show/hide delays
    //    so the cursor can transit between the trigger and the popover panel
    //    without flicker.
    const attachHoverPopover = (el: HTMLElement, getTitle: () => string, getBody: () => string) => {
      const bs = (window as any).bootstrap;
      if (!bs?.Popover) return;
      el.setAttribute("data-bs-placement", "bottom");
      el.setAttribute("data-bs-title", getTitle());
      el.setAttribute("data-bs-content", getBody());
      const inst = new bs.Popover(el, {
        trigger: "hover",
        placement: "bottom",
        delay: { show: 80, hide: 120 },
        container: "body",
      });
      (el as any).__refreshPopover = () => {
        try {
          inst._config.title = getTitle();
          inst._config.content = getBody();
          el.setAttribute("data-bs-title", getTitle());
          el.setAttribute("data-bs-content", getBody());
        } catch { /* noop */ }
      };
      (el as any).__disposePopover = () => { try { inst.dispose(); } catch { /* noop */ } };
    };

    const tk = (k: string, fallback: string) => i18next.t(k, { defaultValue: fallback });

    type DescBtn = { desc: UnlockDescriptor; icon: string; title: () => string; body: () => string };
    const buttons: DescBtn[] = [
      {
        desc: "mod",
        icon: "bi-controller",
        title: () => modAvailable
          ? tk("unlocks.btn.title.mod", "Your current unlocks")
          : tk("unlocks.btn.title.modDisabled", "Open the map from the Noitamap mod"),
        body: () => tk(
          "unlocks.btn.body.mod",
          "Switch to your current in-game unlocks while using Noitamap Mod. Unavailable when not using the mod.",
        ),
      },
      {
        desc: "none",
        icon: "bi-lock-fill",
        title: () => tk("unlocks.btn.title.none", "Nothing unlocked"),
        body: () => getActiveDescriptor() === "none"
          ? tk("unlocks.btn.body.none_active", "Currently showing nothing unlocked.")
          : tk("unlocks.btn.body.none", "Switch to showing wand/spell pools as if you had unlocked nothing."),
      },
      {
        desc: "all",
        icon: "bi-unlock-fill",
        title: () => tk("unlocks.btn.title.all", "Everything unlocked"),
        body: () => getActiveDescriptor() === "all"
          ? tk("unlocks.btn.body.all_active", "Currently showing everything unlocked. This matches Telescope's default — same content everyone sees regardless of progress.")
          : tk("unlocks.btn.body.all", "Switch to showing wand/spell pools as if you had unlocked everything. Telescope's default."),
      },
    ];

    const btnEls: Record<string, HTMLButtonElement> = {};
    // Daily seeds are always all-unlocked, so the toggle is locked to "all":
    // disable every other variant button (mod/none) and leave "all" active.
    const isDailySeed = getCurrentIsDaily();
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm btn-outline-secondary";
      btn.innerHTML = `<i class="bi ${b.icon}"></i>`;
      btn.style.cssText = "padding: 0.15em 0.55em; display: inline-flex; align-items: center; justify-content: center; line-height: 1;";
      const modDisabled = b.desc === "mod" && !modAvailable;
      // Daily: lock everything but "all" — dailies are always all-unlocked.
      const dailyLocked = isDailySeed && b.desc !== "all";
      if (dailyLocked || modDisabled) btn.disabled = true;
      const popTitle = dailyLocked ? () => tk("unlocks.btn.title.dailyDisabled", "Daily seed") : b.title;
      const popBody = dailyLocked ? () => tk("unlocks.btn.body.dailyDisabled", "Daily seed always has everything unlocked.") : b.body;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        if (getActiveDescriptor() === b.desc) return;
        // URL first: refreshActiveVariant (fired by setActiveDescriptor) reads
        // ?u= via getUnlocksFromURL() to decide what unlock list to feed the
        // alt-layer rebuild. The URL has to reflect the new descriptor before
        // those listeners run, otherwise switching back to "mod" would feed
        // the stale "none"/"all" URL value into chest/orb overlay updates.
        const { updateURLWithUnlocks } = await import("../data_sources/url");
        updateURLWithUnlocks(b.desc);
        setActiveDescriptor(b.desc);
        if (!isVariantReady(b.desc)) {
          applyLockBtnStyle();
          try { await requestVariant(b.desc); } catch { /* surfaced inline */ }
        }
        const rebuild = (tooltipEl as any)?.__rebuild;
        if (typeof rebuild === "function") rebuild();
      });
      btnEls[b.desc] = btn;
      if (dailyLocked) {
        // A real `disabled` button fires no mouse events, so per the Bootstrap
        // docs the popover must be triggered from a focusable wrapper span.
        const wrap = document.createElement("span");
        wrap.className = "d-inline-block";
        wrap.tabIndex = 0;
        wrap.appendChild(btn);
        attachHoverPopover(wrap, popTitle, popBody);
        lockBtn.appendChild(wrap);
      } else {
        attachHoverPopover(btn, popTitle, popBody);
        lockBtn.appendChild(btn);
      }
    }

    const applyLockBtnStyle = () => {
      const active = getActiveDescriptor();
      for (const b of buttons) {
        const btn = btnEls[b.desc];
        if (!btn) continue;
        const ready = isVariantReady(b.desc);
        const isActive = active === b.desc;
        btn.classList.toggle("active", isActive);
        // Visual states:
        //   active        → solid primary
        //   inactive      → outline-secondary
        //   mod-disabled  → outline-secondary, muted
        if (isActive) {
          btn.classList.remove("btn-outline-secondary");
          if (!btn.classList.contains("btn-primary")) btn.classList.add("btn-primary");
        } else {
          btn.classList.remove("btn-primary");
          if (!btn.classList.contains("btn-outline-secondary")) btn.classList.add("btn-outline-secondary");
        }
        btn.style.opacity = ready || isActive ? "1" : "0.55";
        (btn as any).__refreshPopover?.();
      }
    };
    applyLockBtnStyle();

    // Refresh on alt-ready so loading state clears in place.
    if (!isVariantReady(getActiveDescriptor())) {
      onAltReady(() => {
        if (!tooltipEl) return;
        applyLockBtnStyle();
      });
    }
  }
  
  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = `
    background: transparent; border: none; padding: 0.15em 0.4em;
    cursor: pointer; color: #888; font-size: 1.25em; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    transition: color 0.2s;
  `;
  closeBtn.textContent = "×";
  closeBtn.onmouseenter = () => { closeBtn.style.color = "#fff"; };
  closeBtn.onmouseleave = () => { closeBtn.style.color = "#888"; };

  closeBtn.onclick = (e) => {
    e.stopPropagation();
    hideMarkerTooltip();
  };
  
  if (lockBtn) topBar.appendChild(lockBtn);
  topBar.appendChild(shareBtn);
  topBar.appendChild(closeBtn);
  tooltipEl.appendChild(topBar);

  // Resolve the effective POI for rendering: when the user has cycled the
  // unlocks toggle to a non-primary descriptor AND that variant is
  // pre-warmed, swap to the alt POI (same id — biome layout is identical
  // between variants, only wand/chest/loose-loot spell rolls differ).
  // Falls back to the primary when alt isn't ready or no alt exists for
  // this id.
  const _activeDesc = getActiveDescriptor();
  const _altPoi = _activeDesc !== primaryDescriptor()
    ? getPoiVariant(_activeDesc, (item.poi as any)?.id)
    : null;
  const poi = _altPoi || item.poi;
  
  // Instantly update the URL to point to this popup
  const url = new URL(window.location.href);
  url.searchParams.set("poi", (poi as any).id);
  window.history.replaceState({}, "", url.toString());

  shareBtn.onclick = (e) => {
    e.stopPropagation();
    const finalUrl = (window as any).getShareUrl((poi as any).id);
    navigator.clipboard.writeText(finalUrl);
    shareBtn.innerHTML = '<i class="bi bi-check2 text-success"></i>';
    setTimeout(() => { shareBtn.innerHTML = '<i class="bi bi-share"></i>'; }, 2000);
  };

  // ─── Spoiler-free mode: generic popup with no details ──────────────────
  if (isSpoilerFree()) {
    const rootKey = Array.isArray(item.spriteKey) ? item.spriteKey[0] : item.spriteKey;
    const category = getSpoilerCategory(rootKey);
    const label = getSpoilerLabel(category);
    const colorMap = { wand: "#c8a2ff", spell: "#66ccff", something: "#ffd700" };

    const title = document.createElement("div");
    title.style.cssText = `font-weight:bold;color:${colorMap[category]};font-size:1.1em;margin-bottom:0.3em`;
    title.textContent = label;
    tooltipEl.appendChild(title);

    // Footer with position only
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:0.5em;color:#666;font-size:0.85em;border-top:0.065em solid #333;padding-top:0.3em";
    footer.textContent = `PW ${item.pw} (${Math.round(item.poi.x)}, ${Math.round(item.poi.y)})`;
    tooltipEl.appendChild(footer);

    document.body.appendChild(tooltipEl);
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let tx = screenX + pad;
    let ty = screenY + pad;
    requestAnimationFrame(() => {
      if (!tooltipEl) return;
      const rect = tooltipEl.getBoundingClientRect();
      if (tx + rect.width > vw - pad) tx = screenX - rect.width - pad;
      if (ty + rect.height > vh - pad) ty = screenY - rect.height - pad;
      tx = Math.max(pad, Math.min(tx, vw - rect.width - pad));
      ty = Math.max(pad, Math.min(ty, vh - rect.height - pad));
      tooltipEl.style.left = `${tx}px`;
      tooltipEl.style.top = `${ty}px`;
    });
    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;
    return;
  }

  if (poi.type === "wand") {
    const isTaikasauva = (poi as any).isTaikasauva === true;
    // Header with sprite
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:0.6em;margin-bottom:0.5em";
    const spriteImg = document.createElement("img");
    if (isTaikasauva) {
      // "Alive" wand: show the wand_ghost bestiary sprite (no rotation —
      // bestiary icon is already in its natural facing).
      spriteImg.style.cssText = "width:2.4em;height:2.4em;image-rendering:pixelated;object-fit:contain";
      getTaikasauvaIcon().then((url) => {
        if (url) spriteImg.src = url;
      });
    } else {
      // Use getRotatedWandSprite (data.zip + CCW90) so wands without baked
      // wand:<filename> atlas keys (e.g. bomb_wand) still render correctly.
      // CSS rotate(90deg) on top of CCW-90 = native (tip-right).
      spriteImg.style.cssText =
        "width:2.4em;height:2.4em;image-rendering:pixelated;object-fit:contain;transform:rotate(90deg)";
      if (poi.sprite) {
        const parts = String(poi.sprite).split("/");
        const filename = parts[parts.length - 1].replace(/\.png$/, "");
        getRotatedWandSprite(filename).then((res) => {
          if (res) spriteImg.src = res.url;
          else getPOISpriteFirstFrame({ type: "wand", sprite: poi.sprite }).then((url) => {
            if (url) spriteImg.src = url;
          });
        });
      } else {
        getPOISpriteFirstFrame({ type: "wand", sprite: poi.sprite }).then((url) => {
          if (url) spriteImg.src = url;
        });
      }
    }
    header.appendChild(spriteImg);
    const titleCol = document.createElement("div");
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#e0e0e0;font-size:1.1em";
    if (isTaikasauva) {
      // Pull from animal_wand_ghost (baked into translation.json from common.csv)
      const tk = gameTranslator.translateItem("animal_wand_ghost");
      const baseName = tk !== "animal_wand_ghost" ? tk : "Taikasauva";
      // Adjective got assigned by the adapter override (GUN_NAMES). Format
      // as "Taikasauva <Adj> wand" — and don't double "wand" if the
      // adjective name already ends with "wand".
      const adj = poi.name && poi.name !== "Taikasauva" ? poi.name : "";
      if (adj) {
        title.textContent = /\bwand\b\s*$/i.test(adj) ? `${baseName} ${adj}` : `${baseName} ${adj} wand`;
      } else {
        title.textContent = baseName;
      }
    } else {
      title.textContent = poi.name || gameTranslator.translateItem("Wand");
    }
    titleCol.appendChild(wrapWithWikiLink(title, poi));
    if (isTaikasauva) {
      const sub = document.createElement("div");
      sub.style.cssText = "color:#aaa;font-size:0.85em;font-style:italic";
      sub.textContent = '"Alive wand"';
      titleCol.appendChild(sub);
    }
    header.appendChild(titleCol);
    tooltipEl.appendChild(header);

    // Wand stats — telescope POIs put stats as top-level snake_case fields,
    // but some paths may wrap them in a stats sub-object. Check both.
    const s = poi.stats || poi;
    const statsDiv = document.createElement("div");
    statsDiv.style.cssText =
      "display:grid;grid-template-columns:auto auto;gap:0.1em 0.85em;font-size:0.85em;margin-bottom:0.5em;color:#bbb";
    const addStat = (label: string, value: string) => {
      const l = document.createElement("span");
      l.style.color = "#888";
      l.textContent = label;
      const v = document.createElement("span");
      v.textContent = value;
      statsDiv.appendChild(l);
      statsDiv.appendChild(v);
    };
    const shuffle = s.shuffle ?? s.deck_shuffle;
    if (shuffle != null) addStat(`${i18next.t("wand.shuffle", "Shuffle")}:`, shuffle ? i18next.t("common.yes", "Yes") : i18next.t("common.no", "No"));
    const spc = s.spellsPerCast ?? s.spells_per_cast ?? s.actions_per_round;
    if (spc != null) addStat(`${i18next.t("wand.spellsPerCast", "Spells/Cast")}:`, String(Math.floor(Number(spc))));
    const cd = s.castDelay ?? s.cast_delay ?? s.fire_rate_wait;
    if (cd != null) addStat(`${i18next.t("wand.castDelay", "Cast Delay")}:`, String(Math.floor(Number(cd))));
    const rt = s.rechargeTime ?? s.recharge_time ?? s.reload_time;
    if (rt != null) addStat(`${i18next.t("wand.recharge", "Recharge")}:`, String(Math.floor(Number(rt))));
    const mm = s.manaMax ?? s.mana_max;
    if (mm != null) addStat(`${i18next.t("wand.mana", "Mana")}:`, String(Math.floor(Number(mm))));
    const mc = s.manaChargeSpeed ?? s.mana_charge_speed;
    if (mc != null) addStat(`${i18next.t("wand.regen", "Regen")}:`, String(Math.floor(Number(mc))));
    const cap = s.capacity ?? s.deck_capacity;
    if (cap != null) addStat(`${i18next.t("wand.capacity", "Capacity")}:`, String(Math.floor(Number(cap))));
    const spread = s.spread ?? s.spread_degrees;
    if (spread != null) addStat(`${i18next.t("wand.spread", "Spread")}:`, `${Math.floor(Number(spread))} ${i18next.t("wand.degAbbrev", "deg")}`);
    if (statsDiv.childNodes.length > 0) tooltipEl.appendChild(statsDiv);

    // Spell icons (always casts + regular) — show full wand capacity
    const alwaysCasts = poi.always_casts || poi.alwaysCasts || [];
    const cards = poi.cards || poi.spells || [];
    const allSpells = [...alwaysCasts, ...cards];
    const acCount = alwaysCasts.length;
    const deckCapacity = cap ?? allSpells.length;
    // Build display slots: always-casts first, then cards padded to deck capacity
    const displaySlots: Array<{ id: string | null; isAC: boolean }> = [];
    for (let i = 0; i < acCount; i++) {
      const sp = alwaysCasts[i];
      displaySlots.push({ id: sp ? (typeof sp === "string" ? sp : (sp.id ?? sp)) : null, isAC: true });
    }
    for (let i = 0; i < deckCapacity; i++) {
      const sp = cards[i];
      displaySlots.push({ id: sp ? (typeof sp === "string" ? sp : (sp.id ?? sp)) : null, isAC: false });
    }
    if (displaySlots.length > 0) {
      const spellsRow = document.createElement("div");
      spellsRow.style.cssText = "display:flex;flex-wrap:wrap;gap:0.2em;margin-top:0.3em";
      for (const slot of displaySlots) {
        const container = document.createElement("div");
        container.style.cssText = `position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:#111;border-radius:0.2em;border:0.065em solid ${slot.isAC ? "#c8a2ff" : "#333"}`;
        if (slot.id) {
          container.title = gameTranslator.translateSpell(getSpellName(slot.id));
        }
        if (slot.isAC) {
          const badge = document.createElement("div");
          badge.textContent = "AC";
          badge.style.cssText =
            "position:absolute;top:-5px;left:-5px;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:bold;background:white;color:black;border-radius:50%;border:1px solid #333;z-index:2";
          attachAlwaysCastPopover(badge);
          container.appendChild(badge);
        }
        if (slot.id) {
          const img = document.createElement("img");
          img.style.cssText = "width:32px;height:32px;image-rendering:pixelated;display:block;margin:auto";
          getPOISpriteFirstFrame({ type: "spell", item: String(slot.id) }).then((url) => {
            if (url) {
              img.src = url;
            } else {
              img.src = `./assets/icons/spells/${String(slot.id).toLowerCase()}.png`;
              img.onerror = () => {
                img.style.display = "none";
              };
            }
          });
          container.appendChild(img);
        }
        // Empty slot: container is already styled as a 22x22 dark square
        spellsRow.appendChild(container);
      }
      tooltipEl.appendChild(spellsRow);
    }
  } else if (
    poi.type === "item" ||
    poi.type === "chest" ||
    poi.type === "pacifist_chest" ||
    poi.type === "great_chest"
  ) {
    // Header with sprite
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:0.5em;margin-bottom:0.3em";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText = "width:28px;height:28px;image-rendering:pixelated;object-fit:contain";
    getPOISpriteFirstFrame(poi as any).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);

    const label = poi.item ?? poi.type;
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#e0e0e0;font-size:1.1em";
    // Show HP info for heart items, spell names for spells
    if (poi.item === "spell" && (poi as any).spell) {
      title.textContent = gameTranslator.translateSpell(getSpellName(String((poi as any).spell)));
    } else if (poi.item === "heart") title.textContent = i18next.t("poi.heartSmall", "Heart (+25 HP)");
    else if (poi.item === "heart_bigger") title.textContent = i18next.t("poi.heartBig", "Heart (+50 HP)");
    else if (poi.item === "full_heal") title.textContent = i18next.t("poi.fullHeal", "Full Heal");
    else title.textContent = gameTranslator.translateItem(label).replace(/_/g, " ");
    header.appendChild(wrapWithWikiLink(title, poi));
    tooltipEl.appendChild(header);

    if (poi.material) {
      const mat = document.createElement("div");
      mat.style.cssText = "color:#aaa;font-size:0.85em";
      const materialLabel = gameTranslator.translateItem("inventory_actiontype_material");
      mat.textContent = `${materialLabel}: ${gameTranslator.translateMaterial(poi.material)}`;
      tooltipEl.appendChild(mat);
      tooltipEl.appendChild(buildExtendedSection("material", String(poi.material)));
    }
    if (poi.amount) {
      const amt = document.createElement("div");
      amt.style.cssText = "color:#aaa;font-size:0.85em";
      amt.textContent = `${i18next.t("poi.amount", "Amount")}: ${poi.amount}`;
      tooltipEl.appendChild(amt);
    }
    if (poi.contents && poi.contents.length) {
      const contentsDiv = document.createElement("div");
      contentsDiv.style.cssText = "margin-top:0.15em;color:#aaa;font-size:0.85em";
      contentsDiv.textContent = `${i18next.t("poi.contains", "Contains")}: ${poi.contents
        .map((c: any) => {
          const cName = typeof c === "string" ? c : (c.name ?? c.item ?? String(c));
          return gameTranslator.translateItem(cName);
        })
        .join(", ")}`;
      tooltipEl.appendChild(contentsDiv);
    }
  } else if (poi.type === "spell") {
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:0.5em;margin-bottom:0.3em";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText = "width:28px;height:28px;image-rendering:pixelated;display:block";
    getPOISpriteFirstFrame({ type: "spell", item: poi.item }).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#e0e0e0;font-size:1.1em";
    title.textContent = gameTranslator.translateSpell(getSpellName(poi.item || "")) || "Spell";
    header.appendChild(wrapWithWikiLink(title, poi));
    tooltipEl.appendChild(header);
    if (poi.item) {
      tooltipEl.appendChild(buildExtendedSection("spell", String(poi.item)));
    }
  } else if ((poi.type === "entity" && (poi as any).entity) || ["alchemist_boss", "boss_wizard", "boss_meat", "islandspirit", "boss_sky", "boss_robot", "boss_centipede", "triangle_boss", "pyramid_boss", "dragon", "boss_ghost", "friend", "boss_pit", "tiny"].includes(poi.type || "")) {
    const isSpecialEntity = poi.type !== "entity";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:0.5em;margin-bottom:0.3em";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText = "width:38px;height:38px;image-rendering:pixelated;object-fit:contain";
    getPOISpriteFirstFrame(poi as any).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);
    const titleCol = document.createElement("div");
    const rawName = String((poi as any).entity || poi.type);
    let entityId = rawName.toLowerCase();
    
    // Map telescope boss types to actual CREATURE_DATA IDs
    const bossMap: Record<string, string> = {
      alchemist_boss: "boss_alchemist",
      pyramid_boss: "boss_limbs",
      dragon: "boss_dragon",
      triangle_boss: "boss_gate",
      boss_pit: "boss_pit",
      tiny: "maggot_tiny",
    };
    if (bossMap[entityId]) entityId = bossMap[entityId];

    const translationKey = `animal_${entityId}`;
    const translated = gameTranslator.translateItem(translationKey);
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#e0e0e0;font-size:1.1em";
    // Title: pulled straight from the locale JSONs via gameTranslator. The
    // animal_<id> entries are baked into src/locales/*/translation.json by
    // build_scripts/bake-creature-translations.cjs at build time. Falls back
    // to creature.name (Finnish) only when the JSON has no entry.
    const creature = CREATURE_DATA[entityId];
    const baseName =
      (translated !== translationKey ? translated : null) ||
      creature?.name ||
      rawName.replace(/_/g, " ");
    title.textContent = baseName;
    titleCol.appendChild(wrapWithWikiLink(title, poi));
    // Subtitle shows alternate names so players can cross-reference. Matches
    // the search-results UX: in non-English locales we surface the official
    // Finnish name; the English alias is always shown when it differs.
    if (creature) {
      const currentLang = i18next.language || "en";
      const parts: string[] = [];
      if (currentLang !== "en" && creature.name && creature.name !== baseName) {
        parts.push(`"${creature.name}"`);
      }
      if (creature.alias && creature.alias !== baseName) {
        parts.push(`"${creature.alias}"`);
      }
      if (parts.length > 0) {
        const aliasDiv = document.createElement("div");
        aliasDiv.style.cssText = "color:#999;font-size:0.85em;font-style:italic";
        aliasDiv.textContent = parts.join(", ");
        titleCol.appendChild(aliasDiv);
      }
    }

    header.appendChild(titleCol);
    tooltipEl.appendChild(header);

    // Horde marker (free) — full creature stats are in the pro extended section.
    if ((poi as any).isHorde && creature?.category) {
      const catDiv = document.createElement("div");
      catDiv.style.cssText = "color:#888;margin-top:0.15em;font-size:0.85em";
      catDiv.textContent = `${i18next.t("poi.horde", "Horde")}: ${creature.category}`;
      tooltipEl.appendChild(catDiv);
    }

    tooltipEl.appendChild(buildExtendedSection("creature", entityId));

    if (poi.biome) {
      const biomeDiv = document.createElement("div");
      biomeDiv.style.cssText = "color:#888;font-size:1em;margin-top:0.2em";
      const biomeKey = String(poi.biome).startsWith("biome_") ? String(poi.biome) : `biome_${poi.biome}`;
      const biomeLabel = i18next.t(`gameContent.biomes.${biomeKey}`, {
        defaultValue: gameTranslator.translateContent("biomes", String(poi.biome)),
      });
      biomeDiv.textContent = `${i18next.t("poi.biome", "Biome")}: ${biomeLabel}`;
      tooltipEl.appendChild(biomeDiv);
    }
  } else {
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;font-size:1.25em;margin-bottom:0.3em";
    const label = poi.type || "Unknown";
    title.textContent = gameTranslator.translateItem(label).replace(/_/g, " ");
    tooltipEl.appendChild(wrapWithWikiLink(title, poi));
    if (poi.item) {
      const itemDiv = document.createElement("div");
      itemDiv.style.cssText = "color:#aaa;font-size:1.1em";
      itemDiv.textContent = gameTranslator.translateItem(poi.item).replace(/_/g, " ");
      tooltipEl.appendChild(itemDiv);
    }
  }

  // Container contents — show items inside chests/shops/bosses
  if (CONTAINER_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
    const contDiv = document.createElement("div");
    contDiv.style.cssText = "margin-top:0.5em;border-top:0.065em solid #333;padding-top:0.3em";
    const contLabel = document.createElement("div");
    contLabel.style.cssText = "font-size:1em;color:#888;margin-bottom:0.2em";
    const isBossDrop = ["triangle_boss", "alchemist_boss", "pyramid_boss", "dragon", "boss_wizard", "boss_ghost", "boss_sky", "islandspirit", "boss_centipede", "boss_robot", "boss_meat", "friend", "boss_pit", "tiny"].includes(poi.type || "");
    contLabel.textContent = isBossDrop ? "Drops:" : "Contains:";
    contDiv.appendChild(contLabel);
    const contRow = document.createElement("div");
    contRow.style.cssText = "display:flex;flex-wrap:wrap;gap:0.2em;align-items:center";
    // Render a content sprite at an integer multiple of its native size so
    // nearest-neighbour scaling stays perfectly sharp (sprites have varied
    // native sizes; spells are 16px, items/wands differ).
    const scaledSprite = (key: string | string[], mult = 2): HTMLCanvasElement | null => {
      const n = getSpriteNativeSize(key);
      if (!n) return null;
      const c = drawSpriteToCanvas(key, n.w, n.h);
      if (!c) return null;
      c.style.width = `${n.w * mult}px`;
      c.style.height = `${n.h * mult}px`;
      return c;
    };
    for (const ci of poi.items) {
      if (ci.ignore) continue;
      const ciKey = getSpriteKey(ci, getAtlas() || undefined);
      const ciName = ci.name || ci.item || ci.type || "";
      const translatedName =
        ci.item === "spell" && ci.spell
          ? gameTranslator.translateSpell(getSpellName(String(ci.spell)))
          : gameTranslator.translateItem(ciName);

      // Wands: show sprite (rotated) + spell icons (padded to wand capacity).
      // Everything rendered at 2x native for crisp, integer-scaled pixels —
      // matching the regular wand POI card.
      if (ci.type === "wand") {
        const wandBox = document.createElement("div");
        wandBox.style.cssText =
          "display:flex;align-items:center;gap:0.4em;flex:1 1 100%;min-width:0;background:#111;border-radius:0.2em;padding:0.15em 0.3em;border:0.065em solid #333";
        if (ciKey) {
          const n = getSpriteNativeSize(ciKey);
          // 3x so the (thin) wand reads at roughly spell-cell height and isn't
          // dwarfed by the 2x spell squares — still an integer (sharp) scale.
          const canvas = scaledSprite(ciKey, 3);
          if (canvas && n) {
            canvas.style.transform = "rotate(90deg)";
            canvas.title = ci.name || "Wand";
            // Rotated 90deg: the layout box must use the SWAPPED dimensions or
            // the wide visual overflows its tall box and clips.
            const wrap = document.createElement("div");
            wrap.style.cssText = `flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:${n.h * 3}px;height:${n.w * 3}px`;
            wrap.appendChild(canvas);
            wandBox.appendChild(wrap);
          }
        }
        // Pad to deck_capacity so the row matches the wand's actual slot count.
        // Always casts first, then regular spells, then null placeholders up to capacity.
        const acList: any[] = ci.always_casts || [];
        const cardList: any[] = ci.cards || [];
        const capRaw = (ci as any).deck_capacity ?? (ci as any).capacity ?? null;
        const cap = capRaw != null ? Math.max(0, Math.floor(Number(capRaw))) : cardList.length;
        const slots: Array<{ id: string | null; isAC: boolean }> = [];
        for (const sp of acList) slots.push({ id: typeof sp === "string" ? sp : (sp?.id ?? sp ?? null), isAC: true });
        for (let i = 0; i < cap; i++) {
          const sp = cardList[i];
          slots.push({ id: sp ? (typeof sp === "string" ? sp : (sp?.id ?? sp)) : null, isAC: false });
        }
        const slotsGrid = document.createElement("div");
        slotsGrid.style.cssText = "display:flex;flex-wrap:wrap;gap:0.2em;align-items:center;flex:1 1 0;min-width:0";
        for (const slot of slots) {
          const cell = document.createElement("div");
          cell.style.cssText = `width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:#0a0a0a;border:0.065em solid ${slot.isAC ? "#c8a2ff" : "#222"};border-radius:0.15em;box-sizing:border-box`;
          if (slot.id) {
            const spellCanvas = scaledSprite(resolveSpellKey(String(slot.id)));
            if (spellCanvas) {
              spellCanvas.title = gameTranslator.translateSpell(getSpellName(String(slot.id)));
              cell.appendChild(spellCanvas);
            }
          }
          slotsGrid.appendChild(cell);
        }
        wandBox.appendChild(slotsGrid);

        contRow.appendChild(wandBox);
        continue;
      }

      // Gold: show sprite + amount
      if (ci.item === "gold" || ci.item === "goldnugget") {
        const goldBox = document.createElement("div");
        goldBox.style.cssText =
          "display:flex;align-items:center;gap:0.2em;background:#111;border-radius:0.15em;padding:0.065em 0.3em;border:0.065em solid #333";
        if (ciKey) {
          const canvas = scaledSprite(ciKey);
          if (canvas) goldBox.appendChild(canvas);
        }
        const label = document.createElement("span");
        label.style.cssText = "font-size:0.8em;color:#ffd700";
        label.textContent = ci.amount ? `$${ci.amount}` : i18next.t("poi.gold", "Gold");
        goldBox.appendChild(label);
        contRow.appendChild(goldBox);
        continue;
      }

      // Hearts: show sprite + HP label
      if (ci.item === "heart" || ci.item === "heart_bigger" || ci.item === "full_heal") {
        const heartBox = document.createElement("div");
        heartBox.style.cssText =
          "display:flex;align-items:center;gap:0.2em;background:#111;border-radius:0.15em;padding:0.065em 0.3em;border:0.065em solid #333";
        if (ciKey) {
          const canvas = scaledSprite(ciKey);
          if (canvas) heartBox.appendChild(canvas);
        }
        const label = document.createElement("span");
        label.style.cssText = "font-size:0.8em;color:#ff6b6b";
        // Honour an explicit name override (e.g. boss-specific "Full regen
        // (On first kill)") before falling back to the generic HP label.
        if (ci.name) label.textContent = ci.name;
        else if (ci.item === "heart") label.textContent = i18next.t("poi.heartShort", "+25 HP");
        else if (ci.item === "heart_bigger") label.textContent = i18next.t("poi.heartBiggerShort", "+50 HP");
        else label.textContent = i18next.t("poi.fullHeal", "Full Heal");
        heartBox.appendChild(label);
        contRow.appendChild(heartBox);
        continue;
      }

      // Default: sprite + text label (with material for flasks/potions)
      let displayName = translatedName;
      if (ci.material) {
        const matName = gameTranslator.translateMaterial(ci.material);
        displayName = `${translatedName}: ${matName}`;
      }
      if (ciKey) {
        const itemBox = document.createElement("div");
        itemBox.style.cssText =
          "display:flex;align-items:center;gap:0.2em;background:#111;border-radius:0.15em;padding:0.065em 0.3em;border:0.065em solid #333";
        const canvas = scaledSprite(ciKey);
        if (canvas) itemBox.appendChild(canvas);
        const textSpan = document.createElement("span");
        textSpan.style.cssText = "font-size:0.8em;color:#aaa";
        textSpan.textContent = displayName;
        itemBox.appendChild(textSpan);
        contRow.appendChild(itemBox);
        continue;
      }
      const span = document.createElement("span");
      span.style.cssText =
        "font-size:0.8em;color:#aaa;background:#111;border-radius:0.15em;padding:0.065em 0.3em;border:0.065em solid #333";
      span.textContent = displayName;
      contRow.appendChild(span);
    }
    contDiv.appendChild(contRow);
    tooltipEl.appendChild(contDiv);
  }

  // Footer: position info
  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:0.5em;color:#666;font-size:0.85em;border-top:0.065em solid #333;padding-top:0.3em";
  footer.textContent = `PW ${item.pw} (${Math.round(item.poi.x)}, ${Math.round(item.poi.y)})`;
  tooltipEl.appendChild(footer);

  document.body.appendChild(tooltipEl);

  // Position popup near click, clamped to viewport.
  const pad = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let tx = screenX + pad;
  let ty = screenY + pad;
  requestAnimationFrame(() => {
    if (!tooltipEl) return;
    const rect = tooltipEl.getBoundingClientRect();
    // Horizontal: try right of cursor, fall back to left, then clamp
    if (tx + rect.width > vw - pad) tx = screenX - rect.width - pad;
    if (tx < pad) tx = pad;
    // If still wider than viewport, pin to left edge
    if (rect.width > vw - 2 * pad) tx = pad;

    // Vertical: try below cursor, fall back to above, then clamp to top
    if (ty + rect.height > vh - pad) ty = screenY - rect.height - pad;
    if (ty < pad) ty = pad;

    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;
  });
  tooltipEl.style.left = `${tx}px`;
  tooltipEl.style.top = `${ty}px`;
}

function hideMarkerTooltip(): void {
  if (tooltipEl) {
    cleanupPopovers(tooltipEl);
    tooltipEl.remove();
    tooltipEl = null;
    clearTargetPoiId();
  }
}

let canvasMoveCleanup: (() => void) | null = null;
let globalMarkerData: MarkerData | null = null;

/**
 * Install a canvas-click handler on the viewer to detect marker clicks,
 * and a mousemove handler to show pointer cursor when hovering over markers.
 */
function installClickHandler(viewer: OSDViewer, data: MarkerData): void {
  globalMarkerData = data;
  
  // Remove previous handlers
  if (canvasClickHandler) {
    viewer.removeHandler("canvas-click", canvasClickHandler);
    canvasClickHandler = null;
  }
  if (canvasMoveCleanup) {
    canvasMoveCleanup();
    canvasMoveCleanup = null;
  }

  function findNearestMarker(event: any): MarkerItem | null {
    const viewportPoint = viewer.viewport.pointFromPixel(event.position);
    const vpX = viewportPoint.x;
    const vpY = viewportPoint.y;
    const localX = vpX - data.originX;
    const localY = vpY - data.originY;

    const searchRadius = 20;
    const results = data.index.search(
      localX - searchRadius,
      localY - searchRadius,
      localX + searchRadius,
      localY + searchRadius,
    );
    if (results.length === 0) return null;

    let bestIdx = results[0];
    let bestDist = Infinity;
    for (const idx of results) {
      const item = data.items[idx];
      const dx = item.osdX - vpX;
      const dy = item.osdY - vpY;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    return data.items[bestIdx] ?? null;
  }

  canvasClickHandler = (event: any) => {
    const item = findNearestMarker(event);
    if (item) {
      event.preventDefaultAction = true;
      const { x, y } = placeTooltipForMarker(viewer, item, event.originalEvent.clientX, event.originalEvent.clientY);
      showMarkerTooltip(item, x, y);
      return;
    }

    // Check orb overlays
    if (activeOrbTargets.length > 0) {
      const viewportPoint = viewer.viewport.pointFromPixel(event.position);
      const vpX = viewportPoint.x;
      const vpY = viewportPoint.y;
      let bestOrb: OrbClickTarget | null = null;
      let bestDist = Infinity;
      for (const ot of activeOrbTargets) {
        const dx = ot.osdX - vpX;
        const dy = ot.osdY - vpY;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestOrb = ot;
        }
      }
      // Only match if within ~15 world units (orb icons are 20x25)
      if (bestOrb && bestDist < 15 * 15) {
        event.preventDefaultAction = true;
        showOrbTooltip(bestOrb.orb, bestOrb.iconUrl, event.originalEvent.clientX, event.originalEvent.clientY);
        return;
      }
    }

    hideMarkerTooltip();
  };

  // Native mousemove on OSD canvas for pointer cursor (OSD has no 'canvas-move' event)
  const osdCanvas = viewer.canvas as HTMLElement;
  const onMouseMove = (e: MouseEvent) => {
    const rect = osdCanvas.getBoundingClientRect();
    const pixelX = e.clientX - rect.left;
    const pixelY = e.clientY - rect.top;
    const pixelPoint = new (OpenSeadragon as any).Point(pixelX, pixelY);
    const viewportPoint = viewer.viewport.pointFromPixel(pixelPoint);

    const vpX = viewportPoint.x;
    const vpY = viewportPoint.y;
    const localX = vpX - data.originX;
    const localY = vpY - data.originY;

    const searchRadius = 20;
    const results = data.index.search(
      localX - searchRadius,
      localY - searchRadius,
      localX + searchRadius,
      localY + searchRadius,
    );
    osdCanvas.classList.toggle("poi-hover", results.length > 0);
  };
  osdCanvas.addEventListener("mousemove", onMouseMove);
  canvasMoveCleanup = () => osdCanvas.removeEventListener("mousemove", onMouseMove);

  viewer.addHandler("canvas-click", canvasClickHandler);
  viewer.addHandler("canvas-drag", hideMarkerTooltip);
}

export function openTooltipForPOI(
  poiId: string,
  viewer: any,
  opts?: { sidebarRightPx?: number; fallbackX?: number; fallbackY?: number; fallbackPoi?: any },
): void {
  if (!poiId || poiId === "undefined" || poiId === "null") return;

  // Close any tooltip card that was already open. Otherwise the previous POI's
  // card sits on screen for ~2 s during the cinematic pan before getting
  // replaced, which looks like the click did nothing.
  hideMarkerTooltip();

  // Find the exact marker item based on its reference or fallback ID
  let item = globalMarkerData
    ? globalMarkerData.items.find(i => {
        const primaryId = (i.poi as any).id;
        return primaryId === poiId;
      })
    : undefined;

  // If markerData hasn't indexed this POI yet (e.g. search fired before the
  // marker layer rebuilt for the current variant), synthesise an item from
  // the caller-supplied fallback so the tooltip still opens.
  if (!item && opts?.fallbackPoi) {
    const fp = opts.fallbackPoi;
    const atlas = getAtlas();
    const keyRaw = atlas ? getSpriteKey(fp, atlas) : null;
    const rootKey = Array.isArray(keyRaw) ? keyRaw[0] : (keyRaw ?? "");
    const entry = atlas && rootKey ? atlas[rootKey] : null;
    item = {
      poi: fp,
      pw: fp.pw ?? 0,
      spriteKey: keyRaw ?? "",
      osdX: fp.x,
      osdY: fp.y,
      w: entry?.w ?? 16,
      h: entry?.h ?? 16,
    };
  }

  // Decide where to pan to. Prefer the marker's exact position; otherwise use
  // the caller-supplied fallback world coords (so the cinematic pan still
  // fires even when markerData hasn't indexed this POI — e.g. perf-mode
  // hides creatures from the marker layer but the seed report still lists
  // them).
  const baseX = item ? item.osdX : opts?.fallbackX;
  const baseY = item ? item.osdY : opts?.fallbackY;
  if (baseX === undefined || baseY === undefined) return;
  const pt = new (OpenSeadragon as any).Point(baseX, baseY);

  // Sidebar awareness: callers (seed-report row clicks) can pass an explicit
  // width. For all other entry points (e.g. share-link auto-open via
  // `?poi=…&sr=1`), auto-detect the seed-report sidebar's current visible
  // width by querying the DOM. The element exists and is open whenever its
  // `.open` class is set; if not present or closed, width is 0.
  let sidebarPx = opts?.sidebarRightPx ?? 0;
  if (sidebarPx === 0) {
    const srEl = document.getElementById("seed-report-sidebar");
    if (srEl && srEl.classList.contains("open")) {
      sidebarPx = srEl.getBoundingClientRect().width;
    }
  }

  // Use the AppOSD wrapper's cinematic panToTarget when available — it draws
  // the SVG trail/arrow + pulse marker, matching the behaviour the search
  // results use. Falls back to viewport.panTo on plain OpenSeadragon viewers.
  const usePanToTarget = typeof viewer.panToTarget === "function";
  let panPromise: Promise<void> | null = null;
  if (usePanToTarget) {
    panPromise = viewer.panToTarget(pt.x, pt.y, { offsetXPx: sidebarPx / 2 });
  } else {
    // Plain OSD viewer: no offset support, just pan.
    let panTarget = pt;
    if (sidebarPx > 0) {
      const shift = viewer.viewport.deltaPointsFromPixels(
        new (OpenSeadragon as any).Point(sidebarPx / 2, 0),
        true,
      );
      panTarget = new (OpenSeadragon as any).Point(pt.x + shift.x, pt.y);
    }
    viewer.viewport.panTo(panTarget, true);
  }

  // No item -> no tooltip card, just the cinematic pan. Useful for seed-report
  // rows whose POI was excluded from the marker layer (perf-mode creatures,
  // etc.) but still has world coords.
  if (!item) return;

  // Show the tooltip AFTER the cinematic pan settles. Prefer awaiting the
  // pan Promise when panToTarget returns one; fall back to a fixed delay
  // for plain viewport.panTo.
  const showTooltipNow = () => {
    const pixel = viewer.viewport.pixelFromPoint(pt);
    const canvasRect = (viewer.canvas as HTMLElement).getBoundingClientRect();
    const isOffScreen = pixel.x < -100 || pixel.x > canvasRect.width + 100 ||
                        pixel.y < -100 || pixel.y > canvasRect.height + 100;

    const markerX = isOffScreen ? canvasRect.width / 2 : pixel.x;
    const markerY = isOffScreen ? canvasRect.height / 2 : pixel.y;
    const clickX = canvasRect.left + markerX;
    const clickY = canvasRect.top + markerY;

    // Delegate to the shared placement helper so direct map clicks and
    // seed-report row clicks behave identically — left-side when sidebar is
    // open, right-side otherwise.
    const { x: screenX, y: screenY } = placeTooltipForMarker(viewer, item, clickX, clickY);
    showMarkerTooltip(item, screenX, screenY);
  };

  if (panPromise && typeof panPromise.then === "function") {
    panPromise.then(showTooltipNow).catch(() => showTooltipNow());
  } else {
    setTimeout(showTooltipNow, 250);
  }
}

// ─── Boss Sprite Overlays ──────────────────────────────────────────────────

/** POI type → data.zip sprite XML path (resolved at runtime for frame size) */
const BOSS_SPRITE_XML_MAP: Record<string, string> = {
  boss_alchemist: "data/entities/animals/boss_alchemist/boss_alchemist_sprite.xml",
  pyramid_boss: "data/entities/animals/boss_limbs/body.xml",
  mestari_boss: "data/entities/animals/boss_wizard/wizard_body.xml",
  friend: "data/enemies_gfx/friend.xml",
};

interface BossSpriteInfo {
  pngPath: string;
  frameW: number;
  frameH: number;
}
const _bossSpriteInfoCache = new Map<string, BossSpriteInfo>();

async function resolveBossSpriteInfo(xmlPath: string): Promise<BossSpriteInfo | null> {
  if (_bossSpriteInfoCache.has(xmlPath)) return _bossSpriteInfoCache.get(xmlPath)!;
  const zip = await getDataZip();
  if (!zip) return null;
  const entry = zip.file(xmlPath);
  if (!entry) return null;
  const xml = await (entry as any).async("string");
  const pngPath = xml.match(/filename="([^"]+\.png)"/)?.[1];
  const frameW = parseInt(xml.match(/frame_width="(\d+)"/)?.[1] || "0");
  const frameH = parseInt(xml.match(/frame_height="(\d+)"/)?.[1] || "0");
  if (!pngPath || !frameW || !frameH) return null;
  const info = { pngPath, frameW, frameH };
  _bossSpriteInfoCache.set(xmlPath, info);
  return info;
}

const _bossBitmapCache = new Map<string, string>(); // cacheKey → blob URL

async function loadBossSprite(zipPath: string, frameW: number, frameH: number): Promise<string | null> {
  const cacheKey = `${zipPath}:${frameW}x${frameH}`;
  if (_bossBitmapCache.has(cacheKey)) return _bossBitmapCache.get(cacheKey)!;
  const { readImage } = await import("../data-archive");
  const bmp = await readImage(zipPath).catch(() => null);
  if (!bmp) return null;
  // Extract first frame only (top-left frameW x frameH region)
  const fw = Math.min(frameW, bmp.width);
  const fh = Math.min(frameH, bmp.height);
  const canvas = new OffscreenCanvas(fw, fh);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, fw, fh, 0, 0, fw, fh);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const url = URL.createObjectURL(blob);
  _bossBitmapCache.set(cacheKey, url);
  return url;
}

async function addBossOverlays(viewer: OSDViewer, result: GenerationResult, generationId: number): Promise<void> {
  const { poisByPW, worldCenter } = result;
  const allPois = Object.values(poisByPW).flat();
  const bossPois = allPois.filter((p) => BOSS_SPRITE_XML_MAP[p.type]);
  if (bossPois.length === 0) return;

  // Resolve sprite info from XMLs and pre-load PNGs
  const infoByType = new Map<string, BossSpriteInfo>();
  await Promise.all(
    [...new Set(bossPois.map((p) => p.type))].map(async (type) => {
      const info = await resolveBossSpriteInfo(BOSS_SPRITE_XML_MAP[type]);
      if (info) infoByType.set(type, info);
    }),
  );
  await Promise.all([...infoByType.values()].map((info) => loadBossSprite(info.pngPath, info.frameW, info.frameH)));
  if (currentGenerationId !== generationId) return;

  let addedCount = 0;
  for (const poi of bossPois) {
    const info = infoByType.get(poi.type);
    if (!info) continue;
    const cacheKey = `${info.pngPath}:${info.frameW}x${info.frameH}`;
    const url = _bossBitmapCache.get(cacheKey);
    if (!url) continue;

    const x = poi.x;
    const y = poi.y;

    const el = document.createElement("img");
    el.src = url;
    el.className = "dynamic-poi poi-boss";
    el.style.cssText = "image-rendering: pixelated; width: 100%; height: 100%;";

    viewer.addOverlay({
      element: el,
      location: new (OpenSeadragon as any).Rect(x - info.frameW / 2, y - info.frameH / 2, info.frameW, info.frameH),
    });
    dynamicOverlayElements.push(el);
    addedCount++;
  }
  console.log(`[OSD Bridge] Added ${addedCount} boss overlays`);
}

// ─── Orb Overlays ─────────────────────────────────────────────────────────

function showOrbTooltip(orb: { name?: string; text?: string; x: number; y: number }, iconUrl: string, screenX: number, screenY: number): void {
  if (tooltipEl) {
    cleanupPopovers(tooltipEl);
    tooltipEl.remove();
    tooltipEl = null;
  }

  tooltipEl = document.createElement("div");
  (tooltipEl as any).__rebuild = () => showOrbTooltip(orb, iconUrl, screenX, screenY);
  tooltipEl.className = "marker-tooltip";
  tooltipEl.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 0.15em solid #3a3a5c;
    border-radius: 0.6em;
    padding: 0.75em 1em;
    font-size: 14px;
    box-sizing: border-box;
    width: 32em;
    max-width: min(56em, 95vw);
    pointer-events: auto;
    box-shadow: 0 0.45em 1.5em rgba(0,0,0,0.7);
    font-family: monospace;
    line-height: 1.5;
  `;

  const closeBtn = document.createElement("div");
  closeBtn.style.cssText = `
    position: absolute; top: 0.3em; right: 0.6em;
    cursor: pointer; color: #666; font-size: 1.25em;
    line-height: 1;
  `;
  closeBtn.textContent = "x";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    hideMarkerTooltip();
  };
  tooltipEl.appendChild(closeBtn);

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:0.5em;margin-bottom:0.3em";
  const spriteImg = document.createElement("img");
  spriteImg.src = iconUrl;
  spriteImg.style.cssText = "width:28px;height:36px;image-rendering:pixelated;object-fit:contain";
  header.appendChild(spriteImg);
  const title = document.createElement("div");
  title.style.cssText = "font-weight:bold;color:#ffd700;font-size:1.1em";
  title.textContent = orb.name || "Orb";
  header.appendChild(title);
  tooltipEl.appendChild(header);

  if (orb.text) {
    const desc = document.createElement("div");
    desc.style.cssText = "color:#aaa;font-size:0.85em;font-style:italic;margin-top:0.15em";
    desc.textContent = orb.text;
    tooltipEl.appendChild(desc);
  }

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:0.5em;color:#666;font-size:0.85em;border-top:0.065em solid #333;padding-top:0.3em";
  footer.textContent = `(${Math.round(orb.x)}, ${Math.round(orb.y)})`;
  tooltipEl.appendChild(footer);

  document.body.appendChild(tooltipEl);

  const pad = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let tx = screenX + pad;
  let ty = screenY + pad;
  requestAnimationFrame(() => {
    if (!tooltipEl) return;
    const rect = tooltipEl.getBoundingClientRect();
    if (tx + rect.width > vw - pad) tx = screenX - rect.width - pad;
    if (ty + rect.height > vh - pad) ty = screenY - rect.height - pad;
    if (tx < pad) tx = pad;
    if (ty < pad) ty = pad;
    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;
  });
  tooltipEl.style.left = `${tx}px`;
  tooltipEl.style.top = `${ty}px`;
}

/**
 * Hardcoded orb data for the dynamic map.
 * Orb positions are fixed game locations (not seed-dependent).
 * Each entry has: name, x, y (world coords), icon path (relative to public/).
 */
import orbsData from "../data/orbs.json";

const _orbIconCache = new Map<string, string>(); // icon path → URL

async function loadOrbIconByPath(iconPath: string): Promise<string | null> {
  if (_orbIconCache.has(iconPath)) return _orbIconCache.get(iconPath)!;
  // Don't fetch — that goes through CSP `connect-src` (which is `'none'` in
  // production) and breaks orb rendering on FF/Debian. <img src> uses
  // `img-src` instead and is always allowed. The browser caches it.
  const url = `./${iconPath}`;
  _orbIconCache.set(iconPath, url);
  return url;
}

const ORB_OVERLAY_UNLOCK_KEYS = [
  "sea_lava", "crumbling_earth", "tentacle", "nuke", "necromancy",
  "bomb_holy", "spiral_shot", "cloud_thunder", "firework",
  "exploding_deer", "material_cement",
];

async function addOrbOverlays(
  viewer: OSDViewer,
  result: GenerationResult,
  generationId: number,
  unlocks: string[] | null,
  isDaily: boolean,
): Promise<void> {
  const { worldCenter } = result;

  // Filter orbs for the dynamic map
  const dynamicOrbs = orbsData.filter((orb: any) =>
    orb.maps && orb.maps.includes("dynamic-main-branch")
  );
  if (dynamicOrbs.length === 0) return;

  // Pre-load all spell orb icons
  await Promise.all(dynamicOrbs.map((orb: any) => loadOrbIconByPath(orb.icon)));
  if (currentGenerationId !== generationId) return;

  // Build unlock set for collected detection
  const unlockSet = (!isDaily && unlocks) ? new Set(unlocks) : null;

  // Pre-render the empty orb sprite from the atlas (item:orbs/orb)
  let emptyOrbUrl: string | null = null;
  if (unlockSet) {
    emptyOrbUrl = await getPOISpriteFirstFrame({ type: "item", item: "orb", collected: true } as any);
  }
  if (currentGenerationId !== generationId) return;

  activeOrbTargets = [];
  let addedCount = 0;
  for (const orb of dynamicOrbs) {
    if (currentGenerationId !== generationId) return;

    // Determine if this orb is collected based on unlock state
    let isCollected = false;
    if (unlockSet) {
      const match = orb.icon.match(/orb_(\d+)\.png$/);
      if (match) {
        const orbIdx = parseInt(match[1], 10);
        const key = ORB_OVERLAY_UNLOCK_KEYS[orbIdx];
        if (key && unlockSet.has(key)) isCollected = true;
      }
    }

    // Use empty orb icon (item:orbs/orb) for collected, spell icon for uncollected
    const iconUrl = (isCollected && emptyOrbUrl)
      ? emptyOrbUrl
      : _orbIconCache.get(orb.icon);
    if (!iconUrl) continue;

    const x = orb.x;
    const y = orb.y;
    const orbWidth = 20; // World-coordinate width for orb icon
    const orbHeight = 25; // 4:5 aspect ratio matching 40x50px icon

    const el = document.createElement("img");
    el.src = iconUrl;
    el.className = "dynamic-poi poi-orb";
    el.title = isCollected ? "Orb (collected)" : (orb.name || "Orb");
    el.style.cssText = "image-rendering: pixelated; width: 100%; height: 100%; cursor: pointer;";

    // Store position for canvas-click handler detection
    activeOrbTargets.push({ osdX: x, osdY: y, orb, iconUrl });

    viewer.addOverlay({
      element: el,
      location: new (OpenSeadragon as any).Rect(x - orbWidth / 2, y - orbHeight / 2, orbWidth, orbHeight),
    });
    dynamicOverlayElements.push(el);
    addedCount++;
  }
  console.log(`[OSD Bridge] Added ${addedCount} orb overlays (${unlockSet ? 'unlock-aware' : 'all visible'})`);
}

export async function renderGenerationResult(
  viewer: OSDViewer,
  result: GenerationResult,
  unlocks?: string[] | null,
  isDaily?: boolean,
  onFirstPaint?: () => void,
  cacheKey?: string,
  bakedDZIs?: BakedDziPlacement[] | null,
  // When true, dynamic-map already painted the baked DZIs directly the moment
  // the probe resolved (instant load). renderGenerationResult must NOT add
  // them again — doing so triggers a flicker when the second copy paints and
  // confuses the `cleanupOldItems` snapshot that runs after first-paint.
  bakedDZIsAlreadyOnScreen?: boolean,
  // When true, the baked DZIs already carry pixel scenes + POI marker sprites
  // in their pixels. Skip addPixelScenes() and the marker tile source entirely
  // so the live map keeps the static-map render path: 3 baked DZIs + nothing
  // else. POI clicks still work — they come from the spatial index built off
  // the prebaked generation.json (installClickHandler below).
  bakedDecorations?: boolean,
): Promise<void> {
  const generationId = ++currentGenerationId;
  (window as any).__osdViewer = viewer;

  // Snapshot old dynamic items (tiled images + HTML overlays) BEFORE adding
  // new content. We'll remove them AFTER new content is fully in place,
  // so there's never a visible gap where biome backgrounds disappear.
  const oldWorldItems: any[] = [];
  try {
    const world = viewer.world;
    for (let i = 0; i < world.getItemCount(); i++) {
      const item = world.getItemAt(i);
      // Same base-layer test as clearDynamicOverlays. Routed through
      // isDynamicSeedItem so in-flight baked DZIs whose async success callback
      // hasn't yet tagged source.__bakedDzi are still captured for cleanup.
      if (item && isDynamicSeedItem(item)) {
        oldWorldItems.push(item);
      }
    }
  } catch {}
  const oldOverlayEls = [...dynamicOverlayElements];
  dynamicOverlayElements = [];
  const oldBlobUrls = [...dynamicBlobUrls];
  dynamicBlobUrls = [];
  dynamicTiledImages.clear();
  activeOrbTargets = [];

  // Add biome backgrounds as the bottom-most new layer.
  // Skipped when baked DZIs will replace them — the baked tiles already
  // include the biome bgs and the placeholder would otherwise flash visibly
  // under them on every refresh.
  if (!bakedDZIs || bakedDZIs.length === 0) {
    addBiomeBgToOSD(viewer);
  }
  if (currentGenerationId !== generationId) return;

  // Wrap onFirstPaint so the moment PW 0,0 of the new seed is in place we
  // ALSO purge the previous render's items. This avoids holding two full
  // generations in memory through the rest of the pipeline (~5-6s on FF
  // and Brave) and prevents the visible "old + new stacked" flicker the
  // user saw on heaven/hell.
  let oldItemsCleanedUp = false;
  const cleanupOldItems = () => {
    if (oldItemsCleanedUp) return;
    oldItemsCleanedUp = true;
    try {
      const world = viewer.world;
      for (const item of oldWorldItems) {
        try { world.removeItem(item); } catch {}
      }
    } catch {}
    for (const el of oldOverlayEls) {
      try { viewer.removeOverlay(el); el.remove(); } catch {}
    }
    // Defer URL revoke a bit so any in-flight OSD tile request that already
    // grabbed the URL can still resolve.
    setTimeout(() => {
      for (const url of oldBlobUrls) {
        URL.revokeObjectURL(url);
      }
    }, 500);
  };
  const wrappedOnFirstPaint = () => {
    cleanupOldItems();
    try { onFirstPaint?.(); } catch (e) { console.warn("[OSD Bridge] onFirstPaint threw:", e); }
  };

  // Biome layer: prefer baked DZIs from CF Static Assets workers when the
  // probe in dynamic-map.ts already validated them for this seed. Falls back
  // to the live dynamic composite when no baked set is available (any non-
  // daily seed or a deploy that hasn't caught up yet).
  if (bakedDZIs && bakedDZIs.length > 0) {
    if (bakedDZIsAlreadyOnScreen) {
      // dynamic-map painted these the moment the probe resolved. Just hook
      // them into our cleanup tracking so removeItem() works on next reseed.
      try {
        const w = viewer.world;
        for (let i = 0; i < w.getItemCount(); i++) {
          const item = w.getItemAt(i);
          const url = item?.source?.tilesUrl;
          // DziTileSource rewrites ".../foo.dzi" into tilesUrl ".../foo_files/",
          // so match against that form, not the raw .dzi URL.
          if (typeof url === "string" && bakedDZIs.some((p) => url.startsWith(p.dziUrl.replace(/\.dzi$/, "_files/")))) {
            dynamicTiledImages.add(item);
            // Drop from oldWorldItems snapshot so cleanupOldItems doesn't
            // remove the DZIs we just painted.
            const idx = oldWorldItems.indexOf(item);
            if (idx >= 0) oldWorldItems.splice(idx, 1);
          }
        }
      } catch {}
      // First-paint already fired in dynamic-map (loading bar hid then).
      // Still call wrappedOnFirstPaint to trigger oldItems cleanup for any
      // PRE-baked-paint state (probably nothing in our flow, but defensive).
      try { wrappedOnFirstPaint(); } catch {}
    } else {
      let firstPaintFired = false;
      addBakedDZIsToOSD(viewer, bakedDZIs, (item, _placement) => {
        if (currentGenerationId !== generationId) {
          try { viewer.world.removeItem(item); } catch {}
          return;
        }
        dynamicTiledImages.add(item);
        if (!firstPaintFired) {
          firstPaintFired = true;
          try { wrappedOnFirstPaint(); } catch (e) { console.warn("[OSD Bridge] baked onFirstPaint threw:", e); }
        }
      });
    }
  } else {
    // Adding biomes initializes the OSD viewport bounds.
    await addBiomeLayersProgressively(viewer, result, generationId, wrappedOnFirstPaint, cacheKey);
    if (currentGenerationId !== generationId) return;
  }

  // Pixel scenes render on top of biome overlays, below POI markers. When the
  // baked DZIs already carry scenes in their pixels, skip the live layer.
  if (!bakedDecorations) {
    await addPixelScenes(viewer, result, generationId);
    if (currentGenerationId !== generationId) return;
  }

  // Boss sprites render on top of pixel scenes, below item markers.
  await addBossOverlays(viewer, result, generationId);
  if (currentGenerationId !== generationId) return;

  // Orb icons render as individual overlays using the webp icons.
  await addOrbOverlays(viewer, result, generationId, unlocks ?? null, isDaily ?? false);
  if (currentGenerationId !== generationId) return;

  // 1. Build spatial index for POIs (markers). The index drives click hit
  // testing and is needed even when sprites are baked into the DZI pixels.
  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 0 } }));
  const markerData = await buildMarkerData(result);
  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 50 } }));
  if (currentGenerationId !== generationId) return;

  installClickHandler(viewer, markerData);
  activeMarkerData = markerData;
  // If the HV filter was active before this generation, re-apply rings to the
  // new map. No-op when the predicate is null.
  rebuildHighValueOverlays();

  let itemsProgressDone = false;
  const emitItemsDone = () => {
    if (itemsProgressDone) return;
    itemsProgressDone = true;
    window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 100 } }));
  };

  if (bakedDecorations) {
    // Sprites already baked into the DZI pixels — no marker tile layer to add.
    // Click targets still work through the spatial index installed above.
    emitItemsDone();
  } else {
    // 2. Add as a custom OSD tiled layer
    const markerTileSource = createMarkerTileSource(markerData);
    viewer.addTiledImage({
      tileSource: markerTileSource,
      x: markerData.originX,
      y: markerData.originY,
      width: markerData.bboxWidth,
      success: (event: any) => {
        if (currentGenerationId !== generationId) {
          try {
            viewer.world.removeItem(event.item);
          } catch {}
          return;
        }
        event.item._isMarkerLayer = true;
        dynamicTiledImages.add(event.item);
        markerTiledImage = event.item;

        emitItemsDone();
      },
      error: (err: any) => {
        console.warn("[OSD Bridge] Failed to add marker tiled image:", err);
        emitItemsDone();
      },
    });

    // Fallback: if OSD callback hasn't fired within 3s, force-complete the bar
    setTimeout(emitItemsDone, 3000);
  }

  // Safety net: if first-paint never fired (e.g., empty result, error path),
  // make sure stale items don't linger forever.
  cleanupOldItems();
}

export async function rebuildAltLayers(
  viewer: any,
  result: GenerationResult,
  unlocks: string[] | null,
  isDaily: boolean,
): Promise<void> {
  const generationId = currentGenerationId;

  // 1. Remove previous marker layer
  if (markerTiledImage) {
    try {
      viewer.world.removeItem(markerTiledImage);
    } catch {}
    dynamicTiledImages.delete(markerTiledImage);
    markerTiledImage = null;
  }

  // 2. Remove previous orb overlays
  for (const el of dynamicOverlayElements) {
    try {
      viewer.removeOverlay(el);
    } catch {}
    el.remove();
  }
  dynamicOverlayElements = [];

  // 3. Rebuild orb overlays
  await addOrbOverlays(viewer, result, generationId, unlocks, isDaily);
  if (currentGenerationId !== generationId) return;

  // 4. Build new marker data
  const markerData = await buildMarkerData(result);
  if (currentGenerationId !== generationId) return;

  // 5. Add as a custom OSD tiled layer
  const markerTileSource = createMarkerTileSource(markerData);
  installClickHandler(viewer, markerData);
  activeMarkerData = markerData;
  rebuildHighValueOverlays();

  viewer.addTiledImage({
    tileSource: markerTileSource,
    x: markerData.originX,
    y: markerData.originY,
    width: markerData.bboxWidth,
    success: (event: any) => {
      if (currentGenerationId !== generationId) {
        try {
          viewer.world.removeItem(event.item);
        } catch {}
        return;
      }
      event.item._isMarkerLayer = true;
      dynamicTiledImages.add(event.item);
      markerTiledImage = event.item;
    },
    error: (err: any) => {
      console.warn("[OSD Bridge] Failed to add marker tiled image:", err);
    },
  });
}

export function getAllPOIsFlat(result: GenerationResult): Array<POI & { pw: number; worldX: number; worldY: number }> {
  const flat: Array<POI & { pw: number; worldX: number; worldY: number }> = [];
  const { poisByPW } = result;
  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);
    for (const poi of pois) {
      const isEnemySpawn = poi.type === "enemies" || poi.type === "props";
      // Enemy/prop spawn containers: only emit inner items, not the parent
      if (!isEnemySpawn) {
        flat.push({ ...poi, pw, worldX: poi.x, worldY: poi.y });
      }
      // Unwrap container contents for search (except chest types — those are searched via their parent entry)
      if (CONTAINER_TYPES.has(poi.type) && !CHEST_ONLY_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
        for (const inner of poi.items) {
          if (inner.ignore) continue;
          flat.push({
            ...inner,
            pw,
            parentType: poi.type,
            biome: inner.biome || poi.biome,
            worldX: inner.x ?? poi.x,
            worldY: inner.y ?? poi.y,
          });
        }
      }
    }
  }
  return flat;
}

// ─── getPOISpriteFirstFrame ─────────────────────────────────────────────────

const spriteFirstFrameCache = new Map<string, string | null>();

/**
 * Get a blob URL for a POI's sprite (first frame for animated sprites).
 * Uses the static spritesheet + atlas if available, falls back to data.zip.
 */
export async function getPOISpriteFirstFrame(poi: {
  type: string;
  item?: string;
  sprite?: string;
  material?: string;
  enemy?: string;
  entity?: string;
}): Promise<string | null> {
  // Eagerly load atlas+spritesheet if not already cached
  let atlas = getAtlas();
  let spritesheet = getSpritesheet();
  if (!atlas || !spritesheet) {
    const loaded = await loadSpritesheetAndAtlas();
    atlas = loaded.atlas;
    spritesheet = loaded.spritesheet;
  }

  const rawKey = getSpriteKey(poi as POI, atlas);
  if (!rawKey) return null;

  // Apply spoiler-free transformation — swap sprite key if enabled
  const rootRawKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  const keyRawOut = applySpoilerFree(rootRawKey, atlas);
  const finalKeys = (keyRawOut !== rootRawKey) ? [keyRawOut] : (Array.isArray(rawKey) ? rawKey : [rawKey]);
  const key = finalKeys[0];

  // Cache key includes spoiler-free state to avoid stale entries
  const cacheKey = `${key}:${isSpoilerFree() ? "sf" : "ns"}`;
  if (spriteFirstFrameCache.has(cacheKey)) return spriteFirstFrameCache.get(cacheKey)!;

  if (atlas && spritesheet && atlas[key]) {
    const rootAtlas = atlas[key];
    const frame = FIRST_FRAME_SIZE[key];
    const canvasW = frame ? frame.w : rootAtlas.w;
    const canvasH = frame ? frame.h : rootAtlas.h;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    // Draw all composite layers overlapping using their atlas origins
    const drawKeys = finalKeys;
    let rootScale = 1;
    let rootCenterX = canvasW / 2;
    let rootCenterY = canvasH / 2;
    let isFirst = true;

    for (const k of drawKeys) {
      if (atlas[k]) {
        const e = atlas[k];
        const f = FIRST_FRAME_SIZE[k];
        const sw = f ? f.w : e.w;
        const sh = f ? f.h : e.h;
        
        if (isFirst) {
          isFirst = false;
          const r_ox = e.ox ?? sw / 2;
          const r_oy = e.oy ?? sh / 2;
          rootCenterX = (canvasW - sw * rootScale) / 2 + (r_ox * rootScale);
          rootCenterY = (canvasH - sh * rootScale) / 2 + (r_oy * rootScale);
        }

        const l_ox = e.ox ?? sw / 2;
        const l_oy = e.oy ?? sh / 2;
        const drawX = rootCenterX - (l_ox * rootScale);
        const drawY = rootCenterY - (l_oy * rootScale);
        
        ctx.drawImage(spritesheet, e.x, e.y, sw, sh, drawX, drawY, sw * rootScale, sh * rootScale);
      }
    }

    const url = await new Promise<string>((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob ? URL.createObjectURL(blob) : "");
      }, "image/png");
    });
    spriteFirstFrameCache.set(cacheKey, url || null);
    return url || null;
  }

  // Fallback: decode from data.zip directly (for sprites not in atlas)
  if (key.startsWith("wand:")) {
    const spriteName = key.replace("wand:", "");
    const rotated = await getRotatedWandSprite(spriteName);
    return rotated ? rotated.url : null;
  }

  return null;
}
