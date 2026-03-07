// src/telescope/telescope-app-shim.js
// This is a shim for lib/noita-telescope/js/app.js that removes the app.init() side-effect.
// It is used via a Vite alias to prevent the telescope "standalone app" from trying
// to initialize and crash when we only want to import its modules in noitamap.

// No static imports from "noita-telescope/" to avoid mixing static and dynamic imports!
// This file only exports a fake `app` object so that library files don't crash when referencing `app`.

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
  cam: { x: 512 * 35, y: 512 * 24, z: 0.053 },
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
