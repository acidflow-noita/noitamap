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

// Telescope modules
let generateBiomeData: any;
let BIOME_CONFIG: any;
let generateBiomeTiles: any;
let scanSpawnFunctions: any;
let getSpecialPoIs: any;
let prescanSpawnFunctions: any;
let PIXEL_SCENE_DATA: any;
let loadPixelSceneData: any;
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
}

// ─── State ──────────────────────────────────────────────────────────────────

let initialized = false;
let biomeAssets: { ng0: Uint32Array | null; ngp: Uint32Array | null } = { ng0: null, ngp: null };

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * One-time setup: install DOM shim, fetch interceptor, load base assets.
 * Safe to call multiple times (no-ops after first).
 */
export async function initTelescope(): Promise<void> {
  if (initialized) return;

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

  generateBiomeData = biomeGenMod.generateBiomeData;
  BIOME_CONFIG = biomeGenMod.BIOME_CONFIG;
  generateBiomeTiles = tileGenMod.generateBiomeTiles;
  scanSpawnFunctions = poiScannerMod.scanSpawnFunctions;
  getSpecialPoIs = poiScannerMod.getSpecialPoIs;
  prescanSpawnFunctions = poiScannerMod.prescanSpawnFunctions;
  PIXEL_SCENE_DATA = pixelSceneMod.PIXEL_SCENE_DATA;
  loadPixelSceneData = pixelSceneMod.loadPixelSceneData;
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

  // 5. Load biome map base assets (telescope's preload step)
  // Use library's loadPNG which handles sanitization
  const [ng0Img, ngpImg] = await Promise.all([
    pngSanitizerMod.loadPNG("./data/biome_maps/biome_map.png"),
    pngSanitizerMod.loadPNG("./data/biome_maps/biome_map_newgame_plus.png"),
  ]);

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
  const LIB_VERSION = "2026-03-15-visual-lookup";
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
  const isNGP = ngPlus > 0;

  console.log(
    `[Telescope] Generating: seed=${seed}, NG+=${ngPlus}, daily=${dailySeed}, PWs=${parallelWorlds.join(",")}`,
  );
  const t0 = performance.now();

  // Set unlocks: daily seed = ALL ON, arbitrary = ALL ON for now
  if (dailySeed) {
    setUnlocks(Object.keys(UNLOCKABLES));
  } else {
    // Default to all unlocked for now (future: could allow toggle)
    setUnlocks(Object.keys(UNLOCKABLES));
  }

  // World dimensions
  const worldSize = getWorldSize(isNGP);
  const worldCenter = getWorldCenter(isNGP);
  const w = isNGP ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
  const h = isNGP ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;
  const base = isNGP ? biomeAssets.ngp : biomeAssets.ng0;

  if (!base) throw new Error("[Telescope] Biome map assets not loaded");

  // Step 1: Generate biome data
  const biomeData = generateBiomeData(seed, ngPlus, base, w, h);

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
  );

  // Initialize pixel scene caches on each layer
  for (const layer of tileLayers) {
    layer.pixelScenesByPW = {};
  }

  // Step 3: Prescan spawn functions (once per seed, reused across PWs)
  const tileSpawns = prescanSpawnFunctions(tileLayers, isNGP);

  // Step 4: Scan each PW
  const poisByPW: Record<string, POI[]> = {};
  const pixelScenesByPW: Record<string, PixelScene[]> = {};
  const perks: Record<string, any> = {}; // No perks active by default

  // Pre-load telescope modules needed for wand naming (avoid repeated dynamic imports in loop)
  const telescopeMods = await import("./telescope-exports");
  const { NollaPrng } = telescopeMods.nollaPrngMod;
  const { GUN_NAMES } = telescopeMods.wandConfigMod;

  for (const pw of parallelWorlds) {
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
    );

    const specialPOIs = getSpecialPoIs(biomeData, seed, ngPlus, pw, 0, perks);

    pixelScenesByPW[pwKey] = scanResults.finalPixelScenes;

    // Add static pixel scenes (hardcoded positions like pyramid boss, fishing hut, etc.)
    const staticResults = addStaticPixelScenes(seed, ngPlus, pw, 0, biomeData, false);
    if (staticResults && staticResults.pixelScenes) {
      pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(staticResults.pixelScenes);
    }

    // Also generate static scenes for heaven (pwVertical=-1) and hell (pwVertical=+1)
    // to capture shops and temples that fall outside the main world's vertical range
    const verticalPois: POI[] = [];
    for (const pvt of [-1, 1]) {
      const vtResults = addStaticPixelScenes(seed, ngPlus, pw, pvt, biomeData, false);
      if (vtResults && vtResults.pixelScenes && vtResults.pixelScenes.length > 0) {
        pixelScenesByPW[pwKey] = pixelScenesByPW[pwKey].concat(vtResults.pixelScenes);
      }
      if (vtResults && vtResults.pois && vtResults.pois.length > 0) {
        verticalPois.push(...vtResults.pois);
      }
    }

    // Post-process POIs to fix wand names without modifying library code
    const combinedPois = scanResults.generatedSpawns.concat(specialPOIs);
    if (staticResults && staticResults.pois) {
      combinedPois.push(...staticResults.pois);
    }
    if (verticalPois.length > 0) {
      combinedPois.push(...verticalPois);
    }

    // Add orbs from biome generation (coordinates are in chunk units, convert to world pixels)
    if (pw === 0 && biomeData.orbs && Array.isArray(biomeData.orbs)) {
      for (const orb of biomeData.orbs) {
        combinedPois.push({
          ...orb,
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
      combinedPois.push({
        type: "friend",
        x: pos.x + 256,
        y: pos.y + 256,
        biome: `friend_${friendRoom}`,
      } as any);
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
        type: "mestari_boss",
        x: (59 - 32) * 512 + 256,
        y: (43 - 14) * 512 + 256,
        biome: "mestari_secret",
      } as any);
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
