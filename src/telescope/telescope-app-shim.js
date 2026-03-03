// src/telescope/telescope-app-shim.js
// This is a shim for lib/noita-telescope/js/app.js that removes the app.init() side-effect.
// It is used via a Vite alias to prevent the telescope "standalone app" from trying
// to initialize and crash when we only want to import its modules in noitamap.

import { generateBiomeData, BIOME_CONFIG } from "noita-telescope/biome_generator.js";
import { sanitizePng } from "noita-telescope/png_sanitizer.js";
import { getDisplayName, loadTranslations } from "noita-telescope/translations.js";
import { UNLOCKABLES, setUnlocks } from "noita-telescope/unlocks.js";
import { toggleTooltipPinned, updateTooltip } from "noita-telescope/tooltip_generator.js";
import { GENERATOR_CONFIG } from "noita-telescope/generator_config.js";
import { generateBiomeTiles } from "noita-telescope/tile_generator.js";
import { scanSpawnFunctions, getSpecialPoIs, prescanSpawnFunctions } from "noita-telescope/poi_scanner.js";
import { performSearch, navigateSearch, cancelSearch, isSearchActive } from "noita-telescope/search.js";
import {
  TIME_UNTIL_LOADING,
  POI_RADIUS,
  CHUNK_SIZE,
  VISUAL_TILE_OFFSET_X,
  VISUAL_TILE_OFFSET_Y,
} from "noita-telescope/constants.js";
import {
  getBiomeAtWorldCoordinates,
  getMaterialAtWorldCoordinates,
  getWorldCenter,
  getWorldSize,
} from "noita-telescope/utils.js";
import { renderWallMessages } from "noita-telescope/wall_messages.js";
import { findEyeMessages, renderEyeMessages } from "noita-telescope/eye_messages.js";
import {
  BIOME_COLOR_LOOKUP,
  createTileOverlays,
  createTileOverlaysCheap,
  createTileOverlaysExpanded,
} from "noita-telescope/image_processing.js";
import { COALMINE_ALT_SCENES } from "noita-telescope/pixel_scene_config.js";
import { debugBiomeEdgeNoise } from "noita-telescope/edge_noise.js";
import { loadPixelSceneData, reloadPixelSceneCache } from "noita-telescope/pixel_scene_generation.js";

export const app = {
  // ... (We just need it to exist and have basic properties if used)
  canvas: null,
  ctx: null,
  offscreen: null,
  offscreenHeaven: null,
  offscreenHell: null,
  overlay: null,
  ctxo: null,
  recolorOffscreen: null,
  recolorOffscreenHeaven: null,
  recolorOffscreenHell: null,
  w: 0,
  h: 0,
  biomeData: null,
  tileLayers: [],
  cam: { x: CHUNK_SIZE * 35, y: CHUNK_SIZE * 24, z: 0.053 },
  drag: { on: false, lx: 0, ly: 0 },
  assets: { ng0: null, ngp: null },
  pinnedTooltip: null,
  pw: 0,
  pwVertical: 0,
  seed: 0,
  ngPlusCount: 0,
  isNGP: false,
  eyes: {},
  skipCosmeticScenes: false,
  biomeMapOverlay: null,
  tileSpawns: null,
  pixelScenesByPW: {},
  poisByPW: {},
  tileOverlaysByPW: {},
  translations: {},
  loadingTimer: null,
  perks: {},
  debugCanvas: null,
  debugX: 0,
  debugY: 0,

  init() {
    console.warn("[Telescope Shim] app.init() called but intercepted.");
  },
  // Add other stubs if needed, but usually modules just check app.isNGP or app.pw
};

// No app.init() call here!
