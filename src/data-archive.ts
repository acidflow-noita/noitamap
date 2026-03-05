/**
 * Runtime data.zip archive loader.
 * Fetches data.zip once, caches it, and provides typed accessors for
 * individual entries (text, blob, ImageBitmap, etc.).
 */
import JSZip from "jszip";

const DATA_ZIP_URL = "./data.zip";

let zipPromise: Promise<JSZip | null> | null = null;
let zip: JSZip | null = null;

/**
 * Lazily fetch and cache data.zip. Subsequent calls return the same instance.
 */
export async function getDataZip(): Promise<JSZip | null> {
  if (zip) return zip;
  if (zipPromise) return zipPromise;

  zipPromise = (async () => {
    try {
      console.log("[DataArchive] Loading data.zip...");

      const cacheName = "noitamap-data-archive-v2";
      const cache = await caches.open(cacheName);

      // 1. Do a quick HEAD request to get the latest file metadata from the server
      let serverMeta = "";
      try {
        const headResp = await fetch(DATA_ZIP_URL, { method: "HEAD", cache: "no-cache" });
        if (headResp.ok) {
          serverMeta =
            headResp.headers.get("ETag") ||
            headResp.headers.get("Last-Modified") ||
            headResp.headers.get("Content-Length") ||
            "";
        }
      } catch (e) {
        console.warn("[DataArchive] HEAD request failed, falling back to cache if available", e);
      }

      let response = await cache.match(DATA_ZIP_URL);
      let buf: ArrayBuffer | null = null;
      let shouldUseCache = false;

      if (response && response.ok) {
        const cachedMeta = response.headers.get("X-Archive-Meta");
        if (serverMeta && cachedMeta === serverMeta) {
          shouldUseCache = true;
        } else if (!serverMeta) {
          // Offline or HEAD failed, assume cache is valid
          shouldUseCache = true;
        } else {
          console.log(`[DataArchive] Cache invalidated! Server: ${serverMeta}, Cached: ${cachedMeta}`);
        }
      }

      if (shouldUseCache && response) {
        console.log("[DataArchive] Loaded data.zip from Cache API");
        buf = await response.arrayBuffer();

        // Dispatch instant completion event
        window.dispatchEvent(
          new CustomEvent("dataZipProgress", { detail: { loaded: 100, total: 100, percentage: 100 } }),
        );
      } else {
        console.log("[DataArchive] Fetching data.zip from network...");
        const fetchResp = await fetch(DATA_ZIP_URL);

        if (!fetchResp.ok) {
          console.warn(`data.zip fetch failed (${fetchResp.status})`);
          return null;
        }

        const contentLength = fetchResp.headers.get("content-length");
        const totalBytes = contentLength ? parseInt(contentLength, 10) : 25000000; // fallback est ~25MB

        // Setup ReadableStream to track progress
        let loadedBytes = 0;
        const reader = fetchResp.body!.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            chunks.push(value);
            loadedBytes += value.length;

            const percentage = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
            window.dispatchEvent(
              new CustomEvent("dataZipProgress", {
                detail: { loaded: loadedBytes, total: totalBytes, percentage },
              }),
            );
          }
        }

        // Combine chunks
        const combined = new Uint8Array(loadedBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        buf = combined.buffer;

        // Save to cache for next time
        const headers = new Headers(fetchResp.headers);
        if (serverMeta) {
          headers.set("X-Archive-Meta", serverMeta);
        }
        const cacheResponse = new Response(buf, {
          status: fetchResp.status,
          statusText: fetchResp.statusText,
          headers: headers,
        });
        await cache.put(DATA_ZIP_URL, cacheResponse);
      }

      if (!buf) throw new Error("Failed to obtain array buffer for data.zip");

      zip = await JSZip.loadAsync(buf);
      console.log("[DataArchive] data.zip loaded and ready");
      return zip;
    } catch (e) {
      console.error("[DataArchive] Failed to load data.zip:", e);
      return null;
    }
  })();

  return zipPromise;
}

/**
 * Read a text file from data.zip.
 */
export async function readText(path: string): Promise<string | null> {
  const z = await getDataZip();
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    console.warn(`[DataArchive] Missing: ${path}`);
    return null;
  }
  return file.async("string");
}

/**
 * Read a binary file from data.zip as a Blob.
 */
export async function readBlob(path: string, mimeType?: string): Promise<Blob | null> {
  const z = await getDataZip();
  if (!z) return null;
  const file = z.file(path);
  if (!file) {
    console.warn(`[DataArchive] Missing: ${path}`);
    return null;
  }
  const buf = await file.async("arraybuffer");
  return new Blob([buf], mimeType ? { type: mimeType } : undefined);
}

/**
 * Read an image from data.zip as an ImageBitmap.
 */
export async function readImage(path: string): Promise<ImageBitmap | null> {
  const blob = await readBlob(path, "image/png");
  if (!blob) return null;
  return createImageBitmap(blob);
}

/**
 * Read a PNG from data.zip and return it as ImageData.
 */
export async function readImageData(path: string): Promise<ImageData | null> {
  const blob = await readBlob(path, "image/png");
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
 * Read a PNG from data.zip and return it as an HTMLCanvasElement.
 */
export async function readCanvas(path: string): Promise<HTMLCanvasElement | null> {
  const blob = await readBlob(path, "image/png");
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
 * List all entries in data.zip matching a prefix.
 */
export async function listEntries(prefix: string): Promise<string[]> {
  const z = await getDataZip();
  if (!z) return [];
  const entries: string[] = [];
  z.forEach((relativePath) => {
    if (relativePath.startsWith(prefix)) {
      entries.push(relativePath);
    }
  });
  return entries;
}
