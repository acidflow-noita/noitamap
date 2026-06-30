/**
 * telescope-adapter.ts
 *
 * Main adapter that wraps telescope's generation pipeline into a clean
 * async API for noitamap.
 */

import { installTelescopeShim } from "./telescope-dom-shim";
import { installFetchInterceptor, installImageSrcInterceptor } from "./telescope-data-bridge";
import { getDataZip } from "../data-archive";
import { clearCache } from "./tile-cache";
import orbsData from "../data/orbs.json";
import {
  buildPillarSegments,
  makePillarUnlockPredicate,
  makePillarUnlockPredicateFromFlags,
  PILLAR_BASE,
} from "../data/pillars";
import PwWorker from "./pw-worker?worker";

// Telescope modules
let generateBiomeData: any;
let BIOME_CONFIG: any;
let generateBiomeTiles: any;
let scanSpawnFunctions: any;
let getSpecialPoIs: any;
let prescanSpawnFunctions: any;
let PIXEL_SCENE_DATA: any;
/**
 * Get the raw pixel scene image data from telescope's internal cache.
 * Telescope's refactored loadPixelScene/loadRandomPixelScene no longer set
 * imgElement on returned scene objects, but the data still exists in
 * PIXEL_SCENE_DATA[key].imgElement.
 */
export function getPixelSceneImgElement(key: string): Uint8Array | null {
  if (!PIXEL_SCENE_DATA || !PIXEL_SCENE_DATA[key]) return null;
  return PIXEL_SCENE_DATA[key].imgElement || null;
}

/** Returns the full pixel-scene record (imgElement, width, height, name, etc). */
export function getPixelSceneData(key: string): any | null {
  if (!PIXEL_SCENE_DATA || !PIXEL_SCENE_DATA[key]) return null;
  return PIXEL_SCENE_DATA[key];
}

/** Returns every pixel scene key telescope has loaded (after initTelescope). */
export function getAllPixelSceneKeys(): string[] {
  if (!PIXEL_SCENE_DATA) return [];
  return Object.keys(PIXEL_SCENE_DATA);
}
let loadPixelSceneData: any;
export let recolorPixelSceneForBiome: any;
export let recolorPixelScene: any;
export let MATERIAL_COLOR_CONVERSION: Record<number, number> = {};
let GENERATOR_CONFIG: any;
let UNLOCKABLES: any;
let setUnlocks: any;
let getWorldSize: any;
let getWorldCenter: any;
let loadTranslations: any;
let findEyeMessages: any;
let addStaticPixelScenes: any;
let telescopeApp: any;
let BIOME_COLOR_LOOKUP: any;
export let TILE_OVERLAY_COLORS: any;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TileLayer {
  biomeName: string;
  canvas: HTMLCanvasElement;
  correctedX: number;
  correctedY: number;
  w: number;
  h: number;
  buffer: Uint8Array;
  width: number;
  height: number;
  xmax: number;
  ymax: number;
  tileSize: number;
  tileIndices: Uint16Array;
  numHTiles: number;
  numVTiles: number;
  path: Array<{ x: number; y: number }>;
  pixelScenesByPW: Record<string, any>;
}

export interface POI {
  type: string;
  item?: string;
  x: number;
  y: number;
  highlight?: boolean;
  spell?: string;
  material?: string;
  cards?: string[];
  biome?: string;
  [key: string]: any;
}

export interface PixelScene {
  imgElement: HTMLCanvasElement | OffscreenCanvas | Uint8Array | Uint8ClampedArray;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  key: string;
  variantKey?: string;
  spawnPoints?: any[];
}

export interface GenerationResult {
  seed: number;
  ngPlus: number;
  isNGP: boolean;
  worldSize: number;
  worldCenter: number;
  tileLayers: TileLayer[];
  biomeData: any;
  /** POIs keyed by "pw,pwVertical" e.g. "0,0", "-1,0", "1,0" */
  poisByPW: Record<string, POI[]>;
  /** Pixel scenes keyed by "pw,pwVertical" */
  pixelScenesByPW: Record<string, PixelScene[]>;
  eyes: any;
  parallelWorlds: number[];
}

export interface GenerateOptions {
  seed: number;
  ngPlus?: number;
  dailySeed?: boolean;
  /** Which horizontal parallel worlds to generate for */
  parallelWorlds?: number[];
  /** Game mode: 'normal' or 'nightmare' */
  gameMode?: string;
  /** Unlocked spell keys. null = all unlocked. */
  unlocks?: string[] | null;
  /** Raw achievement flags from the mod's dedicated pillar channel (`&p=`).
   *  When provided, drives pillar segment lock state directly; falls back to
   *  `unlocks` (spell-key inference) when null/undefined. */
  pillarFlags?: string[] | null;
}

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * Telescope spaces the three tower wands (biome solid_wall_tower_10) 100px
 * apart "to make interaction easier". On the map that reads as too wide a
 * spread. Re-center the trio at their mean X and pack them GAP px apart.
 */
function retowerWands(pois: POI[]): void {
  const tower = pois.filter((p: any) => p.type === "wand" && p.biome === "solid_wall_tower_10");
  if (tower.length < 2) return;
  const GAP = 40;
  tower.sort((a, b) => a.x - b.x);
  const mid = (tower[0].x + tower[tower.length - 1].x) / 2;
  const start = mid - (GAP * (tower.length - 1)) / 2;
  tower.forEach((p, i) => {
    p.x = start + i * GAP;
  });
}

let initialized = false;
let initPromise: Promise<void> | null = null;
let biomeAssets: { ng0: Uint32Array | null; ngp: Uint32Array | null; nightmare: Uint32Array | null } = {
  ng0: null,
  ngp: null,
  nightmare: null,
};

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * One-time setup: install DOM shim, fetch interceptor, load base assets.
 * Safe to call multiple times (no-ops after first).
 */
export async function initTelescope(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = _doInitTelescope();
  await initPromise;
}

