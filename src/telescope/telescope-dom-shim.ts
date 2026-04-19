/**
 * telescope-dom-shim.ts
 *
 * Injects fake DOM checkbox elements that telescope's JS reads via
 * document.getElementById().  Must be called BEFORE any telescope
 * module that references the DOM (poi_scanner, pixel_scene_generation,
 * utils / getBiomeAtWorldCoordinates).
 *
 * The shim creates hidden checkboxes with the IDs telescope expects
 * and sets their .checked / .value to the defaults we want for noitamap.
 */

import { decodePngToRgba } from "./png-decode";

let installed = false;

export interface TelescopeShimOptions {
  clearSpawnPixels?: boolean;
  recolorMaterials?: boolean;
  enableEdgeNoise?: boolean;
  fixHolyMountainEdgeNoise?: boolean;
}

const DEFAULTS: Required<TelescopeShimOptions> = {
  clearSpawnPixels: true,
  recolorMaterials: false,
  enableEdgeNoise: true,
  fixHolyMountainEdgeNoise: true,
};

/**
 * Install hidden checkbox stubs so telescope code can call
 * `document.getElementById('clear-spawn-pixels').checked` etc.
 */
export function installTelescopeShim(opts?: TelescopeShimOptions): void {
  if (installed) return;
  installed = true;

  installCanvasFingerprintBypass();

  const cfg = { ...DEFAULTS, ...opts };

  // Checkbox inputs — telescope reads these via .checked
  const checkboxes: Record<string, boolean> = {
    "clear-spawn-pixels": cfg.clearSpawnPixels,
    "recolor-materials": cfg.recolorMaterials,
    "debug-enable-edge-noise": cfg.enableEdgeNoise,
    "debug-fix-holy-mountain-edge-noise": cfg.fixHolyMountainEdgeNoise,
    // Additional IDs telescope may read (safe no-ops)
    "debug-hide-pois": true,
    "debug-draw": false,
    "debug-path": false,
    "debug-rng-info": false,
    "debug-original-biome-map": false,
    "debug-small-pois": false,
    "debug-edge-noise": false,
    "debug-block-edge-spawns": false,
    "skip-cosmetic-scenes": false,
    "exclude-taikasauva": false,
    "exclude-edge-cases": false,
    "visited-coalmine-alt-shrine": false,
    // Search-related checkboxes
    "search-all-pw": false,
    "search-vertical-pw": false,
    "show-wand-sprite-rarity": false,
    // App UI checkboxes
    "custom-art": false,
    "debug-show-path": false,
    "debug-show-tile-bounds": false,
    "show-enemy-spawns": true,
    "greed-curse": false,
    "no-more-shuffle": false,
    "auto-increment-seed": false,
    "enable-edge-noise": false,
    "fix-holy-mountain-edge-noise": false,
    "enable-hamis-hints": false,
    "exclude-negative-verticals": false,
    "rng-info": false,
  };

  const container = document.createElement("div");
  container.id = "telescope-shim";
  container.style.display = "none";

  for (const [id, checked] of Object.entries(checkboxes)) {
    if (document.getElementById(id)) continue; // already exists
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = checked;
    container.appendChild(cb);
  }

  // Text/number inputs — telescope reads these via .value
  const textInputs: Record<string, string> = {
    "debug-extra-rerolls": "0",
    "debug-biome-overlay-mode": "none",
    "enable-static-pixel-scenes": "all",
    // Navigation inputs
    "seed": "0",
    "pw": "0",
    "pw-vertical": "0",
    // Search inputs
    "search-input": "",
    "search-name": "",
    "search-sprite": "",
    "search-ac": "",
    "search-ac-mode": "any",
    "search-shuffle-mode": "any",
    "search-pw-limit": "1",
    "search-pw-vertical-limit": "1",
    // Wand stat filter inputs (min/max ranges)
    "cap-max-num": "99999",
    "cap-min-num": "0",
    "delay-max-num": "99999",
    "delay-min-num": "-99999",
    "len-max-num": "99999",
    "len-min-num": "0",
    "mana-max-num": "99999",
    "mana-min-num": "0",
    "manarech-max-num": "99999",
    "manarech-min-num": "0",
    "rarity-max-num": "99999",
    "rarity-min-num": "0",
    "rech-max-num": "99999",
    "rech-min-num": "-99999",
    "speed-max-num": "99999",
    "speed-min-num": "0",
    "spells-max-num": "99999",
    "spells-min-num": "0",
    "spread-max-num": "99999",
    "spread-min-num": "-99999",
    // App UI inputs
    "ng": "0",
    "extra-shop-items": "0",
    "game-mode": "normal",
    "local-search-mode": "global",
    "search-radius-num": "0",
  };
  for (const [id, value] of Object.entries(textInputs)) {
    if (document.getElementById(id)) continue;
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value;
    container.appendChild(input);
  }

  // Container/display elements — telescope accesses .innerHTML, .innerText, .style, or .getBoundingClientRect
  const displayElements: Record<string, string> = {
    "search-results": "div",
    "search-nav": "div",
    "search-count": "span",
    "cancel-search": "button",
    "view": "div",
    // App UI containers, canvases, and buttons
    "advanced-ui": "div",
    "canvas": "canvas",
    "coords": "div",
    "copy-path-btn": "button",
    "daily-run-button": "button",
    "debug-noise-canvas": "canvas",
    "debug-options": "div",
    "gen-btn": "button",
    "loading-overlay": "div",
    "loading-text": "div",
    "overlay": "canvas",
    "pw-dec": "button",
    "pw-dec-vertical": "button",
    "pw-inc": "button",
    "pw-inc-vertical": "button",
    "pw-set-max": "span",
    "pw-set-max-vertical": "span",
    "regions-all": "button",
    "regions-list": "div",
    "regions-none": "button",
    "regions-useful": "button",
    "search-all-pw-label": "label",
    "search-background": "div",
    "search-btn": "button",
    "search-label": "span",
    "search-next": "button",
    "search-prev": "button",
    "search-status": "span",
    "search-status-container": "div",
    "status": "div",
    "tooltip": "div",
    "unlock-all": "button",
    "unlock-folder-picker": "input",
    "unlock-none": "button",
    "unlocks-list": "div",
    "search-rare-btn": "button",
  };
  for (const [id, tagName] of Object.entries(displayElements)) {
    if (document.getElementById(id)) continue;
    const el = document.createElement(tagName);
    el.id = id;
    container.appendChild(el);
  }

  document.body.appendChild(container);
}


