/**
 * Runtime data.zip archive loader.
 * Fetches data.zip once, caches it, and provides typed accessors for
 * individual entries (text, blob, ImageBitmap, etc.).
 */
import JSZip from "jszip";

function getBaseUrl() {
  if (typeof document !== "undefined") {
    // Main thread: resolve relative to current page
    return new URL("./", document.baseURI || location.href).href;
  }
  // Worker: Resolve to the root origin to avoid fetching from /assets/
  return new URL("/", self.location.href).href;
}

const BASE_URL = getBaseUrl();
const ZIP_URLS: Record<string, string> = {
  main: BASE_URL + "data.zip",
  pixel_scenes: BASE_URL + "pixel_scenes.zip",
  wang_tiles: BASE_URL + "wang_tiles.zip",
};

const zipPromises: Record<string, Promise<JSZip | null> | null> = {};
const zips: Record<string, JSZip | null> = {};

/**
 * Lazily fetch and cache a zip archive.
 */
const isWorker = typeof document === "undefined";

export async function getZip(key: string = "main", silent: boolean = false): Promise<JSZip | null> {
  if (zips[key]) return zips[key];
  if (zipPromises[key]) return zipPromises[key];

  const url = ZIP_URLS[key];
  if (!url) {
    console.error(`[DataArchive] Unknown zip key: ${key}`);
    return null;
  }

  zipPromises[key] = isWorker ? _loadZipWorkerFast(key, url) : _loadZipMainThread(key, url, silent);

  return zipPromises[key];
}

/** Worker fast path: read from Cache API, parse, done. No locks, no HEAD, no network. */
async function _loadZipWorkerFast(key: string, url: string): Promise<JSZip | null> {
  try {
    const t0 = performance.now();
    const cache = await caches.open(`noitamap-archive-${key}-v2`);
    const response = await cache.match(url);
    if (!response || !response.ok) {
      console.warn(`[DataArchive/Worker] ${key}.zip not in cache, cannot load`);
      return null;
    }
    const buf = await response.arrayBuffer();
    const instance = await JSZip.loadAsync(buf);
    zips[key] = instance;
    console.log(`[DataArchive/Worker] ${key}.zip ready in ${(performance.now() - t0).toFixed(0)}ms`);
    return instance;
  } catch (e) {
    console.error(`[DataArchive/Worker] Failed to load ${key}.zip:`, e);
    return null;
  }
}

/** Main thread path: HEAD validation, lock, network fetch with progress, cache write. */
async function _loadZipMainThread(key: string, url: string, silent: boolean): Promise<JSZip | null> {
  return new Promise((resolve) => {
    const run = async () => {
      try {
        // Re-check after acquiring lock (another tab may have loaded it)
        if (zips[key]) { resolve(zips[key]); return; }

        console.log(`[DataArchive] Loading ${url}...`);

      // Cache Storage API requires secure context (HTTPS). iOS Safari on
      // plain HTTP has no `caches` — fall through to network-only.
      const cachesAvailable = typeof caches !== "undefined";
      const cacheName = `noitamap-archive-${key}-v2`;
      const cache = cachesAvailable ? await caches.open(cacheName) : null;

      // HEAD request to validate cache freshness
      let serverMeta = "";
      try {
        const headResp = await fetch(url, { method: "HEAD", cache: "no-cache" });
        if (headResp.ok) {
          serverMeta =
            headResp.headers.get("ETag") ||
            headResp.headers.get("Last-Modified") ||
            headResp.headers.get("Content-Length") ||
            "";
        }
      } catch (e) {
        console.warn(`[DataArchive] HEAD request failed for ${url}, falling back to cache if available`, e);
      }

      let response = cache ? await cache.match(url) : null;
      let buf: ArrayBuffer | null = null;
      let shouldUseCache = false;

      if (response && response.ok) {
        const cachedMeta = response.headers.get("X-Archive-Meta");
        if (serverMeta && cachedMeta === serverMeta) {
          shouldUseCache = true;
        } else if (!serverMeta) {
          shouldUseCache = true;
        } else {
          console.log(`[DataArchive] Cache invalidated for ${url}! Server: ${serverMeta}, Cached: ${cachedMeta}`);
        }
      }

      if (shouldUseCache && response) {
        console.log(`[DataArchive] Loaded ${url} from Cache API`);
        buf = await response.arrayBuffer();

        if (key === "main" && !silent) {
          if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("dataZipProgress", { detail: { loaded: 100, total: 100, percentage: 100 } }),
            );
          }
        }
      } else {
        console.log(`[DataArchive] Fetching ${url} from network...`);
        const fetchResp = await fetch(url);

        if (!fetchResp.ok) {
          console.warn(`${url} fetch failed (${fetchResp.status})`);
          resolve(null);
          return;
        }

        const contentType = fetchResp.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          console.warn(`[DataArchive] ${url} returned HTML fallback, skipping and resolving null`);
          resolve(null);
          return;
        }

        const contentLength = fetchResp.headers.get("content-length");
        const totalBytes = contentLength ? parseInt(contentLength, 10) : 25000000;

        let loadedBytes = 0;
        const reader = fetchResp.body!.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            chunks.push(value);
            loadedBytes += value.length;

            if (key === "main" && !silent) {
              const percentage = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
              if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("dataZipProgress", {
                    detail: { loaded: loadedBytes, total: totalBytes, percentage },
                  }),
                );
              }
            }
          }
        }
        
        if (totalBytes > 0 && loadedBytes < totalBytes) {
          throw new Error(`Download truncated: expected ${totalBytes} bytes, stream ended at ${loadedBytes}`);
        }

        const combined = new Uint8Array(loadedBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        buf = combined.buffer;

        const headers = new Headers(fetchResp.headers);
        if (serverMeta) {
          headers.set("X-Archive-Meta", serverMeta);
        }
        const cacheResponse = new Response(buf, {
          status: fetchResp.status,
          statusText: fetchResp.statusText,
          headers: headers,
        });
        if (cache) await cache.put(url, cacheResponse);
      }

      if (!buf) throw new Error(`Failed to obtain array buffer for ${url}`);

      const instance = await JSZip.loadAsync(buf);
      zips[key] = instance;
      console.log(`[DataArchive] ${url} loaded and ready`);
      resolve(instance);
    } catch (e) {
      console.error(`[DataArchive] Failed to load ${url}:`, e);
      try {
        if (typeof caches !== "undefined") await caches.delete(`noitamap-archive-${key}-v2`);
      } catch (err) {}
      resolve(null);
    }
    }; // end run()
    // Web Locks API requires a secure context (HTTPS). In HTTP dev or
    // restricted contexts (some private tabs), navigator.locks is undefined.
    // Fall back to running without a cross-tab lock.
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      navigator.locks.request(`zip-fetch-${key}`, run);
    } else {
      run();
    }
  }); // end new Promise
}

