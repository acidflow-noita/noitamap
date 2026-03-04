/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Merges biome layers into a single master canvas for performance and scaling.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./telescope-adapter";
declare const OpenSeadragon: any;

let CHUNK_SIZE: number;
let BIOME_CONFIG: any;
let GENERATOR_CONFIG: any;
let TILE_FOREGROUND_COLORS: any;
let BIOME_COLOR_LOOKUP: any;
let createTileOverlaysCheap: any;
let getWorldSize: any;
let _telescopeModulesLoaded = false;

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
      biomeData, tileLayers, pw, 0 /* pwVertical */, isNGP,
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

  // Noita alignment:
  // Middle world origin corresponds to Chunk 35 (or 36 for NGP).
  // anchorX is the world coordinate of the left edge of the Middle World.
  const middleWorldLeftX = -(worldCenter * 512);
  const totalLeftX = middleWorldLeftX + minPW * pwOffsetPixels;
  const anchorY = -(14 * 512); // Chunk 14 is the origin vertical chunk

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
    // Also track the item immediately if available sync (though success is safer)
    dynamicTiledImages.add(tiledImage);
  }
}

/**
 * Add pixel scenes for all parallel worlds to the viewer.
 */
export async function addPixelScenes(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  await ensureTelescopeModules();
  const { pixelScenesByPW, worldCenter, worldSize } = result;

  let addedCount = 0;

  for (const [pwKey, scenes] of Object.entries(pixelScenesByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);

    for (const scene of scenes) {
      if (!scene || !scene.imgElement) continue;

      const url = await canvasToBlobUrl(scene.imgElement as any);

      const x = scene.x + worldCenter * CHUNK_SIZE - pw * worldSize * CHUNK_SIZE;
      const y = scene.y + 14 * CHUNK_SIZE;

      viewer.addTiledImage({
        tileSource: {
          type: "image",
          url: url,
          buildPyramid: false, // Small scenes don't need pyramids
        },
        x,
        y,
        width: scene.width * 10,
      });
      addedCount++;
    }
  }

  setTimeout(() => {
    const count = viewer.world.getItemCount();
    // This logic needs to be updated to work with a Set if pixel scenes are to be cleared dynamically.
    // For now, pixel scenes are not cleared by clearDynamicOverlays.
    // const newItems: any[] = [];
    // for (let i = count - addedCount; i < count; i++) {
    //   if (i >= 0) newItems.push(viewer.world.getItemAt(i));
    // }
    // dynamicTiledImages.push(...newItems);
  }, 100);
}

/**
 * Add POI markers as OSD HTML overlays.
 */
export async function addPOIOverlays(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  await ensureTelescopeModules();
  const { poisByPW, worldCenter, worldSize } = result;

  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);

    for (const poi of pois) {
      const el = createPOIElement(poi);
      if (!el) continue;

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

function createPOIElement(poi: POI): HTMLElement | null {
  const el = document.createElement("div");
  el.className = "dynamic-poi";
  const color = getPOIColor(poi);
  el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.5);pointer-events:none;`;
  return el;
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