/**
 * LibreWolf and Safari ITP block canvas `getImageData` and `convertToBlob` by
 * injecting noise or returning all-zeros if no user input is detected.
 * The Telescope library generates images correctly in JS, then calls `putImageData`
 * to write them to `OffscreenCanvas` objects.
 *
 * This hook intercepts `putImageData` strictly on OffscreenCanvas and regular Canvas,
 * capturing the pristine raw `ImageData` the library generated BEFORE it falls
 * into the browser's black-box taint system. Our adapter can later encode this
 * raw data using pure-JS `fast-png`, bypassing the browser canvas extraction blocker.
 */
function installCanvasFingerprintBypass() {
  if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
    const origOffscreenPutImageData = OffscreenCanvasRenderingContext2D.prototype.putImageData;
    OffscreenCanvasRenderingContext2D.prototype.putImageData = function (imageData: ImageData, dx: number, dy: number) {
      if (dx === 0 && dy === 0) {
        // Clone the data — telescope may reuse/mutate the same ImageData buffer
        (this.canvas as any).__noitamap_rawImageData = new ImageData(
          new Uint8ClampedArray(imageData.data),
          imageData.width,
          imageData.height,
        );
      }
      return (origOffscreenPutImageData as any).apply(this, arguments as any);
    };
  }

  if (typeof CanvasRenderingContext2D !== "undefined") {
    const origCanvasPutImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (imageData: ImageData, dx: number, dy: number) {
      if (dx === 0 && dy === 0) {
        (this.canvas as any).__noitamap_rawImageData = new ImageData(
          new Uint8ClampedArray(imageData.data),
          imageData.width,
          imageData.height,
        );
      }
      return (origCanvasPutImageData as any).apply(this, arguments as any);
    };
  }

  // ----- Extended Canvas Fingerprinting Bypass for LibreWolf/Safari ITP -----
  // ImageBitmap is non-extensible so we cannot attach arbitrary properties to it.
  // Use a WeakMap keyed by the bitmap/canvas to hold the raw decoded pixel data.
  const rawDataStore = new WeakMap<object, { data: Uint8ClampedArray; width: number; height: number }>();

  const origCreateImageBitmap = window.createImageBitmap;
  window.createImageBitmap = async function (image: any, ...args: any[]) {
    const bitmap = await (origCreateImageBitmap as any).apply(window, [image, ...args]);
    if (image instanceof Blob) {
      try {
        const buf = await image.arrayBuffer();
        const raw = decodePngToRgba(buf);
        rawDataStore.set(bitmap, raw);
      } catch (e) {
        console.warn("Shim failed to decode ImageBitmap blob", e);
      }
    }
    return bitmap;
  } as any;

  function shimDrawImage(origFn: any) {
    return function (this: any, image: any, ...args: any[]) {
      origFn.apply(this, arguments as any);

      // Look up raw data in our WeakMap (works for ImageBitmap, HTMLCanvasElement, OffscreenCanvas)
      let rawData = rawDataStore.get(image);
      if (!rawData && image instanceof HTMLCanvasElement) rawData = rawDataStore.get(image);
      if (!rawData && image instanceof OffscreenCanvas) rawData = rawDataStore.get(image);
      // Also check HTMLImageElement for raw data stored by the Image.src interceptor
      // in telescope-data-bridge.ts. This is needed for biome_hacks.js's preloadOverlays()
      // which loads coalmine overlay via new Image() → drawImage → getImageData.
      if (!rawData && image instanceof HTMLImageElement && (image as any).__noitamap_rawImageData) {
        rawData = (image as any).__noitamap_rawImageData;
      }

      // Only propagate when this is a plain drawImage(src, 0, 0) covering the full source
      if (rawData && args.length >= 2 && args[0] === 0 && args[1] === 0) {
        const dw = args.length >= 4 ? args[2] : (image.width as number);
        const dh = args.length >= 4 ? args[3] : (image.height as number);
        if (dw === rawData.width && dh === rawData.height) {
          rawDataStore.set(this.canvas, {
            data: new Uint8ClampedArray(rawData.data),
            width: rawData.width,
            height: rawData.height,
          });
        }
      }
    };
  }

  if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
    OffscreenCanvasRenderingContext2D.prototype.drawImage = shimDrawImage(
      OffscreenCanvasRenderingContext2D.prototype.drawImage,
    );
  }
  if (typeof CanvasRenderingContext2D !== "undefined") {
    CanvasRenderingContext2D.prototype.drawImage = shimDrawImage(CanvasRenderingContext2D.prototype.drawImage);
  }

  function shimGetImageData(origFn: any) {
    return function (this: any, sx: number, sy: number, sw: number, sh: number) {
      const rawData = rawDataStore.get(this.canvas);
      if (rawData && sx === 0 && sy === 0 && sw === rawData.width && sh === rawData.height) {
        return new ImageData(new Uint8ClampedArray(rawData.data), sw, sh) as any;
      }
      return origFn.apply(this, arguments as any);
    };
  }

  if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
    OffscreenCanvasRenderingContext2D.prototype.getImageData = shimGetImageData(
      OffscreenCanvasRenderingContext2D.prototype.getImageData,
    );
  }
  if (typeof CanvasRenderingContext2D !== "undefined") {
    CanvasRenderingContext2D.prototype.getImageData = shimGetImageData(CanvasRenderingContext2D.prototype.getImageData);
  }
}

