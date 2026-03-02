/**
 * telescope-data-bridge.ts
 *
 * Bridges between data.zip (via data-archive.ts) and telescope's expected
 * `./data/...` fetch paths.
 *
 * Strategy: patch `window.fetch` so that any request to a `./data/...` URL
 * is intercepted, resolved from data.zip, and returned as a normal Response.
 * This lets ALL telescope code (loadPixelSceneData, sanitizePng, preload,
 * loadWangAsset) work unmodified — they just call fetch() and get zip data.
 */

import { getDataZip } from '../data-archive';

// ─── Path mapping ───────────────────────────────────────────────────────────

/**
 * Convert a telescope `./data/...` path to a data.zip entry path.
 */
function telescopePathToZipPath(telescopePath: string): string {
  // Normalise: strip leading './' or '/' and query strings
  let p = telescopePath.replace(/^\.\//, '').replace(/\?.*$/, '');

  // Wang tiles: data/wang_tiles/X.png → data/wang_tiles/X.png (same)
  if (p.startsWith('data/wang_tiles/')) return p;

  // Biome maps: data/biome_maps/X.png → data/biome_impl/X.png
  if (p.startsWith('data/biome_maps/')) {
    return p.replace('data/biome_maps/', 'data/biome_impl/');
  }

  // Pixel scenes: data/pixel_scenes/<biome>/<scene>.png → data/biome_impl/<biome>/<scene>.png
  // General scenes: data/pixel_scenes/general/<scene>.png → data/biome_impl/<scene>.png
  if (p.startsWith('data/pixel_scenes/')) {
    const rest = p.replace('data/pixel_scenes/', '');
    if (rest.startsWith('general/')) {
      return 'data/biome_impl/' + rest.replace('general/', '');
    }
    return 'data/biome_impl/' + rest;
  }

  // Item/spell/wand sprites: data/item_sprites/X → data/item_sprites/X (same)
  // data/spell_sprites/X → data/spell_sprites/X (same)
  // data/wand_sprites/X → data/wand_sprites/X (same)
  if (
    p.startsWith('data/item_sprites/') ||
    p.startsWith('data/spell_sprites/') ||
    p.startsWith('data/wand_sprites/')
  ) {
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
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    // Only intercept ./data/ relative paths
    if (!url.startsWith('./data/') && !url.startsWith('data/')) {
      return originalFetch(input, init);
    }

    const zipPath = telescopePathToZipPath(url);
    const zip = await getDataZip();
    if (!zip) {
      console.warn(`[DataBridge] data.zip not loaded, falling through for: ${url}`);
      return originalFetch(input, init);
    }

    const file = zip.file(zipPath);
    if (!file) {
      console.warn(`[DataBridge] Not found in zip: ${zipPath} (from ${url})`);
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }

    const buf = await file.async('arraybuffer');
    const ext = zipPath.split('.').pop()?.toLowerCase();
    let mime = 'application/octet-stream';
    if (ext === 'png') mime = 'image/png';
    else if (ext === 'json') mime = 'application/json';
    else if (ext === 'csv') mime = 'text/csv';
    else if (ext === 'xml') mime = 'text/xml';

    return new Response(buf, {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': mime },
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

// ─── Direct loaders (for adapter code that bypasses telescope's fetch) ──────

/**
 * Load a biome map PNG from data.zip and return as Uint32Array
 * (matching telescope's preload format: 0xFF000000 | R<<16 | G<<8 | B).
 */
export async function loadBiomeMapFromZip(
  telescopePath: string
): Promise<Uint32Array | null> {
  const zipPath = telescopePathToZipPath(telescopePath);
  const zip = await getDataZip();
  if (!zip) return null;

  const file = zip.file(zipPath);
  if (!file) {
    console.warn(`[DataBridge] Biome map not found: ${zipPath}`);
    return null;
  }

  const buf = await file.async('arraybuffer');
  const blob = new Blob([buf], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imgData;
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
    loadBiomeMapFromZip('./data/biome_maps/biome_map.png'),
    loadBiomeMapFromZip('./data/biome_maps/biome_map_newgame_plus.png'),
  ]);
  return { ng0, ngp };
}

/**
 * Pre-load wang tile data for a given generator config entry.
 * Returns the same format as telescope's loadWangAsset.
 */
export async function loadWangTileFromZip(
  telescopePath: string
): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const zipPath = telescopePathToZipPath(telescopePath);
  const zip = await getDataZip();
  if (!zip) return null;

  const file = zip.file(zipPath);
  if (!file) {
    console.warn(`[DataBridge] Wang tile not found: ${zipPath}`);
    return null;
  }

  // Use the fetch interceptor path (sanitizePng expects to fetch a URL)
  // Since the interceptor is installed, we can just use telescope's own
  // sanitizePng which calls fetch() internally.
  const buf = await file.async('arraybuffer');
  const blob = new Blob([buf], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imgData.data, width: imgData.width, height: imgData.height };
}
