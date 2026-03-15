/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Adds biome overlays progressively (per-biome, per-PW) for visual feedback.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./telescope-adapter";
import { getDataZip } from "../data-archive";
import { installTelescopeShim } from "./telescope-dom-shim";
import { installFetchInterceptor, installImageSrcInterceptor } from "./telescope-data-bridge";
import { decodePngToRgba, rgbaToPngBlobUrl } from "./png-decode";
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
} from "./poi-spatial-index";
import type { MarkerData, MarkerItem } from "./poi-spatial-index";
import { createMarkerTileSource } from "./marker-tile-source";
import { gameTranslator } from "../game-translations/translator";
import { isSpoilerFree, getSpoilerCategory, getSpoilerLabel, applySpoilerFree } from "../spoiler-free";
import spells from "../data/spells.json";

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

/** Biomes already baked into the static OSD background map — skip rendering. */
const SKIP_BIOMES = new Set([
  "temple_altar",
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
    spriteName.startsWith("data/") ? spriteName : null,
  ].filter(Boolean) as string[];

  for (const path of paths) {
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
 * Fetch a sprite from data.zip, rotate it 90deg CCW, and return a blob URL + dimensions.
 */
export async function getRotatedWandSprite(spriteName: string): Promise<{ url: string; w: number; h: number } | null> {
  if (rotatedSpriteUrlCache.has(spriteName)) return rotatedSpriteUrlCache.get(spriteName)!;

  const zip = await getDataZip();
  if (!zip) return null;

  const paths = [
    `data/items_gfx/wands/${spriteName}.png`,
    `data/items_gfx/wands/${spriteName}`,
    spriteName.startsWith("data/") ? spriteName : null,
  ].filter(Boolean) as string[];

  let file = null;
  for (const path of paths) {
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
  // Remove ALL world items that aren't base static DZI tiles.
  // This is more robust than tracking individual items, because addTiledImage
  // success callbacks are async and can slip past Set-based tracking.
  try {
    const world = viewer.world;
    for (let i = world.getItemCount() - 1; i >= 0; i--) {
      const item = world.getItemAt(i);
      if (item && typeof item.source?.tilesUrl !== "string") {
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

/**
 * Convert an OffscreenCanvas to a blob URL.
 */
async function offscreenCanvasToBlobUrl(canvas: OffscreenCanvas): Promise<string> {
  const rawData = (canvas as any).__noitamap_rawImageData as ImageData | undefined;
  if (rawData) {
    const url = await rgbaToPngBlobUrl(rawData.data, rawData.width, rawData.height);
    dynamicBlobUrls.push(url);
    return url;
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const url = URL.createObjectURL(blob);
  dynamicBlobUrls.push(url);
  return url;
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

/**
 * Helper to map raw Noita world units to linearized visual units (mod 5 logic).
 */
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
  const totalPWs = pwOrder.length;

  for (let pwIdx = 0; pwIdx < pwOrder.length; pwIdx++) {
    const pw = pwOrder[pwIdx];
    if (currentGenerationId !== generationId) return;

    // Report the START of this PW's computation BEFORE the CPU-heavy work.
    // This ensures the bar visually advances before we get blocked.
    const progressStart = Math.round((pwIdx / totalPWs) * 100);
    window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: progressStart } }));

    // Yield briefly so the browser can paint the progress update before we block the main thread.
    await new Promise((r) => setTimeout(r, 0));
    if (currentGenerationId !== generationId) return;

    // Compute all overlays for this PW at once (CPU-bound, ~1-2s)
    const overlays: (OffscreenCanvas | null)[] = createTileOverlaysCheap(
      biomeData,
      tileLayers,
      pw,
      0 /* pwVertical */,
      isNGP,
    );

    if (currentGenerationId !== generationId) return;

    // Add each biome overlay individually to OSD in render order
    for (const biomeName of allBiomesToRender) {
      if (currentGenerationId !== generationId) return;

      const layerIdxArr = layerIndicesByBiome.get(biomeName);
      if (!layerIdxArr) continue;

      for (const layerIdx of layerIdxArr) {
        if (currentGenerationId !== generationId) return;

        const overlay = overlays[layerIdx];
        if (!overlay || overlay.width === 0 || overlay.height === 0) continue;

        const layer = tileLayers[layerIdx];
        const url = await offscreenCanvasToBlobUrl(overlay);
        if (currentGenerationId !== generationId) return;

        const x = -(worldCenter * 512) + pw * pwOffsetPixels + layer.correctedX;
        const y = anchorY + layer.correctedY;
        const osdWidth = overlay.width * 10;

        viewer.addTiledImage({
          tileSource: {
            type: "image",
            url,
            buildPyramid: false,
          },
          x,
          y,
          width: osdWidth,
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
      }
    }

    console.log(`[OSD Bridge] Gen ${generationId}: Added PW ${pw} biome overlays`);

    // Report completion of this PW
    const progressEnd = Math.round(((pwIdx + 1) / totalPWs) * 100);
    window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: progressEnd } }));
  }
}

// ─── Pixel Scene Config ─────────────────────────────────────────────────────

/** Runtime pixel scene toggle config. Categories can be turned on/off. */
export const pixelSceneConfig = {
  /** Master toggle — disables all pixel scenes when false */
  enabled: true,
  /** Skip lists by scene name */
  skipNames: new Set([
    // Player rooms — not relevant for map
    "teleportroom",
    "mystery_teleport",
    "robot_egg",
    "secret_chamber",
    "cube_chamber",
    "alchemist_secret",
    "eyespot",
    "orbroom",
    "altar_top",
    "altar_right",
    "altar_left",
    "altar",
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
};

// Expose to console for debug toggling
(window as any).__pixelSceneConfig = pixelSceneConfig;

/** Debug panel (off by default, call window.__pixelSceneDebug() to open) */
(window as any).__pixelSceneDebug = () => {
  const cfg = pixelSceneConfig;
  console.group("%c[Pixel Scene Debug]", "color: #0af; font-weight: bold");
  console.log("Master enabled:", cfg.enabled);
  console.log("Skip names:", [...cfg.skipNames]);
  console.log("Skip biomes:", [...cfg.skipBiomes]);
  console.log("Categories:", { ...cfg.categories });
  console.log("");
  console.log("Toggle examples:");
  console.log("  __pixelSceneConfig.enabled = false           // disable all");
  console.log("  __pixelSceneConfig.categories.temple = false // disable temple scenes");
  console.log("  __pixelSceneConfig.skipNames.add('orbroom')  // skip orbroom");
  console.log("  __pixelSceneConfig.skipBiomes.delete('dragoncave') // unblock dragoncave");
  console.log("After changing, re-enter the seed to regenerate.");
  console.groupEnd();
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
    }
  } else {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === tlR && d[i + 1] === tlG && d[i + 2] === tlB) d[i + 3] = 0;
    }
  }
  return new ImageData(d, decoded.width, decoded.height);
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
 * Add pixel scenes for all parallel worlds to the viewer.
 *
 * Loads _visual.png from data.zip for proper pre-colored images.
 * Falls back to telescope's imgElement if no _visual.png exists.
 * Groups by scene key for bitmap caching. Builds a Flatbush spatial index
 * and creates ONE custom OSD tile source for efficient rendering.
 */
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
  if (validScenes.length === 0) return;

  // 1. Collect unique scene keys (biome/name) for _visual.png loading
  const bitmapByKey = new Map<string, ImageBitmap>();
  const uniqueKeys = new Map<string, PixelScene>();

  for (const scene of validScenes) {
    if (!uniqueKeys.has(scene.key)) {
      uniqueKeys.set(scene.key, scene);
    }
  }

  console.log(
    `[OSD Bridge] Pixel scenes: ${allScenes.length} total, ${validScenes.length} valid, ` +
      `${uniqueKeys.size} unique keys`,
  );

  // 2. Build composite bitmaps: _background.png (bottom) + imgElement (middle) + _visual.png (top)
  const BATCH = 50;
  const keyArr = Array.from(uniqueKeys.entries());
  let compositeCount = 0;
  let fallbackCount = 0;
  let missingCount = 0;
  const idx = await getScenePngIndex();

  for (let i = 0; i < keyArr.length; i += BATCH) {
    if (currentGenerationId !== generationId) return;
    const batch = keyArr.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ([key, scene]) => {
        const slashIdx = key.indexOf("/");
        const biome = slashIdx >= 0 ? key.substring(0, slashIdx) : "";
        const name = slashIdx >= 0 ? key.substring(slashIdx + 1) : key;
        const skipBg = biome === "temple" || biome === "general";

        const visualPath = resolveScenePath(idx.visualByPath, idx.visualByName, biome, name, key);
        const bgPath = skipBg ? undefined : resolveScenePath(idx.bgByPath, idx.bgByName, biome, name, key);

        const zip = await getDataZip();
        let bgData: ImageData | null = null;
        let visualData: ImageData | null = null;

        if (zip && bgPath) {
          bgData = await decodeScenePng(zip, bgPath).catch(() => null);
          // Skip tiny material-variant patches
          if (bgData && scene.width > 0 && bgData.width < scene.width / 2) bgData = null;
        }
        if (zip && visualPath) {
          visualData = await decodeScenePng(zip, visualPath).catch(() => null);
        }

        // Middle layer: telescope's recolored imgElement (with magenta/air fix)
        let midBitmap: ImageBitmap | null = null;
        if (scene.imgElement) {
          midBitmap = await imgElementToBitmap(scene.imgElement, scene.width, scene.height);
        }

        // Determine what layers we have
        const hasBg = !!bgData;
        const hasMid = !!midBitmap;
        const hasVis = !!visualData;

        if (!hasBg && !hasMid && !hasVis) {
          missingCount++;
          return;
        }

        // Single layer — no compositing needed
        if (!hasBg && !hasVis && hasMid) {
          bitmapByKey.set(key, midBitmap!);
          fallbackCount++;
          return;
        }
        if (!hasBg && !hasMid && hasVis) {
          bitmapByKey.set(key, await createImageBitmap(visualData!));
          compositeCount++;
          return;
        }
        if (hasBg && !hasMid && !hasVis) {
          bitmapByKey.set(key, await createImageBitmap(bgData!));
          compositeCount++;
          return;
        }

        // Multi-layer composite: bg → imgElement → visual
        const w = scene.width || Math.max(bgData?.width ?? 0, visualData?.width ?? 0);
        const h = scene.height || Math.max(bgData?.height ?? 0, visualData?.height ?? 0);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;

        if (bgData) {
          const bmp = await createImageBitmap(bgData);
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        }
        if (midBitmap) {
          ctx.drawImage(midBitmap, 0, 0);
          midBitmap.close();
        }
        if (visualData) {
          const bmp = await createImageBitmap(visualData);
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        }

        bitmapByKey.set(key, await createImageBitmap(canvas));
        compositeCount++;
      }),
    );
  }

  if (currentGenerationId !== generationId) return;
  console.log(
    `[OSD Bridge] Pixel scene bitmaps: ${bitmapByKey.size}/${uniqueKeys.size} ` +
      `(${compositeCount} composite, ${fallbackCount} fallback, ${missingCount} missing)`,
  );

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
    const { x, y } = getCorrectedWorldPos(scene.x, scene.y, worldCenter);
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
        const drawX = (item.osdX - originX - bx) * drawScale;
        const drawY = (item.osdY - originY - by) * drawScale;
        const drawW = item.w * drawScale;
        const drawH = item.h * drawScale;
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
  const wandsOnly = allPois.filter((p) => p.type === "wand");

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
    el.style.cssText = `
      image-rendering: pixelated;
      width: 100%;
      height: 100%;
      cursor: pointer;
    `;

    const { x, y } = getCorrectedWorldPos(poi.x, poi.y, worldCenter);

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

