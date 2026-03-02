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

import { installTelescopeShim } from './telescope-dom-shim';
import { installFetchInterceptor, loadBiomeMaps, loadWangTileFromZip } from './telescope-data-bridge';
import { getDataZip } from '../data-archive';

// Telescope imports (plain JS modules via Vite alias 'noita-telescope')
// @ts-ignore — untyped JS module
import { generateBiomeData, BIOME_CONFIG } from 'noita-telescope/biome_generator.js';
// @ts-ignore
import { generateBiomeTiles } from 'noita-telescope/tile_generator.js';
// @ts-ignore
import { scanSpawnFunctions, getSpecialPoIs, prescanSpawnFunctions } from 'noita-telescope/poi_scanner.js';
// @ts-ignore
import { loadPixelSceneData, reloadPixelSceneCache } from 'noita-telescope/pixel_scene_generation.js';
// @ts-ignore
import { GENERATOR_CONFIG } from 'noita-telescope/generator_config.js';
// @ts-ignore
import { UNLOCKABLES, setUnlocks } from 'noita-telescope/unlocks.js';
// @ts-ignore
import { getWorldSize, getWorldCenter } from 'noita-telescope/utils.js';
// @ts-ignore
import { sanitizePng } from 'noita-telescope/png_sanitizer.js';
// @ts-ignore
import { loadTranslations } from 'noita-telescope/translations.js';
// @ts-ignore
import { findEyeMessages } from 'noita-telescope/eye_messages.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TileLayer {
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
  imgElement: HTMLCanvasElement;
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

  console.log('[Telescope] Initializing...');

  // 1. Install DOM shim before any telescope code reads the DOM
  installTelescopeShim({
    clearSpawnPixels: true,
    recolorMaterials: false,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
  });

  // 2. Ensure data.zip is loaded
  const zip = await getDataZip();
  if (!zip) throw new Error('[Telescope] data.zip failed to load');

  // 3. Install fetch interceptor so telescope's fetch('./data/...') goes to zip
  installFetchInterceptor();

  // 4. Load biome map base assets (telescope's preload step)
  biomeAssets = await loadBiomeMaps();
  if (!biomeAssets.ng0) throw new Error('[Telescope] Failed to load NG0 biome map');

  // 5. Load translations
  await loadTranslations();

  // 6. Enable all regions in generator config
  for (const key of Object.keys(GENERATOR_CONFIG)) {
    GENERATOR_CONFIG[key].enabled = true;
  }

  // 7. Pre-load wang tile data for all regions
  for (const key of Object.keys(GENERATOR_CONFIG)) {
    const cfg = GENERATOR_CONFIG[key];
    if (cfg.wangFile && !cfg.wangData) {
      cfg.wangData = await loadWangTileFromZip(cfg.wangFile);
    }
  }

  // 8. Load pixel scene data (uses fetch interceptor internally)
  await loadPixelSceneData();

  initialized = true;
  console.log('[Telescope] Initialization complete');
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

  console.log(`[Telescope] Generating: seed=${seed}, NG+=${ngPlus}, daily=${dailySeed}, PWs=${parallelWorlds.join(',')}`);
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

  if (!base) throw new Error('[Telescope] Biome map assets not loaded');

  // Step 1: Generate biome data
  const biomeData = generateBiomeData(seed, ngPlus, base, w, h);

  // Step 2: Generate tiles
  const tileLayers: TileLayer[] = await generateBiomeTiles(
    biomeData.pixels, w, h,
    GENERATOR_CONFIG, seed, ngPlus, 0 /* extra_rerolls */
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
      biomeData, tileSpawns, seed, ngPlus, pw, 0 /* pwVertical */,
      false /* skipCosmeticScenes */, perks
    );

    const specialPOIs = getSpecialPoIs(biomeData, seed, ngPlus, pw, 0, perks);

    pixelScenesByPW[pwKey] = scanResults.finalPixelScenes;
    poisByPW[pwKey] = scanResults.generatedSpawns.concat(specialPOIs);
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
  };
}