// ─── Canvas Fingerprint Detection ────────────────────────────────────────────

let _canvasTainted: boolean | null = null;

/**
 * Detect whether the browser's canvas fingerprint protection is active.
 * Draws 256 varied pixels, reads back, and measures TOTAL noise energy
 * (sum of absolute differences). Firefox color rounding produces ~50-200
 * total noise; LibreWolf RFP produces 2000+.
 *
 * Returns `true` if canvas extraction is tainted (LibreWolf RFP, Tor, etc.).
 */
export function isCanvasTainted(): boolean {
  if (_canvasTainted !== null) return _canvasTainted;

  try {
    const SIZE = 16;
    const c = new OffscreenCanvas(SIZE, SIZE);
    const ctx = c.getContext("2d")!;

    const expected: number[] = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const r = (x * 17 + 3) & 255;
        const g = (y * 31 + 7) & 255;
        const b = ((x ^ y) * 13 + 42) & 255;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, 1, 1);
        expected.push(r, g, b, 255);
      }
    }

    const readback = ctx.getImageData(0, 0, SIZE, SIZE);
    let totalNoise = 0;
    for (let i = 0; i < readback.data.length; i++) {
      totalNoise += Math.abs(readback.data[i] - expected[i]);
    }

    // Firefox: ~50-200, LibreWolf RFP: 2000+
    const NOISE_THRESHOLD = 500;
    _canvasTainted = totalNoise > NOISE_THRESHOLD;
    console.log(`[Shim] Canvas noise test: totalNoise=${totalNoise}, threshold=${NOISE_THRESHOLD}, tainted=${_canvasTainted}`);
    if (_canvasTainted) {
      console.warn("[Shim] Canvas fingerprint protection detected — using individual overlay rendering for biome layers");
    }
  } catch {
    _canvasTainted = false;
  }

  return _canvasTainted!;
}
