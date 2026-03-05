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
declare const OpenSeadragon: any;

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
  "coalmine", "coalmine_alt", "excavationsite", "fungicave", "snowcave",
  "snowcastle", "rainforest", "rainforest_open", "vault", "crypt",
  "liquidcave", "pyramid", "wandcave", "sandcave", "the_end",
  "fungiforest", "rainforest_dark", "wizardcave", "robobase", "meat",
  "vault_frozen", "clouds", "the_sky", "snowchasm",
  // Tower variants
  "tower_end", "tower_crypt", "tower_vault", "tower_rainforest",
  "tower_fungicave", "tower_snowcastle", "tower_snowcave",
  "tower_excavationsite", "tower_coalmine",
  // Extra generation biomes
  "boss_arena", "snowcave_secret_chamber", "excavationsite_cube_chamber",
  "snowcastle_cavern", "snowcastle_hourglass_chamber", "pyramid_top",
  "robot_egg", "secret_lab", "wizardcave_entrance", "dragoncave",
];

/** Biomes already baked into the static OSD background map — skip rendering. */
const SKIP_BIOMES = new Set([
  "temple_altar",
  "biome_watchtower", "biome_potion_mimics", "biome_darkness",
  "biome_boss_sky", "biome_barren",
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
      dynamicBlobUrls.push(url);
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

  const blob = await file.async("blob");
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(blob);
  });

  // Rotate 90deg CCW via canvas
  const canvas = document.createElement("canvas");
  canvas.width = img.height;
  canvas.height = img.width;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(0, img.width);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(img, 0, 0);

  const rotatedBlob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!rotatedBlob) return null;

  const url = URL.createObjectURL(rotatedBlob);
  const result = { url, w: canvas.width, h: canvas.height };

  rotatedSpriteUrlCache.set(spriteName, result);
  dynamicBlobUrls.push(url);
  URL.revokeObjectURL(img.src); // Clean up the intermediate URL

  return result;
}

async function ensureTelescopeModules(): Promise<void> {
  if (_telescopeModulesLoaded) return;

  // Ensure interceptors are installed before importing telescope modules.
  // image_processing.js has a top-level await that loads PNGs via new Image().src,
  // which needs the Image src interceptor to resolve from data.zip.
  // On cache-hit paths, initTelescope() is skipped, so these may not be installed yet.
  await getDataZip();
  installTelescopeShim({ clearSpawnPixels: true, recolorMaterials: true, enableEdgeNoise: true, fixHolyMountainEdgeNoise: true });
  installFetchInterceptor();
  installImageSrcInterceptor();

  const [constantsMod, biomeMod, genMod, imageMod, utilsMod] = await Promise.all([
    import("noita-telescope/constants.js"),
    import("noita-telescope/biome_generator.js"),
    import("noita-telescope/generator_config.js"),
    import("noita-telescope/image_processing.js"),
    import("noita-telescope/utils.js"),
  ]);
  CHUNK_SIZE = constantsMod.CHUNK_SIZE;
  BIOME_CONFIG = biomeMod.BIOME_CONFIG;
  GENERATOR_CONFIG = genMod.GENERATOR_CONFIG;
  TILE_FOREGROUND_COLORS = imageMod.TILE_FOREGROUND_COLORS;
  BIOME_COLOR_LOOKUP = imageMod.BIOME_COLOR_LOOKUP;
  createTileOverlaysCheap = imageMod.createTileOverlaysCheap;
  getWorldSize = utilsMod.getWorldSize;

  // Apply truthy color hack: the library uses `if (foregroundColor)` which
  // fails for color 0 (black). Change 0→1 (near-black) to make it truthy.
  // initTelescope() does this too, but on cache-hit paths it may not have run.
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
  for (const item of dynamicTiledImages) {
    try {
      viewer.world.removeItem(item);
    } catch {}
  }
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
 * Convert an OffscreenCanvas to a blob URL.
 */
async function offscreenCanvasToBlobUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const url = URL.createObjectURL(blob);
  dynamicBlobUrls.push(url);
  return url;
}

/**
 * Convert an HTMLCanvasElement to a blob URL.
 */
async function canvasToBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
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

  const anchorY = -(14 * 512);

  for (const pw of pwOrder) {
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
              try { viewer.world.removeItem(event.item); } catch {}
              return;
            }
            dynamicTiledImages.add(event.item);
          },
          error: (err: any) => console.warn(`[OSD Bridge] Failed to add ${biomeName} part PW ${pw}:`, err),
        });
      }
    }

    console.log(`[OSD Bridge] Gen ${generationId}: Added PW ${pw} biome overlays`);

    // Yield to browser so OSD renders this world before we compute the next
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ─── Pixel Scenes ───────────────────────────────────────────────────────────

/**
 * Add pixel scenes for all parallel worlds to the viewer.
 */
export async function addPixelScenes(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  await ensureTelescopeModules();
  const { pixelScenesByPW, worldCenter } = result;

  // Parallelize URL creation
  const allScenes = Object.values(pixelScenesByPW).flat();
  const sceneData = await Promise.all(
    allScenes.map(async (scene) => {
      if (!scene || !scene.imgElement) return null;
      const url = await canvasToBlobUrl(scene.imgElement as any);
      return { scene, url };
    }),
  );

  for (const data of sceneData) {
    if (!data) continue;
    const { scene, url } = data;

    const { x, y } = getCorrectedWorldPos(scene.x, scene.y, worldCenter);

    viewer.addTiledImage({
      tileSource: {
        type: "image",
        url: url,
        buildPyramid: false,
      },
      x,
      y,
      width: scene.width * 10,
      success: (event: any) => {
        dynamicTiledImages.add(event.item);
        dynamicBlobUrls.push(url);
      },
    });
  }
}

// ─── POI Overlays ───────────────────────────────────────────────────────────

/**
 * Add POI markers as OSD HTML overlays.
 */
export async function addPOIOverlays(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  await ensureTelescopeModules();
  const { poisByPW, worldCenter } = result;

  const allPois = Object.values(poisByPW).flat();
  const wandsOnly = allPois.filter((p) => p.type === "wand");

  // Parallelize sprite loading
  const uniqueSpriteNames = [...new Set(wandsOnly.map((p) => p.sprite))].filter(Boolean) as string[];
  const spriteMap = new Map<string, { url: string; w: number; h: number }>();

  await Promise.all(
    uniqueSpriteNames.map(async (name) => {
      const rotated = await getRotatedWandSprite(name);
      if (rotated) spriteMap.set(name, rotated);
    }),
  );

  for (const poi of wandsOnly) {
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
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function renderGenerationResult(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  const generationId = ++currentGenerationId;
  clearDynamicOverlays(viewer);
  await addBiomeLayersProgressively(viewer, result, generationId);
  if (currentGenerationId !== generationId) return;
  await addPOIOverlays(viewer, result);
  // await addPixelScenes(viewer, result);
}

export function getAllPOIsFlat(result: GenerationResult): Array<POI & { pw: number; worldX: number; worldY: number }> {
  const flat: Array<POI & { pw: number; worldX: number; worldY: number }> = [];
  const { poisByPW } = result;
  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);
    for (const poi of pois) {
      flat.push({ ...poi, pw, worldX: poi.x, worldY: poi.y });
    }
  }
  return flat;
}