/**
 * Show a popup for a marker at the given screen position.
 * Styled to match noitamap's dark theme with game-style presentation.
 */
function showMarkerTooltip(item: MarkerItem, screenX: number, screenY: number): void {
  // Remove previous popup
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }

  tooltipEl = document.createElement("div");
  tooltipEl.className = "marker-tooltip";
  tooltipEl.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 2px solid #3a3a5c;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 340px;
    pointer-events: auto;
    box-shadow: 0 6px 20px rgba(0,0,0,0.7);
    font-family: monospace;
    line-height: 1.5;
  `;

  // Close button
  const closeBtn = document.createElement("div");
  closeBtn.style.cssText = `
    position: absolute; top: 4px; right: 8px;
    cursor: pointer; color: #666; font-size: 16px;
    line-height: 1;
  `;
  closeBtn.textContent = "x";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    hideMarkerTooltip();
  };
  tooltipEl.appendChild(closeBtn);

  const poi = item.poi;

  // ─── Spoiler-free mode: generic popup with no details ──────────────────
  if (isSpoilerFree()) {
    const category = getSpoilerCategory(item.spriteKey);
    const label = getSpoilerLabel(category);
    const colorMap = { wand: "#c8a2ff", spell: "#66ccff", something: "#ffd700" };

    const title = document.createElement("div");
    title.style.cssText = `font-weight:bold;color:${colorMap[category]};font-size:14px;margin-bottom:4px`;
    title.textContent = label;
    tooltipEl.appendChild(title);

    // Footer with position only
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:6px;color:#666;font-size:11px;border-top:1px solid #333;padding-top:4px";
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
      if (tx < pad) tx = pad;
      if (ty < pad) ty = pad;
      tooltipEl.style.left = `${tx}px`;
      tooltipEl.style.top = `${ty}px`;
    });
    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;
    return;
  }

  if (poi.type === "wand") {
    // Header with sprite
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText =
      "width:32px;height:32px;image-rendering:pixelated;object-fit:contain;transform:rotate(90deg)";
    getPOISpriteFirstFrame({ type: "wand", sprite: poi.sprite }).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#c8a2ff;font-size:14px";
    title.textContent = poi.name || gameTranslator.translateItem("Wand");
    header.appendChild(title);
    tooltipEl.appendChild(header);

    // Wand stats — telescope POIs put stats as top-level snake_case fields,
    // but some paths may wrap them in a stats sub-object. Check both.
    const s = poi.stats || poi;
    const statsDiv = document.createElement("div");
    statsDiv.style.cssText =
      "display:grid;grid-template-columns:auto auto;gap:1px 12px;font-size:12px;margin-bottom:6px;color:#bbb";
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
    if (shuffle != null) addStat("Shuffle:", shuffle ? "Yes" : "No");
    const spc = s.spellsPerCast ?? s.spells_per_cast ?? s.actions_per_round;
    if (spc != null) addStat("Spells/Cast:", String(Math.floor(Number(spc))));
    const cd = s.castDelay ?? s.cast_delay ?? s.fire_rate_wait;
    if (cd != null) addStat("Cast Delay:", String(Math.floor(Number(cd))));
    const rt = s.rechargeTime ?? s.recharge_time ?? s.reload_time;
    if (rt != null) addStat("Recharge:", String(Math.floor(Number(rt))));
    const mm = s.manaMax ?? s.mana_max;
    if (mm != null) addStat("Mana:", String(Math.floor(Number(mm))));
    const mc = s.manaChargeSpeed ?? s.mana_charge_speed;
    if (mc != null) addStat("Regen:", String(Math.floor(Number(mc))));
    const cap = s.capacity ?? s.deck_capacity;
    if (cap != null) addStat("Capacity:", String(Math.floor(Number(cap))));
    const spread = s.spread ?? s.spread_degrees;
    if (spread != null) addStat("Spread:", `${Math.floor(Number(spread))} deg`);
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
      spellsRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;margin-top:4px";
      for (const slot of displaySlots) {
        const container = document.createElement("div");
        container.style.cssText = `position:relative;display:inline-block;width:22px;height:22px;background:#111;border-radius:3px;border:1px solid ${slot.isAC ? "#c8a2ff" : "#333"}`;
        if (slot.id) {
          container.title = gameTranslator.translateSpell(getSpellName(slot.id));
        }
        if (slot.isAC) {
          const badge = document.createElement("div");
          badge.textContent = "AC";
          badge.style.cssText =
            "position:absolute;top:-5px;left:-5px;width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:bold;background:white;color:black;border-radius:50%;border:1px solid #333;z-index:2";
          container.appendChild(badge);
        }
        if (slot.id) {
          const img = document.createElement("img");
          img.style.cssText = "width:20px;height:20px;image-rendering:pixelated;display:block;margin:auto";
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
    header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText = "width:24px;height:24px;image-rendering:pixelated;object-fit:contain";
    getPOISpriteFirstFrame(poi as any).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);

    const label = poi.item ?? poi.type;
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#ffd700;font-size:14px";
    // Show HP info for heart items, spell names for spells
    if (poi.item === "spell" && (poi as any).spell) {
      title.textContent = gameTranslator.translateSpell(getSpellName(String((poi as any).spell)));
    } else if (poi.item === "heart") title.textContent = "Heart (+25 HP)";
    else if (poi.item === "heart_bigger") title.textContent = "Heart (+50 HP)";
    else if (poi.item === "full_heal") title.textContent = "Full Heal";
    else title.textContent = gameTranslator.translateItem(label).replace(/_/g, " ");
    header.appendChild(title);
    tooltipEl.appendChild(header);

    if (poi.material) {
      const mat = document.createElement("div");
      mat.style.cssText = "color:#aaa;font-size:12px";
      const materialLabel = gameTranslator.translateItem("inventory_actiontype_material");
      mat.textContent = `${materialLabel}: ${gameTranslator.translateMaterial(poi.material)}`;
      tooltipEl.appendChild(mat);
    }
    if (poi.amount) {
      const amt = document.createElement("div");
      amt.style.cssText = "color:#aaa;font-size:12px";
      amt.textContent = `Amount: ${poi.amount}`;
      tooltipEl.appendChild(amt);
    }
    if (poi.contents && poi.contents.length) {
      const contentsDiv = document.createElement("div");
      contentsDiv.style.cssText = "margin-top:2px;color:#aaa;font-size:12px";
      contentsDiv.textContent = `Contains: ${poi.contents
        .map((c: any) => {
          const cName = typeof c === "string" ? c : (c.name ?? c.item ?? String(c));
          return gameTranslator.translateItem(cName);
        })
        .join(", ")}`;
      tooltipEl.appendChild(contentsDiv);
    }
  } else if (poi.type === "spell") {
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
    const spriteImg = document.createElement("img");
    spriteImg.style.cssText = "width:24px;height:24px;image-rendering:pixelated;display:block";
    getPOISpriteFirstFrame({ type: "spell", item: poi.item }).then((url) => {
      if (url) spriteImg.src = url;
    });
    header.appendChild(spriteImg);
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;color:#66ccff;font-size:14px";
    title.textContent = gameTranslator.translateSpell(getSpellName(poi.item || "")) || "Spell";
    header.appendChild(title);
    tooltipEl.appendChild(header);
  } else {
    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;font-size:14px;margin-bottom:4px";
    const label = poi.type || "Unknown";
    title.textContent = gameTranslator.translateItem(label).replace(/_/g, " ");
    tooltipEl.appendChild(title);
    if (poi.item) {
      const itemDiv = document.createElement("div");
      itemDiv.style.cssText = "color:#aaa;font-size:12px";
      itemDiv.textContent = gameTranslator.translateItem(poi.item).replace(/_/g, " ");
      tooltipEl.appendChild(itemDiv);
    }
  }

  // Container contents — show items inside chests/shops/bosses
  if (CONTAINER_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
    const contDiv = document.createElement("div");
    contDiv.style.cssText = "margin-top:6px;border-top:1px solid #333;padding-top:4px";
    const contLabel = document.createElement("div");
    contLabel.style.cssText = "font-size:11px;color:#888;margin-bottom:3px";
    contLabel.textContent = "Contains:";
    contDiv.appendChild(contLabel);
    const contRow = document.createElement("div");
    contRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;align-items:center";
    for (const ci of poi.items) {
      if (ci.ignore) continue;
      const ciKey = getSpriteKey(ci, getAtlas() || undefined);
      const ciName = ci.name || ci.item || ci.type || "";
      const translatedName =
        ci.item === "spell" && ci.spell
          ? gameTranslator.translateSpell(getSpellName(String(ci.spell)))
          : gameTranslator.translateItem(ciName);

      // Wands: show sprite (rotated) + spell icons
      if (ci.type === "wand") {
        const wandBox = document.createElement("div");
        wandBox.style.cssText =
          "display:flex;align-items:center;gap:2px;background:#111;border-radius:3px;padding:2px 4px;border:1px solid #333";
        if (ciKey) {
          const canvas = drawSpriteToCanvas(ciKey, 20, 20);
          if (canvas) {
            canvas.style.cssText += ";transform:rotate(90deg)";
            canvas.title = ci.name || "Wand";
            wandBox.appendChild(canvas);
          }
        }
        const spellIds = [...(ci.always_casts || []), ...(ci.cards || [])];
        for (const sid of spellIds.slice(0, 4)) {
          const spellKey = resolveSpellKey(String(sid));
          const spellCanvas = drawSpriteToCanvas(spellKey, 16, 16);
          if (spellCanvas) {
            spellCanvas.title = gameTranslator.translateSpell(getSpellName(String(sid)));
            wandBox.appendChild(spellCanvas);
          }
        }
        if (spellIds.length > 4) {
          const more = document.createElement("span");
          more.style.cssText = "font-size:10px;color:#888";
          more.textContent = `+${spellIds.length - 4}`;
          wandBox.appendChild(more);
        }
        contRow.appendChild(wandBox);
        continue;
      }

      // Gold: show sprite + amount
      if (ci.item === "gold" || ci.item === "goldnugget") {
        const goldBox = document.createElement("div");
        goldBox.style.cssText =
          "display:flex;align-items:center;gap:3px;background:#111;border-radius:2px;padding:1px 4px;border:1px solid #333";
        if (ciKey) {
          const canvas = drawSpriteToCanvas(ciKey, 20, 20);
          if (canvas) goldBox.appendChild(canvas);
        }
        const label = document.createElement("span");
        label.style.cssText = "font-size:11px;color:#ffd700";
        label.textContent = ci.amount ? `$${ci.amount}` : "Gold";
        goldBox.appendChild(label);
        contRow.appendChild(goldBox);
        continue;
      }

      // Hearts: show sprite + HP label
      if (ci.item === "heart" || ci.item === "heart_bigger" || ci.item === "full_heal") {
        const heartBox = document.createElement("div");
        heartBox.style.cssText =
          "display:flex;align-items:center;gap:3px;background:#111;border-radius:2px;padding:1px 4px;border:1px solid #333";
        if (ciKey) {
          const canvas = drawSpriteToCanvas(ciKey, 20, 20);
          if (canvas) heartBox.appendChild(canvas);
        }
        const label = document.createElement("span");
        label.style.cssText = "font-size:11px;color:#ff6b6b";
        if (ci.item === "heart") label.textContent = "+25 HP";
        else if (ci.item === "heart_bigger") label.textContent = "+50 HP";
        else label.textContent = "Full Heal";
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
          "display:flex;align-items:center;gap:3px;background:#111;border-radius:2px;padding:1px 4px;border:1px solid #333";
        const canvas = drawSpriteToCanvas(ciKey, 20, 20);
        if (canvas) itemBox.appendChild(canvas);
        const textSpan = document.createElement("span");
        textSpan.style.cssText = "font-size:11px;color:#aaa";
        textSpan.textContent = displayName;
        itemBox.appendChild(textSpan);
        contRow.appendChild(itemBox);
        continue;
      }
      const span = document.createElement("span");
      span.style.cssText =
        "font-size:11px;color:#aaa;background:#111;border-radius:2px;padding:1px 4px;border:1px solid #333";
      span.textContent = displayName;
      contRow.appendChild(span);
    }
    contDiv.appendChild(contRow);
    tooltipEl.appendChild(contDiv);
  }

  // Footer: position info
  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:6px;color:#666;font-size:11px;border-top:1px solid #333;padding-top:4px";
  footer.textContent = `PW ${item.pw} (${Math.round(item.poi.x)}, ${Math.round(item.poi.y)})`;
  tooltipEl.appendChild(footer);

  document.body.appendChild(tooltipEl);

  // Position popup near click, clamped to viewport
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

