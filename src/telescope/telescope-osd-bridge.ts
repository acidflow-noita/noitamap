/**
 * telescope-osd-bridge.ts
 *
 * Renders telescope generation results onto an OpenSeadragon viewer.
 * Adds biome overlays progressively (per-biome, per-PW) for visual feedback.
 */

import type { GenerationResult, POI, PixelScene, TileLayer } from "./telescope-adapter";
import { getDataZip } from "../data-archive";
import { installTelescopeShim } from "./telescope-dom-shim";
import {
  installFetchInterceptor,
  installImageSrcInterceptor,
  buildBiomeColorLookupsFromZip,
} from "./telescope-data-bridge";
import { rgbaToPngBlobUrl } from "./png-decode";
import { buildMarkerData, getAtlas, getSpritesheet, getSpriteKey, loadSpritesheetAndAtlas } from "./poi-spatial-index";
import type { MarkerData, MarkerItem } from "./poi-spatial-index";
import { createMarkerTileSource } from "./marker-tile-source";

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
  const { decodePngToRgba, rgbaToPngBlobUrl } = await import("./png-decode");
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

  // Overwrite the imageProcessingMod lookups with pure-JS decoded ones
  // to fix LibreWolf/Safari fingerprinting protection returning zeroed data
  const correctLookups = await buildBiomeColorLookupsFromZip(genMod.BIOME_COLOR_TO_NAME);
  Object.assign(imageMod.BIOME_BACKGROUND_COLORS, correctLookups.nameLookupBackground);
  Object.assign(imageMod.BIOME_COLOR_LOOKUP, correctLookups.backgroundColors);
  Object.assign(imageMod.TILE_OVERLAY_COLORS, correctLookups.nameLookupForeground);
  Object.assign(imageMod.TILE_FOREGROUND_COLORS, correctLookups.foregroundColors);

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
          error: (err: any) => console.warn(`[OSD Bridge] Failed to add ${biomeName} part PW ${pw}:`, err),
        });
      }
    }

    console.log(`[OSD Bridge] Gen ${generationId}: Added PW ${pw} biome overlays`);

    // Report completion of this PW
    const progressEnd = Math.round(((pwIdx + 1) / totalPWs) * 100);
    window.dispatchEvent(new CustomEvent("biomeGenerationProgress", { detail: { percentage: progressEnd } }));
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

/**
 * Show a tooltip for a marker at the given screen position.
 */
function showMarkerTooltip(item: MarkerItem, screenX: number, screenY: number): void {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "marker-tooltip";
    tooltipEl.style.cssText = `
      position: fixed;
      z-index: 10000;
      background: rgba(20, 20, 30, 0.95);
      color: #eee;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      max-width: 300px;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      font-family: monospace;
      line-height: 1.4;
    `;
    document.body.appendChild(tooltipEl);
  }

  const poi = item.poi;
  let html = "";

  if (poi.type === "wand") {
    html += `<div style="font-weight:bold;color:#c8a2ff">Wand</div>`;
    if (poi.name) html += `<div>${escapeHtml(poi.name)}</div>`;
    if (poi.stats) {
      const s = poi.stats;
      const lines: string[] = [];
      if (s.shuffle != null) lines.push(s.shuffle ? "Shuffle" : "No Shuffle");
      if (s.spellsPerCast != null) lines.push(`Spells/Cast: ${s.spellsPerCast}`);
      if (s.castDelay != null) lines.push(`Cast Delay: ${s.castDelay}`);
      if (s.rechargeTime != null) lines.push(`Recharge: ${s.rechargeTime}`);
      if (s.manaMax != null) lines.push(`Mana: ${s.manaMax}`);
      if (s.manaChargeSpeed != null) lines.push(`Regen: ${s.manaChargeSpeed}`);
      if (s.capacity != null) lines.push(`Capacity: ${s.capacity}`);
      if (s.spread != null) lines.push(`Spread: ${s.spread}°`);
      if (lines.length) html += `<div style="margin-top:4px">${lines.join("<br>")}</div>`;
    }
    if (poi.spells && poi.spells.length) {
      html += `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:2px">`;
      for (const spell of poi.spells) {
        const spellId = typeof spell === "string" ? spell : spell.id ?? spell;
        const iconPath = `./assets/icons/spells/${String(spellId).toLowerCase()}.png`;
        html += `<img src="${iconPath}" width="16" height="16" title="${escapeHtml(String(spellId))}" style="image-rendering:pixelated" onerror="this.style.display='none'">`;
      }
      html += `</div>`;
    }
  } else if (poi.type === "item" || poi.type === "chest") {
    const label = poi.item ?? poi.type;
    html += `<div style="font-weight:bold;color:#ffd700">${escapeHtml(label)}</div>`;
    if (poi.material) html += `<div>Material: ${escapeHtml(poi.material)}</div>`;
    if (poi.contents && poi.contents.length) {
      html += `<div style="margin-top:2px">Contains: ${poi.contents.map((c: any) => escapeHtml(typeof c === "string" ? c : c.name ?? c.item ?? String(c))).join(", ")}</div>`;
    }
  } else {
    html += `<div style="font-weight:bold">${escapeHtml(poi.type)}</div>`;
    if (poi.item) html += `<div>${escapeHtml(poi.item)}</div>`;
  }

  html += `<div style="margin-top:4px;color:#888;font-size:11px">PW ${item.pw} (${Math.round(item.poi.x)}, ${Math.round(item.poi.y)})</div>`;

  tooltipEl.innerHTML = html;
  tooltipEl.style.display = "block";

  // Position tooltip near click, clamped to viewport
  const pad = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let tx = screenX + pad;
  let ty = screenY + pad;
  // Defer clamping to after render so we know tooltip size
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
  if (tooltipEl) tooltipEl.style.display = "none";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Install a canvas-click handler on the viewer to detect marker clicks.
 */