/** Legacy alias */
export async function getDataZip(): Promise<JSZip | null> {
  return getZip("main", false);
}

/**
 * Read a text file from one of the zip archives.
 */
export async function readText(path: string, zipKey: string = "main", silent: boolean = false): Promise<string | null> {
  const z = await getZip(zipKey, silent);
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    console.warn(`[DataArchive] Missing: ${path} in ${zipKey}`);
    return null;
  }
  try {
    return await file.async("string");
  } catch (e) {
    console.error(`[DataArchive] Corrupted text file ${path}:`, e);
    return null;
  }
}

/**
 * Read a binary file from one of the zip archives as a Blob.
 */
export async function readBlob(
  path: string,
  mimeType?: string,
  zipKey: string = "main",
  silent: boolean = false,
): Promise<Blob | null> {
  const z = await getZip(zipKey, silent);
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    // Silent fail for multi-zip searching
    return null;
  }
  try {
    const buf = await file.async("arraybuffer");
    return new Blob([buf], mimeType ? { type: mimeType } : undefined);
  } catch (e) {
    console.error(`[DataArchive] Corrupted binary file ${path}:`, e);
    return null;
  }
}

/**
 * Read an image from one of the zip archives as an ImageBitmap.
 */
export async function readImage(
  path: string,
  zipKey: string = "main",
  silent: boolean = false,
): Promise<ImageBitmap | null> {
  const blob = await readBlob(path, "image/png", zipKey, silent);
  if (!blob) return null;
  return createImageBitmap(blob);
}

/**
 * Read a PNG from one of the zip archives and return it as ImageData.
 */
export async function readImageData(path: string, zipKey: string = "main"): Promise<ImageData | null> {
  const blob = await readBlob(path, "image/png", zipKey);
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  let canvas: any;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
  } else {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  }
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Read a PNG from one of the zip archives and return it as an OffscreenCanvas (worker safe) or HTMLCanvasElement.
 */
export async function readCanvas(path: string, zipKey: string = "main"): Promise<HTMLCanvasElement | OffscreenCanvas | null> {
  const blob = await readBlob(path, "image/png", zipKey);
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  
  let canvas: any;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
  } else {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  }
  
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * List all entries in a zip archive matching a prefix.
 */
export async function listEntries(prefix: string, zipKey: string = "main"): Promise<string[]> {
  const z = await getZip(zipKey);
  if (!z) return [];
  const entries: string[] = [];
  z.forEach((relativePath) => {
    if (relativePath.startsWith(prefix)) {
      entries.push(relativePath);
    }
  });
  return entries;
}