async function _doInitTelescope(): Promise<void> {
  console.log("[Telescope] Initializing...");

  // 1. Install DOM shim before any telescope code reads the DOM
  installTelescopeShim({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
  });

  // 2. Ensure data.zip is loaded
  const zip = await getDataZip();
  if (!zip) throw new Error("[Telescope] data.zip failed to load");

  // 3. Install fetch interceptor so telescope's fetch('./data/...') goes to zip
  installFetchInterceptor();

  // 3b. Install Image src interceptor so telescope's new Image().src = './data/...' goes to zip
  installImageSrcInterceptor();

  // 4. Dynamically import telescope modules (must happen AFTER interceptors are installed,
  //    because image_processing.js has top-level await that loads PNGs via new Image())
  const telescope = await import("./telescope-exports");
  const biomeGenMod = telescope.biomeGenMod;
  const tileGenMod = telescope.tileGenMod;
  const poiScannerMod = telescope.poiScannerMod;
  const pixelSceneMod = telescope.pixelSceneMod;
  const genConfigMod = telescope.genConfigMod;
  const unlocksMod = telescope.unlocksMod;
  const utilsMod = telescope.utilsMod;
  const translationsMod = telescope.translationsMod;
  const eyeMessagesMod = telescope.eyeMessagesMod;
  const imageProcessingMod = telescope.imageProcessingMod;
  const staticSpawnsMod = telescope.staticSpawnsMod;
  const pngSanitizerMod = telescope.pngSanitizerMod;
  const appMod = telescope.appMod;
  const settingsMod = telescope.settingsMod;
  const potionConfigMod = telescope.potionConfigMod;

  // 4b. Push our shim settings into telescope's centralized appSettings.
  //     Telescope refactored from reading DOM checkboxes directly to using
  //     an appSettings object (settings.js). Without this call, clearSpawnPixels
  //     defaults to false and spawn pixels reappear on the map.
  settingsMod.updateSettings({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
    enableStaticPixelScenes: "all",
    skipCosmeticScenes: false,
    excludeTaikasauva: false,
    excludeEdgeCases: false,
    showEnemies: true,
  });

  generateBiomeData = biomeGenMod.generateBiomeData;
  BIOME_CONFIG = biomeGenMod.BIOME_CONFIG;
  generateBiomeTiles = tileGenMod.generateBiomeTiles;
  scanSpawnFunctions = poiScannerMod.scanSpawnFunctions;
  getSpecialPoIs = poiScannerMod.getSpecialPoIs;
  prescanSpawnFunctions = poiScannerMod.prescanSpawnFunctions;
  PIXEL_SCENE_DATA = pixelSceneMod.PIXEL_SCENE_DATA;
  loadPixelSceneData = pixelSceneMod.loadPixelSceneData;
  recolorPixelSceneForBiome = pixelSceneMod.recolorPixelSceneForBiome;
  recolorPixelScene = pixelSceneMod.recolorPixelScene;
  MATERIAL_COLOR_CONVERSION = potionConfigMod.MATERIAL_COLOR_CONVERSION;
  GENERATOR_CONFIG = genConfigMod.GENERATOR_CONFIG;
  UNLOCKABLES = unlocksMod.UNLOCKABLES;
  setUnlocks = unlocksMod.setUnlocks;
  getWorldSize = utilsMod.getWorldSize;
  getWorldCenter = utilsMod.getWorldCenter;
  loadTranslations = translationsMod.loadTranslations;
  findEyeMessages = eyeMessagesMod.findEyeMessages;
  addStaticPixelScenes = staticSpawnsMod.addStaticPixelScenes;
  telescopeApp = appMod.app;
  BIOME_COLOR_LOOKUP = imageProcessingMod.BIOME_COLOR_LOOKUP;
  TILE_OVERLAY_COLORS = imageProcessingMod.TILE_OVERLAY_COLORS;

  // 5. Load biome map base assets (telescope's preload step)
  // Use library's loadPNG which handles sanitization
  const [ng0Img, ngpImg] = await Promise.all([
    pngSanitizerMod.loadPNG("./data/biome_maps/biome_map.png"),
    pngSanitizerMod.loadPNG("./data/biome_maps/biome_map_newgame_plus.png"),
  ]);

  // Nightmare biome map is optional — only available when data.zip includes it
  let nightmareImg: any = null;
  try {
    nightmareImg = await pngSanitizerMod.loadPNG("./data/biome_maps/biome_map_nightmare.png");
  } catch (_) {}

  // Apply gamma fix directly to the raw RGBA bytes.
  // The dev mentioned #000042 becomes #000040. We ensure it's #000042.
  const applyGammaFix = (img: any) => {
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0x40) {
        data[i + 2] = 0x42;
      }
    }
    return data;
  };

  biomeAssets = {
    ng0: applyGammaFix(ng0Img),
    ngp: applyGammaFix(ngpImg),
    nightmare: nightmareImg ? applyGammaFix(nightmareImg) : null,
  };

  if (!biomeAssets.ng0) throw new Error("[Telescope] Failed to load NG0 biome map");

  // 6. Load translations
  await loadTranslations();

  // 7. Enable all regions in generator config
  for (const key of Object.keys(GENERATOR_CONFIG)) {
    GENERATOR_CONFIG[key].enabled = true;
  }

  // 8. Pre-load wang tile data for all regions
  const wangLoadResults: string[] = [];
  for (const key of Object.keys(GENERATOR_CONFIG)) {
    const cfg = GENERATOR_CONFIG[key];
    if (cfg.wangFile && !cfg.wangData) {
      // Use library's loadPNG for wang tiles too
      try {
        const img = await pngSanitizerMod.loadPNG(cfg.wangFile);
        cfg.wangData = img;
      } catch (e) {
        wangLoadResults.push(`FAIL: ${key} (${cfg.wangFile})`);
      }
    }
  }
  if (wangLoadResults.length > 0) {
    console.warn("[Telescope] Wang tile load failures:", wangLoadResults);
  } else {
    console.log("[Telescope] All wang tiles loaded successfully");
  }

  // 9. Load pixel scene data (uses fetch interceptor internally).
  // The new telescope fully awaits image loading, so no polling needed.
  await loadPixelSceneData();

  // 10. Cache bust check: If we just updated the library, clear the generation cache
  // to ensure fixed logic actually runs instead of showing old empty results.
  const LIB_VERSION = "2026-06-25-pillars-v6";
  if (localStorage.getItem("noitamap-telescope-version") !== LIB_VERSION) {
    console.log("[Telescope] Library version updated, clearing generation cache...");
    try {
      clearCache();
    } catch (e) {}
    localStorage.setItem("noitamap-telescope-version", LIB_VERSION);
  }

  initialized = true;
  console.log("[Telescope] Initialization complete");
}

// ─── Generation ─────────────────────────────────────────────────────────────

/**
 * Run the full telescope generation pipeline for a given seed.
 *
 * @param opts.seed — The seed number
 * @param opts.ngPlus — NG+ count (default 0)
 * @param opts.dailySeed — If true, force all unlocks ON
 * @param opts.parallelWorlds — Horizontal PW indices to scan (default [-1, 0, 1])
 */
