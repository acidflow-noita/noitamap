/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Merges biome layers into a single master canvas for performance and scaling.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./adapter";
import { getDataZip } from "../data-archive";
declare const OpenSeadragon: any;

let CHUNK_SIZE: number;
let BIOME_CONFIG: any;
let GENERATOR_CONFIG: any;
let TILE_FOREGROUND_COLORS: any;
let BIOME_COLOR_LOOKUP: any;
let createTileOverlaysCheap: any;
let getWorldSize: any;
let _telescopeModulesLoaded = false;

// ─── Sprite Cache ───────────────────────────────────────────────────────────

const spriteUrlCache: Map<string, string> = new Map();
const rotatedSpriteUrlCache: Map<string, { url: string; w: number; h: number }> = new Map();

/**
 * Fetch a sprite from data.zip, rotate it 90deg CCW, and return a blob URL + dimensions.
 */
async function getRotatedWandSprite(spriteName: string): Promise<{ url: string; w: number; h: number } | null> {
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

/**
 * Fetch a sprite from data.zip and return an HTMLImageElement.
 */
async function getWandSpriteImage(spriteName: string): Promise<HTMLImageElement | null> {
  // Obsolete: logic moved to getRotatedWandSprite
  return null;
}

async function ensureTelescopeModules(): Promise<void> {
  if (_telescopeModulesLoaded) return;
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
  _telescopeModulesLoaded = true;
}

type OSDViewer = any;

const dynamicTiledImages: Set<OpenSeadragon.TiledImage> = new Set();
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
 * Convert a canvas to a blob URL asynchronously.
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
 * Build a biome background canvas from biomeData.pixels using BIOME_COLOR_LOOKUP.
 * Replicates telescope's renderRecolorMap() — produces a w×h canvas where each
 * pixel is the recolored background color for that biome chunk.
 */
function buildRecolorBackground(biomeData: any, w: number, h: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const id = ctx.createImageData(w, h);

  const surfaceBiomes = [
    0x1133f1, // Lake
    0xf7cf8d, // Pond
    0x36d517, // Hills
    0xd6d8e3, // Snow
    0xcc9944, // Desert
    0x48e311, // Empty
  ];
  const surfaceLevel = 14;

  for (let i = 0; i < biomeData.pixels.length; i++) {
    let color = biomeData.pixels[i] & 0xffffff;
    const isSurfaceBiome = surfaceBiomes.includes(color);
    if (BIOME_COLOR_LOOKUP[color]) {
      if (isSurfaceBiome) {
        if (i > w * surfaceLevel) {
          color = BIOME_COLOR_LOOKUP[color];
        } else {
          // Sky gradient
          const depthFactor = Math.min(Math.floor(i / w) / surfaceLevel, 1);
          const r = 0x87 + (0xbb - 0x87) * depthFactor;
          const g = 0xce + (0xdd - 0xce) * depthFactor;
          const b = 0xeb;
          color = (r << 16) | (g << 8) | b;
        }
      } else {
        color = BIOME_COLOR_LOOKUP[color];
      }
    }
    id.data[i * 4] = (color >> 16) & 0xff;
    id.data[i * 4 + 1] = (color >> 8) & 0xff;
    id.data[i * 4 + 2] = color & 0xff;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

/**
 * Generates a giant master canvas covering all active parallel worlds (usually -1, 0, 1).
 * Draws biome background first (recolorMap), then tile overlays on top.
 */
async function generateMasterWorldCanvas(result: GenerationResult): Promise<HTMLCanvasElement> {
  const { tileLayers, isNGP, parallelWorlds, biomeData } = result;

  // Noita world dimensions
  const w = isNGP ? 72 : 70;
  const h = isNGP ? 48 : 48; // Biome map height in chunks
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];
  const minPW = Math.min(...pws);
  const maxPW = Math.max(...pws);
  const numPws = maxPW - minPW + 1;

  // Master World Canvas at 1:10 scale
  const masterW = Math.ceil((numPws * pwOffsetPixels) / 10);
  const masterH = Math.ceil((h * 512) / 10);

  const canvas = document.createElement("canvas");
  canvas.width = masterW;
  canvas.height = masterH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Shift to start drawing from the leftmost PW
  const xOffset = -minPW * pwOffsetPixels;

  // 1. Draw tile overlays for each PW
  for (const pw of pws) {
    const pwShiftX = (pw * pwOffsetPixels + xOffset) / 10;

    const overlays: (OffscreenCanvas | null)[] = createTileOverlaysCheap(
      biomeData,
      tileLayers,
      pw,
      0 /* pwVertical */,
      isNGP,
    );

    for (let i = 0; i < tileLayers.length; i++) {
      const layer = tileLayers[i];
      const overlay = overlays[i];
      if (!overlay) continue;
      ctx.drawImage(overlay, pwShiftX + layer.correctedX / 10, layer.correctedY / 10);
    }
  }

  return canvas;
}

/**
 * Helper to map raw Noita world units to linearized visual units (mod 5 logic).
 * rawX/rawY: Noita world units (0,0 is the origin in the middle of World 0).
 * Returns: OSD coordinate relative to the same origin.
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

/**
 * Add generated tile canvases to the OSD viewer.
 */
export async function addTileLayers(viewer: OSDViewer, result: GenerationResult, generationId: number): Promise<void> {
  await ensureTelescopeModules();
  const { isNGP, worldCenter, parallelWorlds } = result;

  // 1. Get or Generate Master World Canvas
  if (!result.masterCanvas) {
    result.masterCanvas = await generateMasterWorldCanvas(result);
  }
  const masterCanvas = result.masterCanvas;

  // Guard: if another generation started while we were processing this one, abort.
  if (currentGenerationId !== generationId) {
    console.log(`[OSD Bridge] Aborting addTileLayers for obsolete generation ${generationId}`);
    return;
  }

  // 2. Add to OSD
  const url = await canvasToBlobUrl(masterCanvas);

  const w = isNGP ? 72 : 70;
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];
  const minPW = Math.min(...pws);

  // Middle world origin corresponds to Chunk 35 (or 36 for NGP).
  const middleWorldLeftX = -(worldCenter * 512);
  const totalLeftX = middleWorldLeftX + minPW * pwOffsetPixels;
  const anchorY = -(14 * 512);

  console.log(
    `[OSD Bridge] Gen ${generationId}: Adding master biomes at x=${totalLeftX}, y=${anchorY}, wc=${worldCenter}`,
  );

  // Clear existing biome layers IMMEDIATELY before adding new ones
  clearDynamicOverlays(viewer);

  const tiledImage = viewer.addTiledImage({
    tileSource: {
      type: "image",
      url: url,
      buildPyramid: true,
    },
    x: totalLeftX,
    y: anchorY,
    width: masterCanvas.width * 10,
    success: (event: any) => {
      // Final Guard: If a newer generation has already taken over, remove this one immediately.
      if (currentGenerationId !== generationId) {
        console.log(`[OSD Bridge] Removing late-success image for generation ${generationId}`);
        viewer.world.removeItem(event.item);
        return;
      }
      dynamicTiledImages.add(event.item);
      dynamicBlobUrls.push(url);
    },
    error: (err: any) => console.error("[OSD Bridge] Failed to load master image:", err),
  });

  if (tiledImage) {
    dynamicTiledImages.add(tiledImage);
  }
}

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

    // Use mod 5 correction for structure alignment
    const { x, y } = getCorrectedWorldPos(scene.x, scene.y, worldCenter);

    viewer.addTiledImage({
      tileSource: {
        type: "image",
        url: url,
        buildPyramid: false,
      },
      x,
      y,
      width: scene.width * 10, // 1 pixel = 10 units
      success: (event: any) => {
        dynamicTiledImages.add(event.item);
        dynamicBlobUrls.push(url);
      },
    });
  }
}

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

    // Apply mod 5 correction for precise centering
    const { x, y } = getCorrectedWorldPos(poi.x, poi.y, worldCenter);

    // 1 sprite pixel = 1 world unit in Noita
    const worldW = rotated.w;
    const worldH = rotated.h;

    viewer.addOverlay({
      element: el,
      location: new (OpenSeadragon as any).Rect(x - worldW / 2, y - worldH / 2, worldW, worldH),
    });

    dynamicOverlayElements.push(el);
  }
}

async function createPOIElement(poi: POI): Promise<HTMLElement | null> {
  // Obsolete: logic moved into addPOIOverlays for Rect support
  return null;
}

function getPOIColor(poi: POI): string {
  switch (poi.type) {
    case "wand":
      return "#00FFFF";
    case "item":
      return "#FFFF00";
    case "chest":
      return "#FFA500";
    default:
      return "#FFFFFF";
  }
}

export async function renderGenerationResult(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  const generationId = ++currentGenerationId;
  clearDynamicOverlays(viewer);
  await addTileLayers(viewer, result, generationId);
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
