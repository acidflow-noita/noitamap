/**
 * telescope-adapter.ts
 *
 * Main adapter that wraps telescope's generation pipeline into a clean
 * async API for noitamap.
 */

import { installTelescopeShim } from "./telescope-dom-shim";
import {
  installFetchInterceptor,
  installImageSrcInterceptor,
} from "./telescope-data-bridge";
import { getDataZip } from "../data-archive";
import { clearCache } from "./tile-cache";
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
}

// ─── State ──────────────────────────────────────────────────────────────────

let initialized = false;
let initPromise: Promise<void> | null = null;
let biomeAssets: { ng0: Uint32Array | null; ngp: Uint32Array | null; nightmare: Uint32Array | null } = { ng0: null, ngp: null, nightmare: null };

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

  // 4b. Push our shim settings into telescope's centralized appSettings.
  //     Telescope refactored from reading DOM checkboxes directly to using
  //     an appSettings object (settings.js). Without this call, clearSpawnPixels
  //     defaults to false and spawn pixels reappear on the map.
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

  generateBiomeData = biomeGenMod.generateBiomeData;
  BIOME_CONFIG = biomeGenMod.BIOME_CONFIG;
  generateBiomeTiles = tileGenMod.generateBiomeTiles;
  scanSpawnFunctions = poiScannerMod.scanSpawnFunctions;
  getSpecialPoIs = poiScannerMod.getSpecialPoIs;
  prescanSpawnFunctions = poiScannerMod.prescanSpawnFunctions;
  PIXEL_SCENE_DATA = pixelSceneMod.PIXEL_SCENE_DATA;
  loadPixelSceneData = pixelSceneMod.loadPixelSceneData;
  recolorPixelSceneForBiome = pixelSceneMod.recolorPixelSceneForBiome;
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
  const LIB_VERSION = "2026-04-01-orb-unlocks";
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

  // Set unlocks: daily seed = ALL ON, otherwise use provided unlocks (empty = nothing unlocked)
  if (dailySeed) {
    setUnlocks(Object.keys(UNLOCKABLES));
  } else {
    setUnlocks(opts.unlocks || []);
  }

  // World dimensions
  const worldSize = getWorldSize(isNGP, gameMode);
  const worldCenter = getWorldCenter(isNGP, gameMode);
  const useNGPDimensions = isNGP || gameMode === "nightmare";
  const w = useNGPDimensions ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
  const h = useNGPDimensions ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;
  const base = isNGP ? biomeAssets.ngp : (gameMode === "nightmare" ? biomeAssets.nightmare : biomeAssets.ng0);

  if (!base) throw new Error("[Telescope] Biome map assets not loaded");

  // Step 1: Generate biome data
  const biomeData = generateBiomeData(seed, ngPlus, gameMode, base, w, h);

  // Debug: Log all unique colors to see if they match constants
  const uniqueColors = new Set(Array.from(biomeData.pixels));
  console.log("[Telescope Debug] Unique colors in biomeData:", Array.from(uniqueColors).map((c: any) => "0x" + (c >>> 0).toString(16).padStart(8, '0')));

  // Fix: Ensure alpha is set. The library might return signed or unsigned depending on bits.
  for (let i = 0; i < biomeData.pixels.length; i++) {
    biomeData.pixels[i] = (biomeData.pixels[i] | 0xFF000000) >>> 0;
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
        skipCosmeticScenes: false
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
      const vtScan = scanSpawnFunctions(
        biomeData, tileSpawns, seed, ngPlus, pw, pvt,
        false, perks, gameMode,
      );
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
      "sea_lava",        // orb_00 - Pyramid
      "crumbling_earth", // orb_01 - Floating Island
      "tentacle",        // orb_02 - Vault
      "nuke",            // orb_03 - Pyramid (Inside) -- NOTE: telescope places Vault before Pyramid Inside
      "necromancy",      // orb_04 - Hell
      "bomb_holy",       // orb_05 - Snowcave
      "spiral_shot",     // orb_06 - Desert
      "cloud_thunder",   // orb_07 - Nuke (location name)
      "firework",        // orb_08 - Orb 1
      "exploding_deer",  // orb_09 - Orb 2
      "material_cement", // orb_10 - Orb 3
    ];
    if (pw === 0 && biomeData.orbs && Array.isArray(biomeData.orbs)) {
      // Daily seed: never mark collected — always show orbs with spells inside
      const unlockSet = (!dailySeed && opts.unlocks) ? new Set(opts.unlocks) : null;
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
          items: [{item: "Full Health Regeneration"}],
        } as any);
      }

      // Offset gourd down so it doesn't overlap the friend boss
      for (const poi of combinedPois) {
        if (poi.type === "item" && (poi as any).item === "gourd" && (poi as any).biome === `friend_${friendRoom}`) {
          poi.y += 80;
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
        items: [{item: "Sauvan Ydin (Wand Core)"}, {item: "Book: A Cunning Contraption"}, {item: "Spell: Wand Refresh"}, {item: "Spell: Add Trigger"}, {item: "Spell: Add Timer"}, {item: "Spell: Add Expiration Trigger"}, {item: "Spell: Spell Duplication"}],
      } as any);

      // Add forgotten (boss_ghost) manually due to lack of telescope coverage
      combinedPois.push({
        type: "boss_ghost",
        name: "Unohdettu",
        x: (9 - 32) * 512 + 256,
        y: (39 - 14) * 512 + 256,
        biome: "boss_arena",
        items: [{item: "Sun Seed"}, {item: "Full Health Regeneration"}],
      } as any);

      // Add Kivi (Rock Boss)
      combinedPois.push({
        type: "boss_sky",
        name: "Kivi",
        x: 7300,
        y: -4574,
        biome: "boss_sky",
        items: [{item: "Kummitus"}],
      } as any);

      // Add Tapion Vasalli (Deer Boss)
      combinedPois.push({
        type: "islandspirit",
        name: "Tapion vasalli",
        x: -13676,
        y: 57,
        biome: "lake_island",
        icon: "assets/icons/bosses/deer.png",
        items: [{item: "Spell: Muodonmuutos"}],
      } as any);

      // Add Kolmisilmä (Kolmi)
      combinedPois.push({
        type: "boss_centipede",
        name: "Kolmisilmä",
        x: 3556,
        y: 13026,
        biome: "boss_arena",
        items: [{item: "boss_centipede_sampo"}],
      } as any);

      // Add Mecha Kolmi
      combinedPois.push({
        type: "boss_robot",
        name: "Kolmisilmän Koipi",
        x: 13987,
        y: 11123,
        biome: "boss_arena",
        items: [{item: "Spell: Spatial Awareness"}],
      } as any);

      // Add Meat Boss (Kolmisilmän sydän)
      combinedPois.push({
        type: "boss_meat",
        name: "Kolmisilmän sydän",
        x: 6915,
        y: 8448,
        biome: "boss_arena",
        items: [{item: "Experimental Wand (Saha)"}],
      } as any);

      // Add Squidward / Pit Boss (Sauvojen tuntija)
      combinedPois.push({
        type: "boss_pit",
        name: "Sauvojen tuntija",
        x: 3750, 
        y: 1100,
        biome: "orb_room_bridge",
        items: [{item: "Wand (Tier 10)"}],
      } as any);
    }

    // Deduplicate friend
    const friendPois = combinedPois.filter((p: any) => p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss");
    if (friendPois.length > 0) {
      const keep = friendPois.find((p: any) => p.type === "friend") || friendPois[0];
      combinedPois = combinedPois.filter((p: any) => !(p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss"));
      combinedPois.push(keep);
    }

    // Deduplicate alchemist_boss
    const alchemistPois = combinedPois.filter((p: any) => p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist"));
    if (alchemistPois.length > 0) {
      const keep = alchemistPois.find((p: any) => p.type === "alchemist_boss") || alchemistPois[0];
      combinedPois = combinedPois.filter((p: any) => !(p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist")));
      combinedPois.push(keep);
    }
    for (const poi of combinedPois) {
      if (poi.type === "wand" && (!poi.name || poi.name === "Taikasauva")) {
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
      
      // Boss overrides for worker
      const pitBossIndexWorker = workerPois.findIndex(
        (p: any) =>
          p.x === 3750 &&
          (p.type === "boss_pit" || p.name === "Pit boss" || p.name?.includes("tuntija") || p.item?.includes("tuntija")),
      );
      if (pitBossIndexWorker !== -1) {
        workerPois.splice(pitBossIndexWorker, 1);
        workerPois.push({
          pw: res.pw,
          type: "boss_pit",
          name: "Sauvojen tuntija",
          x: 3750, 
          y: 1100,
          biome: "orb_room_bridge",
          items: [{item: "Wand (Tier 10)"}],
        } as any);
      } else {
        workerPois.push({
          pw: res.pw,
          type: "boss_pit",
          name: "Sauvojen tuntija",
          x: 3750, 
          y: 1100,
          biome: "orb_room_bridge",
          items: [{item: "Wand (Tier 10)"}],
        } as any);
      }

      // Deduplicate friend worker
      const friendPoisWorker = workerPois.filter((p: any) => p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss");
      if (friendPoisWorker.length > 0) {
        const keep = friendPoisWorker.find((p: any) => p.type === "friend") || friendPoisWorker[0];
        workerPois = workerPois.filter((p: any) => !(p.type === "friend" || (p.type === "entity" && p.entity === "friend") || p.type === "friend_boss"));
        workerPois.push(keep);
      }

      // Deduplicate alchemist_boss worker
      const alchemistPoisWorker = workerPois.filter((p: any) => p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist"));
      if (alchemistPoisWorker.length > 0) {
        const keep = alchemistPoisWorker.find((p: any) => p.type === "alchemist_boss") || alchemistPoisWorker[0];
        workerPois = workerPois.filter((p: any) => !(p.type === "alchemist_boss" || (p.type === "entity" && p.entity === "boss_alchemist")));
        workerPois.push(keep);
      }

      // Apply NollaPrng logic for Wand generation in background worlds
      for (const poi of workerPois) {
        if (poi.type === "wand" && (!poi.name || poi.name === "Taikasauva")) {
          const prng = new NollaPrng(0);
          prng.SetRandomSeed(seed + ngPlus, poi.x, poi.y);
          const nameIdx = Math.floor(GUN_NAMES.length * prng.Next());
          poi.name = GUN_NAMES[nameIdx];
        }
      }

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

  // Inject temple foreground pixel scenes for heaven/hell across ALL parallel worlds.
  // addStaticPixelScenes skips chunk-based scenes when pwIndexVertical !== 0,
  // so Spirited (potion_mimics) and Ominous (darkness) temple foregrounds
  // never get generated. We scan biomeData.pixels directly and create pixel
  // scene entries whose keys match the _fg.png index in data.zip.
  // Scale wang pixel dimensions (TILE_SIZE=10) to match main-world wang renderer output.
  const TEMPLE_BIOME_COLORS: Record<number, { key: string; name: string; w: number; h: number }> = {
    0xffff00fe: { key: 'static_tile/temples-assets/potion_mimics', name: 'potion_mimics', w: 1530, h: 1540 },
    0xffff00fd: { key: 'static_tile/temples-assets/darkness', name: 'darkness', w: 1530, h: 940 },
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
