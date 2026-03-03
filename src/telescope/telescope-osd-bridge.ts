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
let TILE_FOREGROUND_COLORS: any;
let _telescopeModulesLoaded = false;

async function ensureTelescopeModules(): Promise<void> {
  if (_telescopeModulesLoaded) return;
  const [constantsMod, biomeMod, imageMod] = await Promise.all([
    import("noita-telescope/constants.js"),
    import("noita-telescope/biome_generator.js"),
    import("noita-telescope/image_processing.js"),
  ]);
  CHUNK_SIZE = constantsMod.CHUNK_SIZE;
  BIOME_CONFIG = biomeMod.BIOME_CONFIG;
  TILE_FOREGROUND_COLORS = imageMod.TILE_FOREGROUND_COLORS;
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
 * Recolor grayscale Wang tiles with biome-specific foreground colors.
 */
function recolorLayerCanvas(canvas: HTMLCanvasElement, biomeColor: number): void {
  const fgColor = TILE_FOREGROUND_COLORS?.[biomeColor];
  if (!fgColor) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  const r = (fgColor >> 16) & 0xff;
  const g = (fgColor >> 8) & 0xff;
  const b = fgColor & 0xff;

  for (let i = 0; i < data.length; i += 4) {
    // If it's a "gray" pixel (detail pixel), recolor it
    if (data[i] === data[i + 1] && data[i + 1] === data[i + 2] && data[i] > 0) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  ctx.putImageData(imgData, 0, 0);
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
 * Generates a single master canvas by merging all biome layers.
 */
async function generateMasterCanvas(result: GenerationResult): Promise<HTMLCanvasElement> {
  const { tileLayers, isNGP } = result;

  // Noita world dimensions (in chunks)
  const w = isNGP ? 72 : 70;
  const h = 240;

  // 1. Create a Master World Canvas at 1:10 scale (as per Telescope's internal scale)
  const masterW = Math.ceil((w * 512) / 10);
  const masterH = Math.ceil((h * 512) / 10);

  const masterCanvas = document.createElement("canvas");
  masterCanvas.width = masterW;
  masterCanvas.height = masterH;
  const ctx = masterCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create master canvas context");

  // Merge all biome layers into the master canvas
  for (const layer of tileLayers) {
    if (!layer.canvas) continue;

    // Apply biome recoloring if we have a biome name/color
    const biomeName = (layer as any).biomeName;
    const biomeColor = BIOME_CONFIG[biomeName]?.color;
    if (biomeColor !== undefined) {
      recolorLayerCanvas(layer.canvas, biomeColor);
    }

    // layer.correctedX/Y are relative to Chunk 0. Map to 1/10th scale.
    ctx.drawImage(layer.canvas, layer.correctedX / 10, layer.correctedY / 10);
  }
  return masterCanvas;
}

/**
 * Generates a giant master canvas covering all active parallel worlds (usually -1, 0, 1).
 */
async function generateMasterWorldCanvas(result: GenerationResult): Promise<HTMLCanvasElement> {
  const { tileLayers, isNGP, parallelWorlds } = result;

  // Noita world width (in chunks)
  const w = isNGP ? 72 : 70;
  const pwOffsetPixels = w * 512;
  const pws = parallelWorlds || [-1, 0, 1];
  const minPW = Math.min(...pws);
  const maxPW = Math.max(...pws);
  const numPws = maxPW - minPW + 1;

  // Master World Canvas at 1:10 scale
  const masterW = Math.ceil((numPws * pwOffsetPixels) / 10);
  const masterH = Math.ceil((140 * 512) / 10); // Vertical size covers expected range

  const canvas = document.createElement("canvas");
  canvas.width = masterW;
  canvas.height = masterH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Shift to start drawing from the leftmost PW
  const xOffset = -minPW * pwOffsetPixels;

  for (const pw of pws) {
    const pwShiftX = (pw * pwOffsetPixels + xOffset) / 10;
    for (const layer of tileLayers) {
      if (layer.canvas) {
        ctx.drawImage(layer.canvas, pwShiftX + layer.correctedX / 10, layer.correctedY / 10);
      }
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
  // Overlays are now cleared at the START of runDynamicMap to avoid stacking
  // during the long generation process. We clear again here just in case.
  clearDynamicOverlays(viewer);
  await addTileLayers(viewer, result, generationId);
  // POIs and pixel scenes disabled to maximize stability for now
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
