/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Merges biome layers into a single master canvas for performance and scaling.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./telescope-adapter";
declare const OpenSeadragon: any;

let CHUNK_SIZE: number;
let _telescopeModulesLoaded = false;

async function ensureTelescopeModules(): Promise<void> {
  if (_telescopeModulesLoaded) return;
  const [constantsMod, utilsMod] = await Promise.all([
    import("noita-telescope/constants.js"),
    import("noita-telescope/utils.js"),
  ]);
  CHUNK_SIZE = constantsMod.CHUNK_SIZE;
  _telescopeModulesLoaded = true;
}

type OSDViewer = any;

let dynamicTiledImages: any[] = [];
let dynamicOverlayElements: HTMLElement[] = [];
let dynamicBlobUrls: string[] = [];

/**
 * Remove all dynamic map overlays from the viewer.
 */
export function clearDynamicOverlays(viewer: any): void {
  for (const item of dynamicTiledImages) {
    try {
      viewer.world.removeItem(item);
    } catch {}
  }
  dynamicTiledImages = [];

  for (const el of dynamicOverlayElements) {
    try {
      viewer.removeOverlay(el);
      el.remove();
    } catch {}
  }
  dynamicOverlayElements = [];

  for (const url of dynamicBlobUrls) {
    URL.revokeObjectURL(url);
  }
  dynamicBlobUrls = [];
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
 * Add generated tile canvases to the OSD viewer.
 * Merges all biomes into a single master canvas to solve memory/scaling issues.
 */
export async function addTileLayers(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  await ensureTelescopeModules();
  const { tileLayers, isNGP, worldCenter } = result;

  // Noita world dimensions (in chunks)
  const w = isNGP ? 72 : 70;
  const h = 240;
  const pwOffsetChunks = w * 512;

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
    // layer.correctedX/Y are relative to Chunk 0. Map to 1/10th scale.
    ctx.drawImage(layer.canvas, layer.correctedX / 10, layer.correctedY / 10);
  }

  // 2. Add to OSD
  const url = await canvasToBlobUrl(masterCanvas);
  const anchorX = -(worldCenter * 512); // Chunk 35 (center) -> -17920
  const anchorY = -(14 * 512); // Chunk 14 (origin) -> -7168

  let addedCount = 0;
  for (const pw of result.parallelWorlds || [-1, 0, 1]) {
    const pwShiftX = pw * pwOffsetChunks;

    viewer.addTiledImage({
      tileSource: {
        type: "image",
        url: url,
        buildPyramid: true, // Native OSD pyramid support for clean zooming
      },
      x: anchorX + pwShiftX,
      y: anchorY,
      width: masterW * 10, // Apply 10x scale to mapped pixels
      error: (err: any) => console.error("[OSD Bridge] Failed to load master image:", err),
    });
    addedCount++;
  }

  // Track items for dynamic cleanup
  setTimeout(() => {
    const count = viewer.world.getItemCount();
    const newItems: any[] = [];
    for (let i = count - addedCount; i < count; i++) {
      if (i >= 0) newItems.push(viewer.world.getItemAt(i));
    }
    dynamicTiledImages.push(...newItems);
  }, 100);
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
    const newItems: any[] = [];
    for (let i = count - addedCount; i < count; i++) {
      if (i >= 0) newItems.push(viewer.world.getItemAt(i));
    }
    dynamicTiledImages.push(...newItems);
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
  clearDynamicOverlays(viewer);
  await addTileLayers(viewer, result);
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
