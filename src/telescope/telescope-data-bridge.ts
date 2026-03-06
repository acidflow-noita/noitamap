/**
 * telescope-data-bridge.ts
 *
 * Bridges between data.zip (via data-archive.ts) and telescope's expected
 * `./data/...` fetch paths.
 *
 * Strategy:
 *  1. Try data.zip (our custom archive, has biome maps and biome_impl PNGs)
 *  2. Try telescope's own pixel_scenes.zip or wang_tiles.zip (served from public/)
 *  3. Fall through to the real network (serves translations.csv, secret_messages, etc.)
 */

import JSZip from "jszip";
import { getDataZip } from "../data-archive";
import { decodePngToRgba, rgbaToPngBlobUrl } from "./png-decode";
import type { RawImageData } from "./png-decode";

// ─── Secondary zip archives (telescope's own data) ──────────────────────────

let pixelScenesZip: JSZip | null = null;
let pixelScenesZipPromise: Promise<JSZip | null> | null = null;

let wangTilesZip: JSZip | null = null;
let wangTilesZipPromise: Promise<JSZip | null> | null = null;

async function loadSecondaryZip(
  url: string,
  cache: { zip: JSZip | null; promise: Promise<JSZip | null> | null },
): Promise<JSZip | null> {
  if (cache.zip) return cache.zip;
  if (!cache.promise) {
    cache.promise = (async () => {
      try {
        const resp = await originalFetch(url);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const z = await JSZip.loadAsync(buf);
        cache.zip = z;
        return z;
      } catch {
        return null;
      }
    })();
  }
  return cache.promise;
}

function getPixelScenesZip(): Promise<JSZip | null> {
  const cache = {
    get zip() {
      return pixelScenesZip;
    },
    set zip(v) {
      pixelScenesZip = v;
    },
    get promise() {
      return pixelScenesZipPromise;
    },
    set promise(v) {
      pixelScenesZipPromise = v;
    },
  };
  return loadSecondaryZip("./pixel_scenes.zip", cache);
}

function getWangTilesZip(): Promise<JSZip | null> {
  const cache = {
    get zip() {
      return wangTilesZip;
    },
    set zip(v) {
      wangTilesZip = v;
    },
    get promise() {
      return wangTilesZipPromise;
    },
    set promise(v) {
      wangTilesZipPromise = v;
    },
  };
  return loadSecondaryZip("./wang_tiles.zip", cache);
}

/**
 * Try to resolve a telescope data path from the secondary zip archives.
 * - data/pixel_scenes/<biome>/<scene>.png → pixel_scenes.zip entry <biome>/<scene>.png
 * - data/wang_tiles/<sub>.png            → wang_tiles.zip entry <sub>.png
 * Returns the file contents as ArrayBuffer, or null if not found.
 */
async function trySecondaryZips(normalizePath: string): Promise<ArrayBuffer | null> {
  if (normalizePath.startsWith("data/pixel_scenes/")) {
    const relativePath = normalizePath.replace("data/pixel_scenes/", "");
    const z = await getPixelScenesZip();
    if (z) {
      const file = z.file(relativePath);
      if (file) return file.async("arraybuffer");
    }
  }
  if (normalizePath.startsWith("data/wang_tiles/")) {
    const relativePath = normalizePath.replace("data/wang_tiles/", "");
    const z = await getWangTilesZip();
    if (z) {
      const file = z.file(relativePath);
      if (file) {
        // console.log(`[DataBridge] Found ${normalizePath} in secondary wang_tiles.zip`);
        return file.async("arraybuffer");
      }
    }
    console.warn(`[DataBridge] ${normalizePath} NOT FOUND in secondary wang_tiles.zip`);
  }
  return null;
}

// ─── Path mapping ───────────────────────────────────────────────────────────

/**
 * Convert a telescope `./data/...` path to a data.zip entry path.
 */
