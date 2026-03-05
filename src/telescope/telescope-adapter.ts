/**
 * telescope-adapter.ts
 *
 * Main adapter that wraps telescope's generation pipeline into a clean
 * async API for noitamap.  Handles:
 *  - Installing DOM shim (fake checkboxes for telescope's getElementById calls)
 *  - Installing fetch interceptor (data.zip → telescope's ./data/ paths)
 *  - Loading biome maps, wang tiles, pixel scenes from data.zip
 *  - Running the full generation pipeline
 *  - Returning results as typed data for the OSD bridge
 */

import { installTelescopeShim } from "./telescope-dom-shim";
import {
  installFetchInterceptor,
  installImageSrcInterceptor,
  loadBiomeMaps,
  loadWangTileFromZip,
} from "./telescope-data-bridge";
import { getDataZip } from "../data-archive";

// Telescope modules — loaded dynamically in initTelescope() to avoid top-level
// await in image_processing.js from blocking the entire bundle on CF Pages.
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
  imgElement: HTMLCanvasElement | OffscreenCanvas;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  key: string;
  variantKey?: string;
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
  const [
    biomeGenMod,
    tileGenMod,
    poiScannerMod,
    pixelSceneMod,
    genConfigMod,
    unlocksMod,
    utilsMod,
    translationsMod,
    eyeMessagesMod,
    imageProcessingMod,
  ] = await Promise.all([
    import("noita-telescope/biome_generator.js"),
    import("noita-telescope/tile_generator.js"),
    import("noita-telescope/poi_scanner.js"),
    import("noita-telescope/pixel_scene_generation.js"),
    import("noita-telescope/generator_config.js"),
    import("noita-telescope/unlocks.js"),
    import("noita-telescope/utils.js"),
    import("noita-telescope/translations.js"),
    import("noita-telescope/eye_messages.js"),
    import("noita-telescope/image_processing.js"),
  ]);

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
  
  // Runtime patch for eye_messages.js crash (TypeError: positionsEast[i] is undefined)
  // ES module exports are read-only, so we wrap it in our local variable instead.
  const originalFindEyeMessages = eyeMessagesMod.findEyeMessages;
  findEyeMessages = (biomeMap: any, seed: number, ngPlus: number) => {
    try {
      return originalFindEyeMessages(biomeMap, seed, ngPlus);
    } catch (e) {
      console.warn("[Telescope Hack] findEyeMessages crashed, returning empty arrays:", e);
      return { east: [], west: [] };
    }
  };

  // 4b. Apply truthy color hack to fix library transparency bug
  // The library uses `if (foregroundColor)` which fails for color 0 (black).
  // We change 0 to 1 (near-black) to make it truthy without touching the library code.
  const { TILE_FOREGROUND_COLORS } = imageProcessingMod;
  if (TILE_FOREGROUND_COLORS) {
    for (const [key, val] of Object.entries(TILE_FOREGROUND_COLORS)) {
      if (val === 0) (TILE_FOREGROUND_COLORS as any)[key] = 1;
    }
  }

  // 5. Load biome map base assets (telescope's preload step)
  biomeAssets = await loadBiomeMaps();
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
      cfg.wangData = await loadWangTileFromZip(cfg.wangFile);
      if (!cfg.wangData) {
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
    
    // Post-process POIs to fix wand names without modifying library code
    const combinedPois = scanResults.generatedSpawns.concat(specialPOIs);
    for (const poi of combinedPois) {
      if (poi.type === "wand" && (!poi.name || poi.name === "Taikasauva")) {
        const [nollaPrngMod, wandConfigMod] = await Promise.all([
          import("noita-telescope/nolla_prng.js"),
          import("noita-telescope/wand_config.js"),
        ]);
        const prng = new nollaPrngMod.NollaPrng(0);
        prng.SetRandomSeed(seed + ngPlus, poi.x, poi.y);
        
        // Replicate library's random name generation logic
        // (Library's Random(a, b) uses a + floor((b+1-a)*Next))
        const { GUN_NAMES } = wandConfigMod;
        const nameIdx = Math.floor((GUN_NAMES.length) * prng.Next());
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
