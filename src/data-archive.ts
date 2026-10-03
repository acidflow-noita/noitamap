/**
 * Runtime data.zip archive loader.
 * Fetches data.zip once, caches it, and provides typed accessors for
 * individual entries (text, blob, ImageBitmap, etc.).
 */
import JSZip from "jszip";
import { archiveRevisions } from "virtual:noitamap-data-archives";

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

/** Archive I/O is optional. A denied/full cache must not discard a usable ZIP. */
const isWorker = typeof document === "undefined";
const REVISION_HEADER = "X-Archive-Revision";
const CACHE_WAIT_MS = 1500;

async function optionalCache<T>(run: () => Promise<T>): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Archive cache timed out")),
          CACHE_WAIT_MS,
        );
      }),
    ]);
  } catch (error) {
    console.warn("[DataArchive] Optional archive cache unavailable:", error);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function openCache(key: string): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  return optionalCache(() => caches.open(`noitamap-archive-${key}-v2`));
}

async function digest(bytes: ArrayBuffer): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

async function cachedBytes(
  cache: Cache | undefined,
  url: string,
  revision: string,
) {
  if (!cache) return undefined;
  return optionalCache(async () => {
    const response = await cache.match(url);
    if (!response?.ok) return undefined;
    const storedRevision = response.headers.get(REVISION_HEADER);
    if (storedRevision && storedRevision !== revision) return undefined;
    const bytes = await response.arrayBuffer();
    // Accept old v2 entries only after verifying their actual content once.
    // This preserves existing downloads and the worker's cache-only path.
    if (storedRevision === revision || (await digest(bytes)) === revision)
      return { bytes, legacy: !storedRevision };
    return undefined;
  });
}

async function saveArchive(
  cache: Cache | undefined,
  url: string,
  bytes: ArrayBuffer,
  revision: string,
) {
  if (!cache) return;
  await optionalCache(() =>
    cache.put(
      url,
      new Response(bytes, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(bytes.byteLength),
          [REVISION_HEADER]: revision,
        },
      }),
    ),
  );
}

export function getZip(
  key: string = "main",
  silent: boolean = false,
): Promise<JSZip | null> {
  if (zips[key]) return Promise.resolve(zips[key]);
  if (zipPromises[key]) return zipPromises[key];
  const url = ZIP_URLS[key],
    revision = archiveRevisions[key];
  if (!url || !revision) {
    console.error(`[DataArchive] Unknown zip key: ${key}`);
    return Promise.resolve(null);
  }
  const pending = (
    isWorker
      ? loadZipWorker(key, url, revision)
      : loadZipMain(key, url, revision, silent)
  ).then((zip) => {
    if (zip) zips[key] = zip;
    else if (zipPromises[key] === pending) zipPromises[key] = null;
    return zip;
  });
  zipPromises[key] = pending;
  return pending;
}

/** Download, validate and persist an archive from the asset-preparation worker.
 * Normal generation workers remain cache-only. Never use this on the UI
 * thread: ZIP directory parsing and joining download chunks can be expensive. */
export async function prepareDataArchive(key: string, baseUrl: string): Promise<void> {
  if (!isWorker) throw new Error("Archive preparation requires a worker");
  const revision = archiveRevisions[key];
  const filename = key === "main" ? "data.zip" : `${key}.zip`;
  if (!ZIP_URLS[key] || !revision) throw new Error(`Unknown archive: ${key}`);
  const zip = await loadZipMain(key, new URL(filename, baseUrl).href, revision, true);
  if (!zip) throw new Error(`Cannot prepare ${key} archive`);
  // Do not retain duplicate parsed archives in this temporary worker. Their
  // validated compressed bytes are shared through the existing persistent cache.
}

/** Worker startup uses the current archive that main-thread readiness saved. */
async function loadZipWorker(
  key: string,
  url: string,
  revision: string,
): Promise<JSZip | null> {
  try {
    const cached = await cachedBytes(await openCache(key), url, revision);
    if (!cached) throw new Error(`${key}.zip current revision is not cached`);
    return await JSZip.loadAsync(cached.bytes);
  } catch (error) {
    console.warn(`[DataArchive/Worker] Cannot load ${key}.zip:`, error);
    return null;
  }
}

async function loadZipMain(
  key: string,
  url: string,
  revision: string,
  silent: boolean,
): Promise<JSZip | null> {
  const progress = (loaded: number, total: number) => {
    if (
      key === "main" &&
      !silent &&
      typeof window !== "undefined" &&
      typeof CustomEvent !== "undefined"
    )
      window.dispatchEvent(
        new CustomEvent("dataZipProgress", {
          detail: {
            loaded,
            total,
            percentage: Math.min(100, Math.round((loaded / total) * 100)),
          },
        }),
      );
  };
  const run = async (): Promise<JSZip | null> => {
    try {
      const cache = await openCache(key);
      const cached = await cachedBytes(cache, url, revision);
      if (cached) {
        try {
          const zip = await JSZip.loadAsync(cached.bytes);
          // Add the content revision to legacy entries for later zero-hash hits.
          if (cached.legacy)
            await saveArchive(cache, url, cached.bytes, revision);
          progress(100, 100);
          return zip;
        } catch (error) {
          console.warn(
            `[DataArchive] Cached ${key}.zip is damaged; downloading again:`,
            error,
          );
          if (cache) await optionalCache(() => cache.delete(url));
        }
      }
      const versioned = new URL(url);
      versioned.searchParams.set("v", revision);
      const response = await fetch(versioned.href);
      if (
        !response.ok ||
        response.headers.get("content-type")?.includes("text/html")
      )
        throw new Error(`${key}.zip download failed (HTTP ${response.status})`);
      const length = Number(response.headers.get("content-length"));
      const total = Number.isFinite(length) && length > 0 ? length : 0;
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          progress(loaded, total || Math.max(loaded, 25000000));
        }
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        chunks.push(bytes);
        loaded = bytes.length;
      }
      if (total && loaded < total)
        throw new Error(
          `Download truncated: expected ${total} bytes, received ${loaded}`,
        );
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const actualRevision = await digest(bytes.buffer);
      if (actualRevision && actualRevision !== revision)
        throw new Error(
          `${key}.zip does not match this build's archive revision`,
        );
      const zip = await JSZip.loadAsync(bytes.buffer);
      // Only verified bytes enter the persistent cache; insecure contexts may
      // lack both WebCrypto and CacheStorage but can still use the downloaded ZIP.
      if (actualRevision) await saveArchive(cache, url, bytes.buffer, revision);
      progress(100, 100);
      return zip;
    } catch (error) {
      console.error(`[DataArchive] Cannot load ${key}.zip:`, error);
      return null;
    }
  };
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CACHE_WAIT_MS);
    try {
      return await navigator.locks.request(
        `zip-fetch-${key}`,
        { signal: controller.signal },
        () => {
          // Bound acquisition only. The archive download may legitimately take
          // longer, and the lock must remain held until its cache write finishes.
          clearTimeout(timer);
          return run();
        },
      );
    } catch (error) {
      console.warn("[DataArchive] Archive lock unavailable:", error);
    } finally {
      clearTimeout(timer);
    }
  }
  return run();
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