function telescopePathToZipPath(telescopePath: string): string {
  // Normalise: strip leading './' or '/' and query strings
  let p = telescopePath.replace(/^\.\//, "").replace(/\?.*$/, "");

  // Wang tiles: data/wang_tiles/X.png → data/wang_tiles/X.png (same)
  if (p.startsWith("data/wang_tiles/")) return p;

  // Biome maps: data/biome_maps/X.png → data/biome_impl/X.png
  if (p.startsWith("data/biome_maps/")) {
    return p.replace("data/biome_maps/", "data/biome_impl/");
  }

  // Pixel scenes: data/pixel_scenes/<biome>/<scene>.png → data/biome_impl/<biome>/<scene>.png
  // General scenes: data/pixel_scenes/general/<scene>.png → data/biome_impl/<scene>.png
  if (p.startsWith("data/pixel_scenes/")) {
    const rest = p.replace("data/pixel_scenes/", "");
    if (rest.startsWith("general/")) {
      return "data/biome_impl/" + rest.replace("general/", "");
    }
    return "data/biome_impl/" + rest;
  }

  // Item/spell/wand sprites: data/item_sprites/X → data/item_sprites/X (same)
  // data/spell_sprites/X → data/spell_sprites/X (same)
  // data/wand_sprites/X → data/wand_sprites/X (same)
  if (p.startsWith("data/item_sprites/") || p.startsWith("data/spell_sprites/") || p.startsWith("data/wand_sprites/")) {
    return p;
  }

  // Fallback: try as-is
  return p;
}

// ─── Fetch interceptor ──────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);
let interceptorInstalled = false;

/**
 * Install a fetch interceptor that serves `./data/...` requests from data.zip.
 * Must be called AFTER data.zip is loaded (or it will fall through to the
 * original fetch on cache miss).
 */
export function installFetchInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    let isDataRequest = false;
    let normalizePath = "";

    try {
      // Parse as URL to safely check pathname (handles absolute URLs automatically)
      // We use window.location.href as base to handle relative strings
      const urlObj = new URL(urlString, window.location.href);
      if (urlObj.pathname.startsWith("/data/")) {
        isDataRequest = true;
        // Strip leading slash for zip mapping
        normalizePath = urlObj.pathname.substring(1);
      }
    } catch (e) {
      // Fallback if URL parsing fails for some reason
      if (urlString.startsWith("./data/") || urlString.startsWith("data/")) {
        isDataRequest = true;
        normalizePath = urlString.startsWith("./") ? urlString.substring(2) : urlString;
      }
    }

    // Pass through non-data requests (like takapuoli.noitagame.com)
    if (!isDataRequest) {
      return originalFetch(input, init);
    }

    const zipPath = telescopePathToZipPath(normalizePath);
    const zip = await getDataZip();
    if (!zip) {
      console.warn(`[DataBridge] data.zip not loaded, falling through for: ${urlString}`);
      return originalFetch(input, init);
    }

    const file = zip.file(zipPath);
    if (!file) {
      // Not in data.zip — try telescope's own secondary zip archives
      const buf = await trySecondaryZips(normalizePath);
      if (buf) {
        const ext = normalizePath.split(".").pop()?.toLowerCase();
        let mime = "application/octet-stream";
        if (ext === "png") mime = "image/png";
        else if (ext === "csv") mime = "text/csv";
        return new Response(buf, { status: 200, statusText: "OK", headers: { "Content-Type": mime } });
      }

      if (normalizePath.includes("wang_tiles")) {
        console.warn(`[DataBridge] Wang tile NOT FOUND: ${normalizePath} (zipPath: ${zipPath})`);
      }
      // Fall through to the real network (translations.csv, secret_messages, etc.)
      return originalFetch(input, init);
    }

    const buf = await file.async("arraybuffer");
    const ext = zipPath.split(".").pop()?.toLowerCase();
    let mime = "application/octet-stream";
    if (ext === "png") mime = "image/png";
    else if (ext === "json") mime = "application/json";
    else if (ext === "csv") mime = "text/csv";
    else if (ext === "xml") mime = "text/xml";

    return new Response(buf, {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": mime },
    });
  };
}

/**
 * Remove the fetch interceptor and restore the original fetch.
 */
export function removeFetchInterceptor(): void {
  if (!interceptorInstalled) return;
  window.fetch = originalFetch;
  interceptorInstalled = false;
}

// ─── Image src interceptor ──────────────────────────────────────────────────

let imageSrcInterceptorInstalled = false;
let originalSrcDescriptor: PropertyDescriptor | undefined;

/**
 * Install a monkey-patch on HTMLImageElement.prototype.src so that
 * telescope's `new Image(); img.src = './data/...'` loads go through our
 * fetch interceptor (and thus come from data.zip) instead of hitting the
 * server (which on CF Pages returns the SPA fallback HTML).
 *
 * Must be called AFTER installFetchInterceptor().
 */