export async function generateDynamicMap(opts: GenerateOptions): Promise<GenerationResult> {
  await initTelescope();

  const seed = opts.seed;
  const ngPlus = opts.ngPlus ?? 0;
  const dailySeed = opts.dailySeed ?? false;
  const parallelWorlds = opts.parallelWorlds ?? [-1, 0, 1];
  const gameMode = opts.gameMode ?? "normal";
  const isNGP = ngPlus > 0;

  console.log(
    `[Telescope] Generating: seed=${seed}, NG+=${ngPlus}, daily=${dailySeed}, PWs=${parallelWorlds.join(",")}`,
  );
  const t0 = performance.now();

  // Set unlocks:
  //   daily seed                -> ALL unlocked (locked-in for daily fairness)
  //   opts.unlocks == null      -> ALL unlocked (no URL param, no mod data
  //                                — match telescope's native default so
  //                                fresh visitors see the same wand contents
  //                                they would in standalone telescope)
  //   opts.unlocks == []        -> NOTHING unlocked (explicit empty list)
  //   opts.unlocks = [keys...]  -> exactly those keys unlocked (mod source)
  if (dailySeed || opts.unlocks == null) {
    setUnlocks(Object.keys(UNLOCKABLES));
  } else {
    setUnlocks(opts.unlocks);
  }

  // World dimensions
  const worldSize = getWorldSize(isNGP, gameMode);
  const worldCenter = getWorldCenter(isNGP, gameMode);
  const useNGPDimensions = isNGP || gameMode === "nightmare";
  const w = useNGPDimensions ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
  const h = useNGPDimensions ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;
  const base = isNGP ? biomeAssets.ngp : gameMode === "nightmare" ? biomeAssets.nightmare : biomeAssets.ng0;

  if (!base) throw new Error("[Telescope] Biome map assets not loaded");

  // Step 1: Generate biome data
  const biomeData = generateBiomeData(seed, ngPlus, gameMode, base, w, h);

  // Debug: Log all unique colors to see if they match constants
  const uniqueColors = new Set(Array.from(biomeData.pixels));
  console.log(
    "[Telescope Debug] Unique colors in biomeData:",
    Array.from(uniqueColors).map((c: any) => "0x" + (c >>> 0).toString(16).padStart(8, "0")),
  );

  // Fix: Ensure alpha is set. The library might return signed or unsigned depending on bits.
  for (let i = 0; i < biomeData.pixels.length; i++) {
    biomeData.pixels[i] = (biomeData.pixels[i] | 0xff000000) >>> 0;
  }

  // Step 1b: Populate the shimmed app's recolorOffscreen canvas.
  // Each pixel at (chunkX, chunkY) holds the background color for that chunk.
  {
    const recolorCanvas = document.createElement("canvas");
    recolorCanvas.width = w;
    recolorCanvas.height = h;
    const ctx = recolorCanvas.getContext("2d")!;
    const id = ctx.createImageData(w, h);

    // The library's app.recolorOffscreenBuffer is RGB only (stride 3)
    const outBuffer = new Uint8Array(w * h * 3);

    const surfaceBiomes = [0x1133f1, 0xf7cf8d, 0x36d517, 0xd6d8e3, 0xcc9944, 0x48e311];
    const surfaceLevel = 14;
    for (let i = 0; i < biomeData.pixels.length; i++) {
      let color = biomeData.pixels[i] & 0xffffff;
      const isSurface = surfaceBiomes.includes(color);
      if (BIOME_COLOR_LOOKUP[color]) {
        if (isSurface && i > w * surfaceLevel) {
          color = BIOME_COLOR_LOOKUP[color];
        } else if (isSurface) {
          const depthFactor = Math.min(Math.floor(i / w) / surfaceLevel, 1);
          const r = 0x87 + (0xbb - 0x87) * depthFactor;
          const g = 0xce + (0xdd - 0xce) * depthFactor;
          color = (r << 16) | (g << 8) | 0xeb;
        } else {
          color = BIOME_COLOR_LOOKUP[color];
        }
      }

      const r = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const b = color & 0xff;

      id.data[i * 4] = r;
      id.data[i * 4 + 1] = g;
      id.data[i * 4 + 2] = b;
      id.data[i * 4 + 3] = 255;

      outBuffer[i * 3] = r;
      outBuffer[i * 3 + 1] = g;
      outBuffer[i * 3 + 2] = b;
    }
    ctx.putImageData(id, 0, 0);
    telescopeApp.recolorOffscreen = recolorCanvas;
    telescopeApp.recolorOffscreenBuffer = outBuffer;
    telescopeApp.w = w;
    telescopeApp.h = h;
    telescopeApp.ngPlusCount = ngPlus;
    telescopeApp.biomeData = biomeData;

    // Populate heaven recolor buffer (from top row of main recolor, matching app.js logic)
    if (biomeData.heavenPixels) {
      const heavenCanvas = document.createElement("canvas");
      heavenCanvas.width = w;
      heavenCanvas.height = h;
      const ctxH = heavenCanvas.getContext("2d")!;
      const heavenId = ctxH.createImageData(w, h);
      const heavenBuffer = new Uint8Array(w * h * 3);
      for (let i = 0; i < biomeData.heavenPixels.length; i++) {
        // Use top row pixels of main recolor map for heaven (same as app.js)
        heavenId.data[i * 4] = id.data[(i * 4) % (w * 4)];
        heavenId.data[i * 4 + 1] = id.data[(i * 4 + 1) % (w * 4)];
        heavenId.data[i * 4 + 2] = id.data[(i * 4 + 2) % (w * 4)];
        heavenId.data[i * 4 + 3] = 255;
        heavenBuffer[i * 3] = id.data[(i * 4) % (w * 4)];
        heavenBuffer[i * 3 + 1] = id.data[(i * 4 + 1) % (w * 4)];
        heavenBuffer[i * 3 + 2] = id.data[(i * 4 + 2) % (w * 4)];
      }
      ctxH.putImageData(heavenId, 0, 0);
      telescopeApp.recolorOffscreenHeaven = heavenCanvas;
      telescopeApp.recolorOffscreenHeavenBuffer = heavenBuffer;
    }

    // Populate hell recolor buffer
    if (biomeData.hellPixels) {
      const hellCanvas = document.createElement("canvas");
      hellCanvas.width = w;
      hellCanvas.height = h;
      const ctxHe = hellCanvas.getContext("2d")!;
      const hellId = ctxHe.createImageData(w, h);
      const hellBuffer = new Uint8Array(w * h * 3);
      for (let i = 0; i < biomeData.hellPixels.length; i++) {
        const hColor = biomeData.hellPixels[i] & 0xffffff;
        const recolor = BIOME_COLOR_LOOKUP[hColor] || hColor;
        const hr = (recolor >> 16) & 0xff;
        const hg = (recolor >> 8) & 0xff;
        const hb = recolor & 0xff;
        hellId.data[i * 4] = hr;
        hellId.data[i * 4 + 1] = hg;
        hellId.data[i * 4 + 2] = hb;
        hellId.data[i * 4 + 3] = 255;
        hellBuffer[i * 3] = hr;
        hellBuffer[i * 3 + 1] = hg;
        hellBuffer[i * 3 + 2] = hb;
      }
      ctxHe.putImageData(hellId, 0, 0);
      telescopeApp.recolorOffscreenHell = hellCanvas;
      telescopeApp.recolorOffscreenHellBuffer = hellBuffer;
    }
  }

  // Step 2: Generate tiles
  const tileLayers: TileLayer[] = await generateBiomeTiles(
    biomeData.pixels,
    w,
    h,
    GENERATOR_CONFIG,
    seed,
    ngPlus,
    0 /* extra_rerolls */,
    gameMode,
  );

  // Initialize pixel scene caches on each layer
  for (const layer of tileLayers) {
    layer.pixelScenesByPW = {};
  }

  // Step 3: Prescan spawn functions (once per seed, reused across PWs)
  const tileSpawns = prescanSpawnFunctions(tileLayers, isNGP, gameMode);

  // Step 4: Scan each PW
  const poisByPW: Record<string, POI[]> = {};
  const pixelScenesByPW: Record<string, PixelScene[]> = {};
  const perks: Record<string, any> = {}; // No perks active by default

  // Pre-load telescope modules needed for wand naming (avoid repeated dynamic imports in loop)
  const telescopeMods = await import("./telescope-exports");
  const { NollaPrng } = telescopeMods.nollaPrngMod;
  const { GUN_NAMES } = telescopeMods.wandConfigMod;
  const { getPitBossDrops } = telescopeMods.miscGenMod;

  // Split parallel worlds into main (0) and background (-1, 1, etc)
  const mainWorlds = parallelWorlds.filter((w) => w === 0);
  const backgroundWorlds = parallelWorlds.filter((w) => w !== 0);

  // Dispatch background worlds to Web Workers to prevent UI thread lock
  const workerPromises = backgroundWorlds.map((pw) => {
    return new Promise<{ pw: number; pois: any[]; pixelScenes: any[] }>((resolve, reject) => {
      const worker = new PwWorker();
      worker.onmessage = (e) => {
        if (e.data.success) resolve(e.data);
        else reject(new Error(e.data.error || "Worker failed"));
        worker.terminate();
      };
      worker.onerror = (err) => {
        reject(err);
        worker.terminate();
      };
      worker.postMessage({
        biomeData,
        tileSpawns,
        seed,
        ngPlus,
        pw,
        gameMode,
        perks,
        skipCosmeticScenes: false,
        unlocks: dailySeed || opts.unlocks == null ? null : opts.unlocks,
        dailySeed,
      });
    });
  });

  // Synchronously process main worlds (PW 0) for instant UI response
  for (const pw of mainWorlds) {
    const pwKey = `${pw},0`; // vertical PW always 0 for noitamap

    const scanResults = scanSpawnFunctions(
      biomeData,
      tileSpawns,
      seed,
      ngPlus,
      pw,
      0 /* pwVertical */,
      false /* skipCosmeticScenes */,
      perks,
      gameMode,
    );

    const specialPOIs = getSpecialPoIs(biomeData, seed, ngPlus, pw, 0, perks, gameMode);

    pixelScenesByPW[pwKey] = scanResults.finalPixelScenes;

    // Add static pixel scenes (hardcoded positions like pyramid boss, fishing hut, etc.)
    const staticResults = addStaticPixelScenes(seed, ngPlus, pw, 0, biomeData, false, perks, false, gameMode);
    if (staticResults && staticResults.pixelScenes) {
      pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(staticResults.pixelScenes);
    }

    // Also generate for heaven (pwVertical=-1) and hell (pwVertical=+1)
    const verticalPois: POI[] = [];
    for (const pvt of [-1, 1]) {
      // Special POIs for vertical PW (end shops)
      const vtSpecial = getSpecialPoIs(biomeData, seed, ngPlus, pw, pvt, perks, gameMode);
      if (vtSpecial && vtSpecial.length > 0) {
        verticalPois.push(...vtSpecial);
      }

      // Scan spawn functions (same wang tile spawns, offset vertically — matches telescope behavior)
      const vtScan = scanSpawnFunctions(biomeData, tileSpawns, seed, ngPlus, pw, pvt, false, perks, gameMode);
      if (vtScan.generatedSpawns && vtScan.generatedSpawns.length > 0) {
        verticalPois.push(...vtScan.generatedSpawns);
      }
      if (vtScan.finalPixelScenes && vtScan.finalPixelScenes.length > 0) {
        pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(vtScan.finalPixelScenes);
      }

      // Static pixel scenes (sky/hell temples)
      const vtResults = addStaticPixelScenes(seed, ngPlus, pw, pvt, biomeData, false, perks, false, gameMode);
      if (vtResults && vtResults.pixelScenes && vtResults.pixelScenes.length > 0) {
        pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(vtResults.pixelScenes);
      }
      if (vtResults && vtResults.pois && vtResults.pois.length > 0) {
        verticalPois.push(...vtResults.pois);
      }
    }

    // Post-process POIs to fix wand names without modifying library code
    let combinedPois = scanResults.generatedSpawns.concat(specialPOIs);
    if (staticResults && staticResults.pois) {
      combinedPois.push(...staticResults.pois);
    }
    if (verticalPois.length > 0) {
      combinedPois.push(...verticalPois);
    }

    // Orb index -> unlock key mapping (derived from game entity data).
    // Order matches telescope's addOrb() call order = game's orb_id order.
    const ORB_UNLOCK_KEYS = [
      "sea_lava", // orb_00 - Pyramid
      "crumbling_earth", // orb_01 - Floating Island
      "tentacle", // orb_02 - Vault
      "nuke", // orb_03 - Pyramid (Inside) -- NOTE: telescope places Vault before Pyramid Inside
      "necromancy", // orb_04 - Hell
      "bomb_holy", // orb_05 - Snowcave
      "spiral_shot", // orb_06 - Desert
      "cloud_thunder", // orb_07 - Nuke (location name)
      "firework", // orb_08 - Orb 1
      "exploding_deer", // orb_09 - Orb 2
      "material_cement", // orb_10 - Orb 3
    ];
    if (pw === 0 && biomeData.orbs && Array.isArray(biomeData.orbs)) {
      // Daily seed: never mark collected — always show orbs with spells inside
      const unlockSet = !dailySeed && opts.unlocks ? new Set(opts.unlocks) : null;
      for (let i = 0; i < biomeData.orbs.length; i++) {
        const orb = biomeData.orbs[i];
        const unlockKey = ORB_UNLOCK_KEYS[i] || null;
        const collected = unlockSet && unlockKey ? unlockSet.has(unlockKey) : false;
        combinedPois.push({
          ...orb,
          type: "item",
          item: "orb",
          name: orb.name,
          orbIndex: i,
          unlockKey,
          collected,
          x: orb.x * 512 + 256 - 32 * 512,
          y: orb.y * 512 + 256 - 14 * 512,
        });
      }
    }
    // Add friend boss at the correct friend cave
    if (pw === 0) {
      const pwOffsetX = pw * 512 * 70;
      const friendRoomPositions = [
        { x: 6 * 512 + pwOffsetX, y: 11 * 512 },
        { x: 8 * 512 + pwOffsetX, y: 19 * 512 },
        { x: -10 * 512 + pwOffsetX, y: 9 * 512 },
        { x: -21 * 512 + pwOffsetX, y: 8 * 512 },
        { x: -22 * 512 + pwOffsetX, y: 22 * 512 },
        { x: -10 * 512 + pwOffsetX, y: 25 * 512 },
      ];
      const friendPrng = new NollaPrng(0);
      friendPrng.SetRandomSeed(seed + ngPlus, 24, 32);
      const friendRoom = friendPrng.Random(1, 6);
      const pos = friendRoomPositions[friendRoom - 1];
      if (!combinedPois.some((p: any) => p.type === "friend")) {
        combinedPois.push({
          type: "friend",
          name: "Toveri",
          x: pos.x + 256,
          y: pos.y + 256,
          biome: `friend_${friendRoom}`,
          // The friend cave renders the `cavern` pixel scene, which already
          // contains Toveri's sprite. Drawing the enemy:friend marker on top
          // doubles it — so this is a clickOnly hit target (card opens on
          // click; no second sprite painted on map or baked into the DZI).
          clickOnly: true,
          items: [{ type: "item", item: "full_heal", name: "Full Health Regeneration" }],
        } as any);
      }

      // Offset gourd down so it doesn't overlap the friend boss
      for (const poi of combinedPois) {
        if (poi.type === "item" && (poi as any).item === "gourd" && (poi as any).biome === `friend_${friendRoom}`) {
          poi.y += 80;
        }
        // Reposition the gourd_room gourd to its real in-world spot (telescope's
        // chunk-center estimate sits too high/left).
        if (poi.type === "item" && (poi as any).item === "gourd" && (poi as any).biome === "gourd_room") {
          poi.x = -16183;
          poi.y = -6272;
        }
        // Paha Silmä (Evil Eye): telescope emits a bare {item:'paha_silma'} with
        // no name. Attach the in-game name key (item_evil_eye -> "Paha Silmä")
        // so the card title and search resolve it instead of showing the raw id.
        if (poi.type === "item" && (poi as any).item === "paha_silma") {
          (poi as any).name = "Paha Silmä";
          (poi as any).nameKey = "item_evil_eye";
        }
      }

      // Add mestari_secret boss (boss_wizard) at mestari_secret orbroom center
      // mestari_secret is at chunk (59, 43) in biome map coordinates
      // World coords: x = (59 - 32) * 512 + 256, y = (43 - 14) * 512 + 256
      combinedPois.push({
        type: "boss_wizard",
        name: "Mestarien mestari",
        x: 12573,
        y: 15178,
        biome: "mestari_secret",
        items: [
          { type: "item", item: "wandstone", nameKey: "item_wandstone", name: "Sauvan Ydin" },
          { type: "item", item: "spell", spell: "RESET" },
          { type: "item", item: "spell", spell: "ADD_TRIGGER" },
          { type: "item", item: "spell", spell: "ADD_TIMER" },
          { type: "item", item: "spell", spell: "ADD_DEATH_TRIGGER" },
          { type: "item", item: "spell", spell: "DUPLICATE" },
        ],
      } as any);

      // "A Cunning Contraption" (booktitle_mestari) sits in the mestari_secret
      // room as a standalone world item, NOT a boss drop — own clickable POI.
      combinedPois.push({
        type: "item",
        item: "book",
        nameKey: "booktitle_mestari",
        name: "A Cunning Contraption",
        wiki: "https://noita.wiki.gg/wiki/Books",
        x: 12573,
        y: 15230,
        biome: "mestari_secret",
      } as any);

      // "Alchemist's Note" (booktitle_fisher): the book inside the lake fisher's
      // hut is painted into the baked background, so it needs no sprite on the
      // map — only an invisible click target (clickOnly) that opens its card.
      combinedPois.push({
        type: "item",
        item: "book",
        clickOnly: true,
        nameKey: "booktitle_fisher",
        name: "Alchemist's Note",
        wiki: "https://noita.wiki.gg/wiki/Books",
        description:
          "Here I'm safe. I am safe.\n" +
          "I left the others behind. And I have locked my research so that only those with real understanding can reach it.\n" +
          "I should not worry. As long as I resist the temptation. I will be safe.\n" +
          "I know my limits. Here I am far away from them.\n" +
          "I should not worry.",
        x: -12440,
        y: 200,
        biome: "lake",
      } as any);

      // Add forgotten (boss_ghost) manually due to lack of telescope coverage
      combinedPois.push({
        type: "boss_ghost",
        name: "Unohdettu",
        x: (9 - 32) * 512 + 256,
        y: (39 - 14) * 512 + 256,
        biome: "boss_arena",
        items: [
          { type: "item", item: "sunseed", name: "Sun Seed" },
          { type: "item", item: "full_heal", name: "Full Health Regeneration" },
        ],
      } as any);

      // Add Kivi (Rock Boss)
      combinedPois.push({
        type: "boss_sky",
        name: "Kivi",
        x: 7300,
        y: -4574,
        biome: "boss_sky",
        items: [{ type: "entity", entity: "playerghost", name: "Kummitus" }],
      } as any);

      // Add Tapion Vasalli (Deer Boss)
      combinedPois.push({
        type: "islandspirit",
        name: "Tapion vasalli",
        x: -13676,
        y: 57,
        biome: "lake_island",
        icon: "assets/icons/bosses/deer.png",
        items: [{ type: "item", item: "spell", spell: "MASS_POLYMORPH" }],
      } as any);

      // Add Kolmisilmä (Kolmi)
      combinedPois.push({
        type: "boss_centipede",
        name: "Kolmisilmä",
        x: 3556,
        y: 13026,
        biome: "boss_arena",
        items: [{ type: "entity", entity: "boss_centipede_sampo", name: "Sampo", x: 3555, y: 13050 }],
      } as any);

      // Add Mecha Kolmi
      combinedPois.push({
        type: "boss_robot",
        name: "Kolmisilmän Koipi",
        x: 13987,
        y: 11123,
        biome: "boss_arena",
        items: [{ type: "item", item: "perk", perk: "map", name: "Spatial Awareness" }],
      } as any);

      // Moon Radar: a fixed-location perk pickup in the "???" room east of the
      // Overgrown Cavern. Flagged not_in_default_perk_pool in telescope's
      // perks.js, so it never appears in a generated Holy Mountain deck and
      // telescope emits no POI for it — add it here at its fixed world spot.
      combinedPois.push({
        type: "item",
        item: "perk",
        perk: "moon_radar",
        x: 16128,
        y: 3332,
        biome: "moon_room",
        fixed: true,
      } as any);

      // Add Meat Boss (Kolmisilmän sydän)
      combinedPois.push({
        type: "boss_meat",
        name: "Kolmisilmän sydän",
        x: 6915,
        y: 8448,
        biome: "boss_arena",
        items: [{ type: "wand", sprite: "custom/chainsaw", name: "Saha" }],
      } as any);

      // Add Syväolento (Leviathan / Levi boss). No body sprite exists in the
      // atlas (only eye/orb parts), so the eye (last open frame) IS the boss
      // marker. Placed at the eye's in-world position; clicking it opens the
      // Syväolento card.
      combinedPois.push({
        type: "boss_fish",
        name: "Syväolento",
        x: -13967,
        y: 10029,
        biome: "lake",
        items: [
          { type: "item", item: "full_heal", name: "Full Health Regeneration" },
          { type: "item", item: "great_chest", nameKey: "item_chest_treasure_super", name: "Great Treasure Chest" },
        ],
      } as any);

      // Add Squidward / Pit Boss (Sauvojen tuntija). Telescope computes the two
      // wands (Tier 5 unshuffle + Tier 6); the two spells (Matosade/Worm Rain,
      // Meteorisade/Meteor Rain) and the first-kill Full Health Regeneration are
      // fixed drops, not RNG, so they're appended here. full_heal -> item:heart
      // (the plain, no-extra-HP heart sprite).
      const pitDrops = getPitBossDrops(seed, ngPlus, "orb_room_bridge", 3750, 1100, perks);
      combinedPois.push({
        type: "boss_pit",
        name: "Sauvojen tuntija",
        x: 3750,
        y: 1100,
        biome: "orb_room_bridge",
        items: [
          ...pitDrops.items,
          { type: "item", item: "spell", spell: "WORM_RAIN", x: 3726, y: 1140 },
          { type: "item", item: "spell", spell: "METEOR_RAIN", x: 3774, y: 1140 },
          { type: "item", item: "full_heal", name: "Full Heal (On first kill)", x: 3750, y: 1160 },
        ],
      } as any);

      // Telescope's addStaticPixelScenes already emits the Tiny / Limatoukka
      // (Slime Maggot) drop POI natively (static_spawns.js, type "tiny" at
      // ~14941,16454). It was previously invisible because "tiny" had no sprite
      // / container handling; now that it renders, just tag it with a name for
      // search instead of pushing a second copy.
      for (const p of combinedPois) {
        if (p.type === "tiny" && !(p as any).name) (p as any).name = "Limatoukka";
      }

      // Telescope emits the pyramid boss drop for every vertical call
      // (pvt = -1, 0, +1) because its guard checks pwIndex === 0 but not
      // pwIndexVertical — so the main world ends up with 3 identical copies.
      // Collapse to one.
      const pyramidPois = combinedPois.filter((p: any) => p.type === "pyramid_boss");
      if (pyramidPois.length > 1) {
        combinedPois = combinedPois.filter((p: any) => p.type !== "pyramid_boss");
        combinedPois.push(pyramidPois[0]);
      }
    }

    // Tower wands (biome solid_wall_tower_10) are spaced 100px apart by
    // telescope to ease interaction. Squeeze them tighter (40px) so the trio
    // reads as one cluster on the map.
    retowerWands(combinedPois);

    // Deduplicate starting_loadout — telescope's addStaticPixelScenes adds
    // one for every (pw,pvt) pair (9 total in non-light mode), but only one
    // makes sense in the rendered map.
    const loadoutPois = combinedPois.filter((p: any) => p.type === "starting_loadout");
    if (loadoutPois.length > 1) {
      combinedPois = combinedPois.filter((p: any) => p.type !== "starting_loadout");
      combinedPois.push(loadoutPois[0]);
    }

    // Deduplicate friend
    const friendPois = combinedPois.filter(
      (p: any) => p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss",
    );
    if (friendPois.length > 0) {
      const keep = friendPois.find((p: any) => p.type === "friend") || friendPois[0];
      combinedPois = combinedPois.filter(
        (p: any) =>
          !(p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss"),
      );
      combinedPois.push(keep);
    }

    // Deduplicate alchemist_boss
    const alchemistPois = combinedPois.filter(
      (p: any) => p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist"),
    );
    if (alchemistPois.length > 0) {
      const keep = alchemistPois.find((p: any) => p.type === "alchemist_boss") || alchemistPois[0];
      combinedPois = combinedPois.filter(
        (p: any) => !(p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist")),
      );
      combinedPois.push(keep);
    }
    for (const poi of combinedPois) {
      if (poi.type === "wand" && (!poi.name || poi.name === "Taikasauva")) {
        if (poi.name === "Taikasauva") (poi as any).isTaikasauva = true;
        const prng = new NollaPrng(0);
        prng.SetRandomSeed(seed + ngPlus, poi.x, poi.y);
        const nameIdx = Math.floor(GUN_NAMES.length * prng.Next());
        poi.name = GUN_NAMES[nameIdx];
      }
    }
    poisByPW[pwKey] = combinedPois;
  }

  // Wait for background worlds to finish
  if (workerPromises.length > 0) {
    console.log(`[Telescope] Waiting for ${workerPromises.length} background parallel worlds...`);
    const workerResults = await Promise.all(workerPromises);
    for (const res of workerResults) {
      const pwKey = `${res.pw},0`;
      let workerPois = res.pois;

      // Apply patches and deduplication for worker POIs exactly as main thread does

      // boss_pit is added once in the pw===0 main block; the native "tiny" only
      // spawns at pwIndex===0 too. Background PWs (-1/+1) should carry neither —
      // strip defensively so a stray copy can't reach the map/search.
      workerPois = workerPois.filter((p: any) => p.type !== "boss_pit" && p.type !== "tiny");

      // Collapse telescope's triplicated pyramid boss (one per vertical call).
      const pyramidPoisWorker = workerPois.filter((p: any) => p.type === "pyramid_boss");
      if (pyramidPoisWorker.length > 1) {
        workerPois = workerPois.filter((p: any) => p.type !== "pyramid_boss");
        workerPois.push(pyramidPoisWorker[0]);
      }

      // Drop starting_loadout from side PWs — only the pw=0 instance is kept
      workerPois = workerPois.filter((p: any) => p.type !== "starting_loadout");

      // Deduplicate friend worker
      const friendPoisWorker = workerPois.filter(
        (p: any) => p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss",
      );
      if (friendPoisWorker.length > 0) {
        const keep = friendPoisWorker.find((p: any) => p.type === "friend") || friendPoisWorker[0];
        workerPois = workerPois.filter(
          (p: any) =>
            !(p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss"),
        );
        workerPois.push(keep);
      }

      // Deduplicate alchemist_boss worker
      const alchemistPoisWorker = workerPois.filter(
        (p: any) => p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist"),
      );
      if (alchemistPoisWorker.length > 0) {
        const keep = alchemistPoisWorker.find((p: any) => p.type === "alchemist_boss") || alchemistPoisWorker[0];
        workerPois = workerPois.filter(
          (p: any) => !(p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist")),
        );
        workerPois.push(keep);
      }

      // Apply NollaPrng logic for Wand generation in background worlds
      for (const poi of workerPois) {
        if (poi.type === "wand" && (!poi.name || poi.name === "Taikasauva")) {
          if (poi.name === "Taikasauva") (poi as any).isTaikasauva = true;
          const prng = new NollaPrng(0);
          prng.SetRandomSeed(seed + ngPlus, poi.x, poi.y);
          const nameIdx = Math.floor(GUN_NAMES.length * prng.Next());
          poi.name = GUN_NAMES[nameIdx];
        }
      }

      // Tighten tower wand spacing for side PWs too.
      retowerWands(workerPois);

      poisByPW[pwKey] = workerPois;
      if (res.pixelScenes) {
        // Worker stripped imgElement before postMessage to avoid FF's slow
        // structured clone of large per-scene byte arrays. Rehydrate from this
        // thread's PIXEL_SCENE_DATA so downstream code (compositing, etc) sees
        // the same shape as before.
        for (const s of res.pixelScenes) {
          if (s && s.imgElement === undefined && s.key && PIXEL_SCENE_DATA?.[s.key]) {
            s.imgElement = PIXEL_SCENE_DATA[s.key].imgElement || null;
          }
        }
        if (!pixelScenesByPW[pwKey]) pixelScenesByPW[pwKey] = [];
        pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(res.pixelScenes);
      }
    }
  }

  // Crystal-Key chests + other fixed world-item markers that the public map's
  // static "Items" overlay shows but telescope never emits. One of each per
  // parallel world (same local coords, shifted by the PW stride). Done here in
  // the noitamap adapter (NOT the telescope lib) so it covers both the main
  // world and the worker-generated background PWs. Chest contents are the
  // deterministic first-open spell rewards (Noita's chest_dark.lua /
  // chest_light.lua); repeat-open gives 3 frame-RNG picks which are unknowable.
  if (ngPlus === 0) {
    const fixedItemsMw = getWorldSize(isNGP, gameMode);
    const chestSpells = (ids: string[], x: number, y: number) =>
      ids.map((s, i) => ({ type: "item", item: "spell", spell: s, x: x + i * 12, y }));
    for (const pw of parallelWorlds) {
      const pwKey = `${pw},0`;
      if (!poisByPW[pwKey]) continue;
      const pwOffsetX = pw * fixedItemsMw * 512;
      const darkX = 3840 + pwOffsetX;
      const darkY = 15599;
      poisByPW[pwKey].push({
        type: "chest",
        chestVariant: "dark",
        nameKey: "item_chest_dark",
        name: "Dark chest",
        x: darkX,
        y: darkY,
        biome: "lavacave",
        items: chestSpells(
          ["ALL_ACID", "ALL_NUKES", "ALL_DISCS", "ALL_ROCKETS", "ALL_BLACKHOLES", "ALL_DEATHCROSSES"],
          darkX,
          darkY,
        ),
      } as any);
      const coralX = 11519 + pwOffsetX;
      const coralY = -4886;
      poisByPW[pwKey].push({
        type: "chest",
        chestVariant: "coral",
        nameKey: "item_chest_light",
        name: "Coral chest",
        x: coralX,
        y: coralY,
        biome: "desert",
        items: chestSpells(["DIVIDE_2", "DIVIDE_3", "DIVIDE_4", "BURST_8", "BURST_X"], coralX, coralY),
      } as any);
      poisByPW[pwKey].push({
        type: "item",
        item: "musicstone",
        nameKey: "item_musicstone",
        name: "Kuulokivi",
        x: -3324 + pwOffsetX,
        y: 3328,
        biome: "mountain_tree",
      } as any);
      poisByPW[pwKey].push({
        type: "item",
        item: "karl",
        name: "Karl",
        x: 3239 + pwOffsetX,
        y: 2400,
        biome: "snowcave",
      } as any);
      // Overworld Music Machines (music boxes). Telescope only registers the
      // spawn pixel for snowchasm, so the overworld ones are never emitted —
      // add them here. No in-game name key exists for the prop, so plain labels.
      // Tweak this single offset to nudge every music machine's marker until the
      // alignment looks right (x = right, y = up is negative).
      const musicMachineLocalAlignmentFix = { x: 13, y: -5 };
      const mmx = musicMachineLocalAlignmentFix.x;
      const mmy = musicMachineLocalAlignmentFix.y;
      poisByPW[pwKey].push({
        type: "item",
        item: "music_machine",
        name: "Music Machine (Pond)",
        x: 2799 + pwOffsetX + mmx,
        y: 282 + mmy,
        biome: "lake",
      } as any);
      poisByPW[pwKey].push({
        type: "item",
        item: "music_machine",
        name: "Music Machine (Lake)",
        x: -12188 + pwOffsetX + mmx,
        y: -385 + mmy,
        biome: "lake",
      } as any);
      poisByPW[pwKey].push({
        type: "item",
        item: "music_machine",
        name: "Music Machine (Tree)",
        x: -1919 + pwOffsetX + mmx,
        y: -1366 + mmy,
        biome: "mountain_tree",
      } as any);
      poisByPW[pwKey].push({
        type: "item",
        item: "music_machine",
        name: "Music Machine (Desert)",
        x: 14678 + pwOffsetX + mmx,
        y: -35 + mmy,
        biome: "desert",
      } as any);

      // Altar-sacrifice props (Pillar of Sacrifice & Transformation). These are
      // game-side biome/structure props the telescope scanner never emits, so
      // place them statically. Coords are pw-local + pwOffsetX. Sprites already
      // baked into the atlas (enemy:physics_worm_deflector_crystal, etc.).

      // Worm Crystal (worm deflector): one per Holy Mountain altar. The altar
      // anchors are templeX/templeY (temple_generation.js, already noitamap world
      // coords — the same values the shop/pacifist-chest POIs use). The deflector
      // pixel sits at the altar centre, crystal at pixel + 5y (temple_altar.lua:219).
      const HM_TEMPLE_X = [-32, -32, -32, -32, -32, -32, 2560];
      const HM_TEMPLE_Y = [1410, 2946, 4994, 6530, 8578, 10626, 13181];
      // Nudge to align the crystal/statue markers with the baked altar art.
      const wormFix = { x: -280, y: 45 };
      for (let hm = 0; hm < HM_TEMPLE_X.length; hm++) {
        poisByPW[pwKey].push({
          type: "item",
          item: "worm_crystal",
          nameKey: "building_worm_deflector",
          name: "Worm crystal",
          x: HM_TEMPLE_X[hm] + pwOffsetX + wormFix.x,
          y: HM_TEMPLE_Y[hm] + wormFix.y,
          biome: "temple_altar",
        } as any);
        // Greed-Cursed Crystal: spawns at the HM statue when the greed curse is
        // active (temple_altar_left.lua:233). Always shown here per design.
        poisByPW[pwKey].push({
          type: "item",
          item: "greed_crystal",
          nameKey: "item_greed_crystal",
          name: "Greed-Cursed Crystal",
          x: HM_TEMPLE_X[hm] + pwOffsetX + wormFix.x,
          y: HM_TEMPLE_Y[hm] + wormFix.y - 48,
          biome: "temple_altar",
        } as any);
      }
    }

    // Hand Statues (Munkki spawners): snowcave init() picks 8 positions seeded by
    // the world seed within x:[-2350,2350], y:[3140,4500] and loads
    // statue_hand.png at (pos-22) (snowcave.lua:1068-1088). Reproduce the same
    // ProceduralRandomi draws so the positions match the seed exactly. These do
    // NOT spawn in parallel worlds (wiki: Munkki), so main world (pw 0) only.
    {
      const handPrng = new NollaPrng(0);
      for (let i = 1; i <= 8; i++) {
        const px = handPrng.ProceduralRandomi(seed, 109, i * 53, -2350, 2350);
        const py = handPrng.ProceduralRandomi(seed, 111, i * 2.9, 3140, 4500);
        poisByPW["0,0"]?.push({
          type: "item",
          item: "statue_hand",
          name: "Hand statue",
          wiki: "https://noita.wiki.gg/wiki/Munkki",
          x: px,
          y: py,
          biome: "snowcave",
        } as any);
      }
    }

    // Sun Rock / Dark Sun Rock: spawned at the Scales when progress_sun /
    // progress_darksun are set (scale.lua). Daily = everything unlocked, so both
    // appear. Single fixed overworld coord (the Scales, structures.json).
    poisByPW["0,0"]?.push({
      type: "item",
      item: "sun_rock",
      name: "Sunstone",
      wiki: "https://noita.wiki.gg/wiki/Celestial_Scale",
      x: 13030,
      y: 8,
      biome: "wandcave",
    } as any);
    poisByPW["0,0"]?.push({
      type: "item",
      item: "darksun_rock",
      name: "Dark Sunstone",
      wiki: "https://noita.wiki.gg/wiki/Celestial_Scale",
      x: 13090,
      y: 8,
      biome: "wandcave",
    } as any);

    // Iron (steel) chest containing the Essence of Earth (EoE). Fixed
    // main-world spawn the telescope scanner never emits — place it statically.
    poisByPW["0,0"]?.push({
      type: "chest",
      chestVariant: "steel",
      name: "Iron chest",
      x: -5035,
      y: 157,
      biome: "excavationsite",
      items: [{ type: "item", item: "essence", material: "laser", name: "Essence of Earth", nameKey: "item_essence_laser" }],
    } as any);

    // Essence Eaters guarding the overworld essence altars. Absolute world
    // positions (one per parallel world already baked into the coords), so they
    // are placed once each rather than offset inside the PW loop.
    const essenceEaters: Array<[number, number]> = [
      [12569, 16],
      [23783, 16],
      [-23783, 16], // desert EEs (PW 0 / +1 / -1)
      [48925, 4], // desert EE (far east)
      [-6883, -169],
      [29469, -174],
      [-43235, -174], // snow-wasteland EEs (PW 0 / +1 / -1)
    ];
    for (const [ex, ey] of essenceEaters) {
      poisByPW["0,0"]?.push({
        type: "item",
        item: "essence_eater",
        nameKey: "item_essence_stone",
        name: "Essence Eater",
        x: ex,
        y: ey,
        biome: "desert",
      } as any);
    }

    // Emerald Tablets (orb-room lore books). The orbs themselves render on the
    // dynamic map from data/orbs.json (biomeData.orbs is empty on NG), and each
    // orbroom_NN.lua spawns book_NN at (orb - 30, orb + 40). So derive one
    // Emerald Tablet POI per dynamic-map orb directly from orbs.json. The orb's
    // icon index (orb_NN.png) maps to its volume title (booktitleNN in common.csv).
    for (const orb of orbsData as any[]) {
      if (!orb.maps || !orb.maps.includes("dynamic-main-branch")) continue;
      const idxMatch = String(orb.icon || "").match(/orb_(\d+)\.png/);
      const titleKey = idxMatch ? `booktitle${idxMatch[1]}` : undefined;
      // Per-orb spawn nudges where the generic (orb-30, +40) offset lands wrong.
      const isSeaOfLava = String(orb.name || "").includes("Sea of Lava");
      poisByPW["0,0"]?.push({
        type: "item",
        item: "emerald_tablet",
        name: orb.name ? `Emerald Tablet (${String(orb.name).replace(/^Orb:\s*/, "")})` : "Emerald Tablet",
        titleKey,
        wiki: "https://noita.wiki.gg/wiki/Emerald_Tablet",
        x: orb.x - 30 + (isSeaOfLava ? 10 : 0),
        y: orb.y + 40 + (isSeaOfLava ? -10 : 0),
        biome: "orb_room",
      } as any);
    }

    // Lava-lake Emerald Tablet ("Tabula Smaragdina", book_corpse). Spawned by the
    // lavalake static scene, not orbs.json — placed explicitly at the world coord.
    poisByPW["0,0"]?.push({
      type: "item",
      item: "emerald_tablet",
      name: "Emerald Tablet (Lava lake)",
      titleKey: "booktitle_corpse",
      wiki: "https://noita.wiki.gg/wiki/Emerald_Tablet",
      x: 2337,
      y: 843,
      biome: "lavalake",
    } as any);

    // Tree Emerald Tablet ("Secretorum Hermetis", book_tree). Spawned by the
    // mountain_tree static scene (mountain_tree.lua spawn_book), not orbs.json.
    poisByPW["0,0"]?.push({
      type: "item",
      item: "emerald_tablet",
      name: "Emerald Tablet (Tree)",
      titleKey: "booktitle_tree",
      wiki: "https://noita.wiki.gg/wiki/Emerald_Tablet",
      x: -1328,
      y: -156,
      biome: "mountain_tree",
    } as any);

    // Achievement Pillars (mountain_tree.lua spawn_pillars): 6 pillars built
    // from per-achievement segments. Daily / no-mod -> everything unlocked
    // (full colour). Mod with the dedicated pillar channel (opts.pillarFlags,
    // `&p=`) -> exact per-achievement state. Older mod / `&u=`-only -> coarse
    // spell-key inference (FLAG_TO_UNLOCK_KEY). Anchored at items.json "Pillars".
    {
      const isUnlocked = dailySeed
        ? () => true
        : opts.pillarFlags != null
          ? makePillarUnlockPredicateFromFlags(opts.pillarFlags)
          : makePillarUnlockPredicate(opts.unlocks ?? null);
      for (const seg of buildPillarSegments(PILLAR_BASE.x, PILLAR_BASE.y, isUnlocked)) {
        poisByPW["0,0"]?.push(seg as any);
      }
    }
  }

  // Inject temple foreground pixel scenes for heaven/hell across ALL parallel worlds.
  // addStaticPixelScenes skips chunk-based scenes when pwIndexVertical !== 0,
  // so Spirited (potion_mimics) and Ominous (darkness) temple foregrounds
  // never get generated. We scan biomeData.pixels directly and create pixel
  // scene entries whose keys match the _fg.png index in data.zip.
  // Scale wang pixel dimensions (TILE_SIZE=10) to match main-world wang renderer output.
  const TEMPLE_BIOME_COLORS: Record<number, { key: string; name: string; w: number; h: number }> = {
    0xffff00fe: { key: "static_tile/temples-assets/potion_mimics", name: "potion_mimics", w: 1530, h: 1540 },
    0xffff00fd: { key: "static_tile/temples-assets/darkness", name: "darkness", w: 1530, h: 940 },
  };
  const templeMw = getWorldSize(ngPlus > 0, gameMode);
  for (const pw of parallelWorlds) {
    const pwKey = `${pw},0`;
    if (!pixelScenesByPW[pwKey]) pixelScenesByPW[pwKey] = [];
    for (const pvt of [-1, 1]) {
      // Only place one image per temple type (they span multiple biome chunks)
      const placed = new Set<number>();
      for (let by = 0; by < 48; by++) {
        for (let bx = 0; bx < templeMw; bx++) {
          const biomeColor = biomeData.pixels[by * templeMw + bx];
          const templeInfo = TEMPLE_BIOME_COLORS[biomeColor];
          if (!templeInfo || placed.has(biomeColor)) continue;
          placed.add(biomeColor);
          const chunkX = bx * 512 - templeMw * 256 + pw * templeMw * 512;
          const chunkY = by * 512 - 14 * 512 + pvt * 48 * 512;
          pixelScenesByPW[pwKey].push({
            imgElement: null as any,
            x: chunkX,
            y: chunkY,
            width: templeInfo.w,
            height: templeInfo.h,
            name: templeInfo.name,
            key: templeInfo.key,
          });
        }
      }
    }
  }

  // Step 5: Eye messages (main world only)
  const eyes = findEyeMessages(biomeData.pixels, seed, ngPlus);

  // Essence rooms (Essence of Earth/Air/Water/Spirits). These are fixed
  // biome-map rooms (hasStuff:false) so telescope never emits a POI for them.
  // Scan biomeData.pixels for the four essence biome colors and place one POI
  // at the chunk center of each. (Fire essence only exists at NG+ essence
  // altars, not as a biome room, so it is not emitted here.) Main world only.
  {
    const essMw = getWorldSize(isNGP, gameMode);
    const ESSENCE_COLORS: Record<number, { material: string; name: string; wiki: string }> = {
      0xff157cb0: {
        material: "laser",
        name: "Essence of Earth",
        wiki: "https://noita.wiki.gg/wiki/Essences#Essence_of_Earth",
      },
      0xff157cb8: {
        material: "air",
        name: "Essence of Air",
        wiki: "https://noita.wiki.gg/wiki/Essences#Essence_of_Air",
      },
      0xff157cb5: {
        material: "water",
        name: "Essence of Water",
        wiki: "https://noita.wiki.gg/wiki/Essences#Essence_of_Water",
      },
      0xff157cb6: {
        material: "alcohol",
        name: "Essence of Spirits",
        wiki: "https://noita.wiki.gg/wiki/Essences#Essence_of_Spirits",
      },
    };
    const mainKey = "0,0";
    if (poisByPW[mainKey]) {
      const seen = new Set<number>();
      for (let by = 0; by < 48; by++) {
        for (let bx = 0; bx < essMw; bx++) {
          const color = biomeData.pixels[by * essMw + bx] >>> 0;
          const info = ESSENCE_COLORS[color];
          if (!info || seen.has(color)) continue;
          seen.add(color);
          poisByPW[mainKey].push({
            type: "item",
            item: "essence",
            material: info.material,
            name: info.name,
            wiki: info.wiki,
            x: bx * 512 + 256 - essMw * 256,
            y: by * 512 + 256 - 14 * 512,
          } as any);
        }
      }
      // Essence of Fire is not a biome room (so the scan above misses it); it
      // sits at a fixed overworld essence-altar spot. Add it explicitly.
      poisByPW[mainKey].push({
        type: "item",
        item: "essence",
        material: "fire",
        name: "Essence of Fire",
        wiki: "https://noita.wiki.gg/wiki/Essences#Essence_of_Fire",
        x: -14062,
        y: 370,
      } as any);
    }
  }

  // Generated Holy Mountain perks (new game only; PWs -1/0/1). Only the main
  // world (pw 0) shows concrete perks: the perk deck index is a single global
  // counter that advances in the order Holy Mountains are actually visited, and
  // the east/west worlds are reached by horizontal travel, so their perks
  // depend on the player's (unknowable) travel history. For pw -1/+1 we still
  // emit one POI per perk slot at the correct positions, but flagged `unknown`
  // so the UI shows an "unidentified" marker + an explanatory message instead
  // of a wrong (mirrored) perk. perkPickups={} = no-pickup vanilla layout.
  if (ngPlus === 0) {
    const { getAllTemplePerks } = telescopeMods.perksMod;
    for (const pw of parallelWorlds) {
      if (pw < -1 || pw > 1) continue; // middle + immediate east/west only
      const pwKey = `${pw},0`;
      if (!poisByPW[pwKey]) poisByPW[pwKey] = [];
      const { allTemplePerks } = getAllTemplePerks(seed, 0, pw, null, {}, gameMode);
      allTemplePerks.forEach((templePerks: any[], templeIndex: number) => {
        // East/west parallel worlds don't have the 7th (last) Holy Mountain,
        // so there are no perks to generate there.
        if (pw !== 0 && templeIndex >= 6) return;
        for (const p of templePerks) {
          if (pw !== 0) {
            // Side worlds: position is known, identity is not (travel-order
            // dependent). Emit a placeholder per slot.
            poisByPW[pwKey].push({
              type: "item",
              item: "perk",
              unknown: true,
              x: p.x,
              y: p.y,
              biome: "holy_mountain",
            } as any);
            continue;
          }
          if (!p.perk) continue;
          poisByPW[pwKey].push({
            type: "item",
            item: "perk",
            perk: p.perk,
            x: p.x,
            y: p.y,
            biome: "holy_mountain",
            alwaysCast: p.alwaysCast,
            hypotheticalGamble: p.hypotheticalGamble,
          } as any);
        }
      });
    }
  }

  const t1 = performance.now();
  console.log(`[Telescope] Generation complete in ${((t1 - t0) / 1000).toFixed(2)}s`);

  return {
    seed,
    ngPlus,
    isNGP,
    worldSize,
    worldCenter,
    tileLayers,
    biomeData,
    poisByPW,
    pixelScenesByPW,
    eyes,
    parallelWorlds,
  };
}
