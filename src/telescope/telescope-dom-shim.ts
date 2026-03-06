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
    "skip-cosmetic-scenes": false,
    "exclude-taikasauva": false,
    "exclude-edge-cases": false,
    "visited-coalmine-alt-shrine": false,
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

  // Also add text inputs telescope may read
  const textInputs: Record<string, string> = {
    "debug-extra-rerolls": "0",
    "debug-biome-overlay-mode": "none",
    "enable-static-pixel-scenes": "all",
  };
  for (const [id, value] of Object.entries(textInputs)) {
    if (document.getElementById(id)) continue;
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value;
    container.appendChild(input);
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
  const origOffscreenPutImageData = OffscreenCanvasRenderingContext2D.prototype.putImageData;
  OffscreenCanvasRenderingContext2D.prototype.putImageData = function (imageData: ImageData, dx: number, dy: number) {
    // Telescope library always puts at 0, 0 for the full image
    if (dx === 0 && dy === 0) {
      (this.canvas as any).__noitamap_rawImageData = imageData;
    }
    return (origOffscreenPutImageData as any).apply(this, arguments as any);
  };

  const origCanvasPutImageData = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (imageData: ImageData, dx: number, dy: number) {
    if (dx === 0 && dy === 0) {
      (this.canvas as any).__noitamap_rawImageData = imageData;
    }
    return (origCanvasPutImageData as any).apply(this, arguments as any);
  };

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

  OffscreenCanvasRenderingContext2D.prototype.drawImage = shimDrawImage(
    OffscreenCanvasRenderingContext2D.prototype.drawImage,
  );
  CanvasRenderingContext2D.prototype.drawImage = shimDrawImage(CanvasRenderingContext2D.prototype.drawImage);

  function shimGetImageData(origFn: any) {
    return function (this: any, sx: number, sy: number, sw: number, sh: number) {
      const rawData = rawDataStore.get(this.canvas);
      if (rawData && sx === 0 && sy === 0 && sw === rawData.width && sh === rawData.height) {
        return new ImageData(new Uint8ClampedArray(rawData.data), sw, sh) as any;
      }
      return origFn.apply(this, arguments as any);
    };
  }

  OffscreenCanvasRenderingContext2D.prototype.getImageData = shimGetImageData(
    OffscreenCanvasRenderingContext2D.prototype.getImageData,
  );
  CanvasRenderingContext2D.prototype.getImageData = shimGetImageData(CanvasRenderingContext2D.prototype.getImageData);
}