export function installImageSrcInterceptor(): void {
  if (imageSrcInterceptorInstalled) return;
  imageSrcInterceptorInstalled = true;

  originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (!originalSrcDescriptor || !originalSrcDescriptor.set || !originalSrcDescriptor.get) {
    console.warn("[DataBridge] Cannot intercept Image.src — descriptor not found");
    return;
  }

  const origSet = originalSrcDescriptor.set;
  const origGet = originalSrcDescriptor.get;

  Object.defineProperty(HTMLImageElement.prototype, "src", {
    get: origGet,
    set(this: HTMLImageElement, value: string) {
      let isDataUrl = false;
      let fetchPath = "";

      if (typeof value === "string") {
        if (value.startsWith("./data/") || value.startsWith("data/")) {
          isDataUrl = true;
          fetchPath = value;
        } else if (value.startsWith("/data/")) {
          isDataUrl = true;
          fetchPath = "." + value;
        }
      }

      if (!isDataUrl) {
        origSet.call(this, value);
        return;
      }

      // Intercept: fetch the PNG from our zip-backed fetch interceptor,
      // then decode pixel data using pure-JS fast-png (no canvas/getImageData).
      // This is immune to fingerprinting protection in LibreWolf/Safari/iOS.
      const img = this;
      fetch(fetchPath)
        .then((r) => r.arrayBuffer())
        .then(async (buf) => {
          const decoded = decodePngToRgba(buf);
          // Store raw pixel data on the element so the canvas fingerprint bypass
          // shim can use it when drawImage(img, ...) is called later.
          // Without this, biome_hacks.js's preloadOverlays() gets zeroed data
          // in LibreWolf because getImageData() is blocked by fingerprint protection.
          (img as any).__noitamap_rawImageData = {
            data: decoded.data,
            width: decoded.width,
            height: decoded.height,
          };
          const blobUrl = await rgbaToPngBlobUrl(decoded.data, decoded.width, decoded.height);
          origSet.call(img, blobUrl);
        })
        .catch(() => {
          // Fall back to original URL on error
          origSet.call(img, value);
        });
    },
    enumerable: true,
    configurable: true,
  });
}

/**
 * Remove the Image src interceptor and restore the original setter.
 */
export function removeImageSrcInterceptor(): void {
  if (!imageSrcInterceptorInstalled || !originalSrcDescriptor) return;
  Object.defineProperty(HTMLImageElement.prototype, "src", originalSrcDescriptor);
  imageSrcInterceptorInstalled = false;
}

// ─── Direct loaders (for adapter code that bypasses telescope's fetch) ──────

/**
 * Load a biome map PNG from data.zip and return as Uint32Array
 * (matching telescope's preload format: 0xFF000000 | R<<16 | G<<8 | B).
 */