function installClickHandler(viewer: OSDViewer, data: MarkerData): void {
  // Remove previous handler if any
  if (canvasClickHandler) {
    viewer.removeHandler("canvas-click", canvasClickHandler);
    canvasClickHandler = null;
  }

  canvasClickHandler = (event: any) => {
    // Convert click to viewport coordinates, then to image coordinates
    const viewportPoint = viewer.viewport.pointFromPixel(event.position);
    // viewportPoint is in OSD viewport coordinate space
    const vpX = viewportPoint.x;
    const vpY = viewportPoint.y;

    // Convert viewport coords to local (bbox-relative) coords for Flatbush query
    const localX = vpX - data.originX;
    const localY = vpY - data.originY;

    // Search for nearest marker within ~20px radius in local coords
    const searchRadius = 20;
    const results = data.index.search(
      localX - searchRadius,
      localY - searchRadius,
      localX + searchRadius,
      localY + searchRadius,
    );

    if (results.length === 0) {
      hideMarkerTooltip();
      return;
    }

    // Find the closest marker to the click point (using viewport coords for distance)
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

    const clickedItem = data.items[bestIdx];
    if (clickedItem) {
      // Prevent default OSD click behavior (zoom)
      event.preventDefaultAction = true;
      showMarkerTooltip(clickedItem, event.originalEvent.clientX, event.originalEvent.clientY);
    }
  };

  viewer.addHandler("canvas-click", canvasClickHandler);

  // Hide tooltip on drag/pan
  viewer.addHandler("canvas-drag", hideMarkerTooltip);
}

export async function renderGenerationResult(viewer: OSDViewer, result: GenerationResult): Promise<void> {
  const generationId = ++currentGenerationId;
  clearDynamicOverlays(viewer);

  // Start building marker data in parallel with biome rendering
  const markerPromise = buildMarkerData(result);

  // Adding biomes initializes the OSD viewport bounds.
  await addBiomeLayersProgressively(viewer, result, generationId);

  if (currentGenerationId !== generationId) return;

  // Add marker layer via MarkerTileSource
  const data = await markerPromise;
  activeMarkerData = data;

  if (currentGenerationId !== generationId) return;
  if (data.items.length === 0) {
    console.log("[OSD Bridge] No POI markers to render");
    window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 100 } }));
    return;
  }

  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 30 } }));

  // Get maxLevel from the first item that has it (usually the main map DZI)
  let maxLevel = 12; // sensible default
  for (let i = 0; i < viewer.world.getItemCount(); i++) {
    const item = viewer.world.getItemAt(i);
    const source = item.source;
    if (source && source.maxLevel && source.maxLevel > 0) {
      maxLevel = source.maxLevel;
      break;
    }
  }

  // Use the bounding box computed by buildMarkerData for tile source dimensions.
  // This ensures the tile source covers exactly the area where markers exist,
  // and its internal coordinate space (0-based) matches the Flatbush index.
  const markerTileSource = createMarkerTileSource(data, {
    width: data.bboxWidth,
    height: data.bboxHeight,
    maxLevel,
  });

  window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 60 } }));

  viewer.addTiledImage({
    tileSource: markerTileSource,
    x: data.originX,
    y: data.originY,
    width: data.bboxWidth,
    success: (event: any) => {
      if (currentGenerationId !== generationId) {
        try { viewer.world.removeItem(event.item); } catch {}
        return;
      }
      dynamicTiledImages.add(event.item);
      console.log(`[OSD Bridge] MarkerTileSource added with ${data.items.length} markers`);
      window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 100 } }));
    },
    error: (err: any) => {
      console.warn("[OSD Bridge] Failed to add marker layer:", err);
      window.dispatchEvent(new CustomEvent("itemsGenerationProgress", { detail: { percentage: 100 } }));
    },
  });

  // Install click handler for tooltips
  installClickHandler(viewer, data);
}