function hideMarkerTooltip(): void {
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}

let canvasMoveCleanup: (() => void) | null = null;

/**
 * Install a canvas-click handler on the viewer to detect marker clicks,
 * and a mousemove handler to show pointer cursor when hovering over markers.
 */
function installClickHandler(viewer: OSDViewer, data: MarkerData): void {
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
      showMarkerTooltip(item, event.originalEvent.clientX, event.originalEvent.clientY);
    } else {
      hideMarkerTooltip();
    }
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

export async function renderGenerationResult(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  const generationId = ++currentGenerationId;
  clearDynamicOverlays(viewer);
  (window as any).__osdViewer = viewer;

  // Adding biomes initializes the OSD viewport bounds.
  await addBiomeLayersProgressively(viewer, result, generationId);
  if (currentGenerationId !== generationId) return;

  // Pixel scenes render on top of biome overlays, below POI markers.
  await addPixelScenes(viewer, result, generationId);
  if (currentGenerationId !== generationId) return;

  // 1. Build spatial index for POIs (markers)
  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 0 } }));
  const markerData = await buildMarkerData(result);
  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 50 } }));
  if (currentGenerationId !== generationId) return;

  // 2. Add as a custom OSD tiled layer
  const markerTileSource = createMarkerTileSource(markerData);
  installClickHandler(viewer, markerData);
  activeMarkerData = markerData;

  let itemsProgressDone = false;
  const emitItemsDone = () => {
    if (itemsProgressDone) return;
    itemsProgressDone = true;
    window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 100 } }));
  };

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