export async function loadBiomeMapFromZip(telescopePath: string): Promise<Uint32Array | null> {
  const zipPath = telescopePathToZipPath(telescopePath);
  const zip = await getDataZip();
  if (!zip) return null;

  const file = zip.file(zipPath);
  if (!file) {
    console.warn(`[DataBridge] Biome map not found: ${zipPath}`);
    return null;
  }

  // Use pure-JS PNG decoding — no canvas, no getImageData.
  // This is immune to fingerprinting protection (LibreWolf, Safari, iOS).
  const buf = await file.async("arraybuffer");
  const { data, width, height } = decodePngToRgba(buf);
  const u32 = new Uint32Array(width * height);
  for (let i = 0; i < u32.length; i++) {
    u32[i] = 0xff000000 | (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
  }
  return u32;
}

/**
 * Load both NG0 and NG+ biome maps from data.zip.
 */
export async function loadBiomeMaps(): Promise<{
  ng0: Uint32Array | null;
  ngp: Uint32Array | null;
}> {
  const [ng0, ngp] = await Promise.all([
    loadBiomeMapFromZip("./data/biome_maps/biome_map.png"),
    loadBiomeMapFromZip("./data/biome_maps/biome_map_newgame_plus.png"),
  ]);
  return { ng0, ngp };
}

/**
 * Pre-load wang tile data for a given generator config entry.
 * Returns the same format as telescope's loadWangAsset.
 */
export async function loadWangTileFromZip(
  telescopePath: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const zipPath = telescopePathToZipPath(telescopePath);
  const zip = await getDataZip();
  if (!zip) return null;

  const file = zip.file(zipPath);
  let buf: ArrayBuffer;
  if (!file) {
    // Try telescope's own wang_tiles.zip (serves static/ entries missing from data.zip)
    const secondary = await trySecondaryZips(zipPath);
    if (!secondary) {
      console.warn(`[DataBridge] Wang tile not found: ${zipPath}`);
      return null;
    }
    buf = secondary;
  } else {
    buf = await file.async("arraybuffer");
  }

  // Use pure-JS PNG decoding — no canvas, no getImageData.
  return decodePngToRgba(buf);
}

// ─── Biome Color Lookup (canvas-free) ───────────────────────────────────────

/**
 * Replicates image_processing.js's createBiomeColorLookup() using canvas-free
 * PNG decoding. Called after importing the telescope module to overwrite the
 * module's own (potentially zero-data) lookup tables in privacy browsers.
 *
 * The telescope library computes:
 *   BIOME_COLOR_LOOKUP  – biome map color → background color
 *   BIOME_BACKGROUND_COLORS – same data, different shape
 *   TILE_OVERLAY_COLORS / TILE_FOREGROUND_COLORS – foreground colors
 */
export async function buildBiomeColorLookupsFromZip(biomeColorConfig: Record<string, string>): Promise<{
  nameLookupBackground: Record<string, number>;
  backgroundColors: Record<number, number>;
  nameLookupForeground: Record<string, number>;
  foregroundColors: Record<number, number>;
}> {
  const [ng0Buf, bgBuf, fgBuf] = await Promise.all([
    loadRawPngFromZip("./data/biome_maps/biome_map.png"),
    loadRawPngFromZip("./data/biome_maps/biome_map_background.png"),
    loadRawPngFromZip("./data/biome_maps/biome_map_foreground.png"),
  ]);

  if (!ng0Buf || !bgBuf || !fgBuf) {
    console.warn("[DataBridge] Could not load biome map PNGs for lookup rebuild");
    return { nameLookupBackground: {}, backgroundColors: {}, nameLookupForeground: {}, foregroundColors: {} };
  }

  const ng0 = decodePngToRgba(ng0Buf);
  const bg = decodePngToRgba(bgBuf);
  const fg = decodePngToRgba(fgBuf);

  function buildLookup(
    base: RawImageData,
    mapped: RawImageData,
  ): { nameLookup: Record<string, number>; colors: Record<number, number> } {
    const nameLookup: Record<string, number> = {};
    const colors: Record<number, number> = {};
    const len = Math.min(base.data.length, mapped.data.length);
    for (let i = 0; i < len; i += 4) {
      const c1 = (base.data[i] << 16) | (base.data[i + 1] << 8) | base.data[i + 2];
      const c2 = (mapped.data[i] << 16) | (mapped.data[i + 1] << 8) | mapped.data[i + 2];
      const biomeName = biomeColorConfig[String(c1)];
      if (biomeName) nameLookup[biomeName] = c2;
      colors[c1] = c2;
    }
    return { nameLookup, colors };
  }

  const { nameLookup: nameLookupBackground, colors: backgroundColors } = buildLookup(ng0, bg);
  const { nameLookup: nameLookupForeground, colors: foregroundColors } = buildLookup(ng0, fg);

  // Hard-coded extras from the library (biomes missing in NG+ biome map)
  nameLookupBackground["temple_altar_right_snowcave"] = 0x4e4132;
  backgroundColors[0x93cb4f] = 0x4e4132;
  nameLookupBackground["temple_altar_right_snowcastle"] = 0x4e4133;
  backgroundColors[0x93cb5a] = 0x4e4133;

  return { nameLookupBackground, backgroundColors, nameLookupForeground, foregroundColors };
}

/** Load a PNG from data.zip and return raw ArrayBuffer (no decoding). */
async function loadRawPngFromZip(telescopePath: string): Promise<ArrayBuffer | null> {
  const zipPath = telescopePathToZipPath(telescopePath);
  const zip = await getDataZip();
  if (!zip) return null;
  const file = zip.file(zipPath);
  if (!file) return null;
  return file.async("arraybuffer");
}