export function getAllPOIsFlat(result: GenerationResult): Array<POI & { pw: number; worldX: number; worldY: number }> {
  const flat: Array<POI & { pw: number; worldX: number; worldY: number }> = [];
  const { poisByPW } = result;
  for (const [pwKey, pois] of Object.entries(poisByPW)) {
    const [pwStr] = pwKey.split(",");
    const pw = parseInt(pwStr);
    for (const poi of pois) {
      flat.push({ ...poi, pw, worldX: poi.x, worldY: poi.y });
      // Unwrap container items (shops, holy mountain shops, eye rooms)
      if (
        (poi.type === "holy_mountain_shop" || poi.type === "shop" || poi.type === "eye_room") &&
        poi.items &&
        Array.isArray(poi.items)
      ) {
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
  const key = getSpriteKey(poi as POI);
  if (!key) return null;

  if (spriteFirstFrameCache.has(key)) return spriteFirstFrameCache.get(key)!;

  // Eagerly load atlas+spritesheet if not already cached
  let atlas = getAtlas();
  let spritesheet = getSpritesheet();
  if (!atlas || !spritesheet) {
    const loaded = await loadSpritesheetAndAtlas();
    atlas = loaded.atlas;
    spritesheet = loaded.spritesheet;
  }

  if (atlas && spritesheet && atlas[key]) {
    const entry = atlas[key];
    const canvas = document.createElement("canvas");
    canvas.width = entry.w;
    canvas.height = entry.h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spritesheet, entry.x, entry.y, entry.w, entry.h, 0, 0, entry.w, entry.h);
    const url = await new Promise<string>((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob ? URL.createObjectURL(blob) : "");
      }, "image/png");
    });
    spriteFirstFrameCache.set(key, url || null);
    return url || null;
  }

  // Fallback: decode from data.zip directly (for sprites not in atlas)
  if (key.startsWith("wand:")) {
    const name = key.slice(5);
    // Return unrotated (horizontal) wand sprite for UI use (search results, etc.)
    const url = await getWandSprite(name);
    spriteFirstFrameCache.set(key, url);
    return url;
  }

  if (key.startsWith("item:")) {
    const name = key.slice(5);
    const url = await getItemSpriteFromZip(name);
    spriteFirstFrameCache.set(key, url);
    return url;
  }

  spriteFirstFrameCache.set(key, null);
  return null;
}

async function getItemSpriteFromZip(name: string): Promise<string | null> {
  const zip = await getDataZip();
  if (!zip) return null;
  const file = zip.file(`data/items_gfx/${name}.png`);
  if (!file) return null;
  const blob = await file.async("blob");
  return URL.createObjectURL(blob);
}

// ─── Spell image preloading ─────────────────────────────────────────────────

let spellImagesPreloaded = false;

/**
 * Preload spell icons so tooltip spell images load instantly.
 * Uses <link rel=prefetch> for background loading.
 */
export function preloadSpellImages(): void {
  if (spellImagesPreloaded) return;
  spellImagesPreloaded = true;

  // The spell icons are already deployed as static assets at ./assets/icons/spells/*.png
  // We can't enumerate them without a manifest, so instead we preload on first tooltip show.
  // For now, preload nothing proactively — browser caching handles repeat loads.
  // The atlas already contains spell sprites for search results.
  // Tooltip spell icons use the per-file icons at ./assets/icons/spells/ which are
  // loaded on demand with img tags — the browser cache will handle them after first load.
}

