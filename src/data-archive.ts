/**
 * Runtime data.zip archive loader.
 * Fetches data.zip once, caches it, and provides typed accessors for
 * individual entries (text, blob, ImageBitmap, etc.).
 */
import JSZip from "jszip";

const ZIP_URLS: Record<string, string> = {
  main: "./data.zip",
  pixel_scenes: "./pixel_scenes.zip",
  wang_tiles: "./wang_tiles.zip",
};

const zipPromises: Record<string, Promise<JSZip | null> | null> = {};
const zips: Record<string, JSZip | null> = {};

/**
 * Lazily fetch and cache a zip archive.
 */
export async function getZip(key: string = "main"): Promise<JSZip | null> {
  if (zips[key]) return zips[key];
  if (zipPromises[key]) return zipPromises[key];

  const url = ZIP_URLS[key];
  if (!url) {
    console.error(`[DataArchive] Unknown zip key: ${key}`);
    return null;
  }

  zipPromises[key] = (async () => {
    try {
      console.log(`[DataArchive] Loading ${url}...`);

      const cacheName = `noitamap-archive-${key}-v2`;
      const cache = await caches.open(cacheName);

      // 1. Do a quick HEAD request to get the latest file metadata from the server
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

      let response = await cache.match(url);
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

        if (key === "main") {
          window.dispatchEvent(
            new CustomEvent("dataZipProgress", { detail: { loaded: 100, total: 100, percentage: 100 } }),
          );
        }
      } else {
        console.log(`[DataArchive] Fetching ${url} from network...`);
        const fetchResp = await fetch(url);

        if (!fetchResp.ok) {
          console.warn(`${url} fetch failed (${fetchResp.status})`);
          return null;
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

            if (key === "main") {
              const percentage = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
              window.dispatchEvent(
                new CustomEvent("dataZipProgress", {
                  detail: { loaded: loadedBytes, total: totalBytes, percentage },
                }),
              );
            }
          }
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
        await cache.put(url, cacheResponse);
      }

      if (!buf) throw new Error(`Failed to obtain array buffer for ${url}`);

      const instance = await JSZip.loadAsync(buf);
      zips[key] = instance;
      console.log(`[DataArchive] ${url} loaded and ready`);
      return instance;
    } catch (e) {
      console.error(`[DataArchive] Failed to load ${url}:`, e);
      return null;
    }
  })();

  return zipPromises[key];
}

/** Legacy alias */
export async function getDataZip(): Promise<JSZip | null> {
  return getZip("main");
}

/**
 * Read a text file from one of the zip archives.
 */
export async function readText(path: string, zipKey: string = "main"): Promise<string | null> {
  const z = await getZip(zipKey);
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    console.warn(`[DataArchive] Missing: ${path} in ${zipKey}`);
    return null;
  }
  return file.async("string");
}

/**
 * Read a binary file from one of the zip archives as a Blob.
 */
export async function readBlob(path: string, mimeType?: string, zipKey: string = "main"): Promise<Blob | null> {
  const z = await getZip(zipKey);
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    // Silent fail for multi-zip searching
    return null;
  }
  const buf = await file.async("arraybuffer");
  return new Blob([buf], mimeType ? { type: mimeType } : undefined);
}

/**
 * Read an image from one of the zip archives as an ImageBitmap.
 */
export async function readImage(path: string, zipKey: string = "main"): Promise<ImageBitmap | null> {
  const blob = await readBlob(path, "image/png", zipKey);
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
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Read a PNG from one of the zip archives and return it as an HTMLCanvasElement.
 */
export async function readCanvas(path: string, zipKey: string = "main"): Promise<HTMLCanvasElement | null> {
  const blob = await readBlob(path, "image/png", zipKey);
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
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