export function getAllPOIsFlat(result: GenerationResult): Array<POI & { pw: number; worldX: number; worldY: number }> {
  const flat: Array<POI & { pw: number; worldX: number; worldY: number }> = [];
  const { poisByPW } = result;
  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);
    for (const poi of pois) {
      flat.push({ ...poi, pw, worldX: poi.x, worldY: poi.y });
      // Unwrap container contents for search (except chest types — those are searched via their parent entry)
      if (CONTAINER_TYPES.has(poi.type) && !CHEST_ONLY_TYPES.has(poi.type) && poi.items && Array.isArray(poi.items)) {
        for (const inner of poi.items) {
          if (inner.ignore) continue;
          flat.push({ ...inner, pw, worldX: inner.x, worldY: inner.y });
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
  const key = applySpoilerFree(rawKey, atlas);

  // Cache key includes spoiler-free state to avoid stale entries
  const cacheKey = `${key}:${isSpoilerFree() ? "sf" : "ns"}`;
  if (spriteFirstFrameCache.has(cacheKey)) return spriteFirstFrameCache.get(cacheKey)!;

  if (atlas && spritesheet && atlas[key]) {
    const entry = atlas[key];
    // Use first-frame dimensions for animated sprites
    const frame = FIRST_FRAME_SIZE[key];
    const srcW = frame ? frame.w : entry.w;
    const srcH = frame ? frame.h : entry.h;
    const canvas = document.createElement("canvas");
    canvas.width = srcW;
    canvas.height = srcH;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spritesheet, entry.x, entry.y, srcW, srcH, 0, 0, srcW, srcH);
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
