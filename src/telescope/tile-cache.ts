/**
 * tile-cache.ts
 *
 * IndexedDB cache for telescope generation results.
 * Keyed by seed — stores raw tile buffers, biome data, and POIs.
 * No canvas blobs stored — overlays are recomputed from raw data on restore.
 * Prunes entries older than 30 days.
 */

const DB_NAME = "noitamap-telescope";
const DB_VERSION = 5; // bumped: composite cacheKey (seed-unlocks)
const STORE_NAME = "generations";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CachedTileLayer {
  biomeName: string;
  correctedX: number;
  correctedY: number;
  w: number;
  h: number;
  buffer: ArrayBuffer | null;
  width: number;
  height: number;
  mapH: number;
  minX: number;
  minY: number;
}

interface CachedGeneration {
  cacheKey: string;
  seed: number;
  timestamp: number;
  ngPlus: number;
  isNGP: boolean;
  worldSize: number;
  worldCenter: number;
  parallelWorlds: number[];
  tileLayers: CachedTileLayer[];
  biomeDataPixels: ArrayBuffer;
  biomeDataW: number;
  biomeDataH: number;
  poisByPW: Record<string, any[]>;
  pixelScenesByPW: Record<
    string,
    Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      name: string;
      key: string;
      variantKey: string;
      imgData: ArrayBuffer | null;
    }>
  >;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Delete old store if upgrading from v1 (had blob data)
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store a generation result in the cache.
 * Only stores raw data (buffers, biome pixels, POIs) — no canvas blobs.
 */
export async function cacheGeneration(cacheKey: string, seed: number, result: any): Promise<void> {
  try {
    const db = await openDB();

    // Serialize tile layer raw buffers (no canvas blobs)
    const tileLayers: CachedTileLayer[] = result.tileLayers.map((layer: any) => ({
      biomeName: layer.biomeName || "",
      correctedX: layer.correctedX,
      correctedY: layer.correctedY,
      w: layer.w,
      h: layer.h,
      buffer: layer.buffer
        ? layer.buffer.buffer.slice(layer.buffer.byteOffset, layer.buffer.byteOffset + layer.buffer.byteLength)
        : null,
      width: layer.width,
      height: layer.height,
      mapH: layer.mapH,
      minX: layer.minX,
      minY: layer.minY,
    }));

    // Store pixel scene metadata + raw imgElement RGBA data
    const pixelScenesByPW: Record<string, any[]> = {};
    for (const [pw, scenes] of Object.entries(result.pixelScenesByPW) as [string, any[]][]) {
      pixelScenesByPW[pw] = scenes.map((scene: any) => {
        // Extract raw RGBA bytes from imgElement for serialization
        let imgData: ArrayBuffer | null = null;
        if (scene.imgElement) {
          if (scene.imgElement instanceof Uint8Array || scene.imgElement instanceof Uint8ClampedArray) {
            imgData = scene.imgElement.buffer.slice(
              scene.imgElement.byteOffset,
              scene.imgElement.byteOffset + scene.imgElement.byteLength,
            );
          } else if (scene.imgElement instanceof HTMLCanvasElement) {
            const ctx = scene.imgElement.getContext("2d");
            if (ctx) {
              const id = ctx.getImageData(0, 0, scene.width, scene.height);
              imgData = id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength);
            }
          } else if (scene.imgElement instanceof OffscreenCanvas) {
            const ctx = scene.imgElement.getContext("2d");
            if (ctx) {
              const id = ctx.getImageData(0, 0, scene.width, scene.height);
              imgData = id.data.buffer.slice(id.data.byteOffset, id.data.byteOffset + id.data.byteLength);
            }
          }
        }
        return {
          x: scene.x,
          y: scene.y,
          width: scene.width,
          height: scene.height,
          name: scene.name,
          key: scene.key,
          variantKey: scene.variantKey || "",
          imgData,
        };
      });
    }

    const entry: CachedGeneration = {
      cacheKey,
      seed,
      timestamp: Date.now(),
      ngPlus: result.ngPlus,
      isNGP: result.isNGP,
      worldSize: result.worldSize,
      worldCenter: result.worldCenter,
      parallelWorlds: result.parallelWorlds || [-1, 0, 1],
      tileLayers,
      biomeDataPixels: result.biomeData?.pixels
        ? new Uint32Array(result.biomeData.pixels).buffer
        : new ArrayBuffer(0),
      biomeDataW: result.isNGP ? 72 : 70,
      biomeDataH: 48,
      poisByPW: result.poisByPW,
      pixelScenesByPW,
    };

    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
    console.log(`[TileCache] Cached generation for key ${cacheKey}`);
  } catch (e) {
    console.warn("[TileCache] Failed to cache generation:", e);
  }
}

/**
 * Retrieve a cached generation, or null if not found / expired.
 * Restores raw data only — no blob deserialization needed.
 */
export async function getCachedGeneration(cacheKey: string): Promise<any | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(cacheKey);

    const entry: CachedGeneration | undefined = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    db.close();

    if (!entry) return null;
    if (Date.now() - entry.timestamp > MAX_AGE_MS) {
      pruneOldEntries().catch(() => {});
      return null;
    }

    // Restore tile layers with raw buffers (no canvas — overlays recomputed)
    const tileLayers = entry.tileLayers.map((layer) => ({
      biomeName: layer.biomeName,
      canvas: null,
      correctedX: layer.correctedX,
      correctedY: layer.correctedY,
      w: layer.w,
      h: layer.h,
      buffer: layer.buffer ? new Uint8Array(layer.buffer) : null,
      width: layer.width,
      height: layer.height,
      mapH: layer.mapH,
      minX: layer.minX,
      minY: layer.minY,
    }));

    // Reconstruct biomeData with pixels, heavenPixels, and hellPixels
    let biomeData: any = { pixels: new Uint32Array(0), w: 0, h: 0 };
    if (entry.biomeDataPixels?.byteLength) {
      const pixels = new Uint32Array(entry.biomeDataPixels);
      // Derive w/h from isNGP; fall back to stored values for forward compat
      const w = (entry.biomeDataW > 0) ? entry.biomeDataW : (entry.isNGP ? 72 : 70);
      const h = (entry.biomeDataH > 0) ? entry.biomeDataH : 48;
      const heavenPixels = new Uint32Array(pixels.length);
      const hellPixels = new Uint32Array(pixels.length);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          heavenPixels[y * w + x] = pixels[x % w]; // Repeat first row
          hellPixels[y * w + x] = pixels[(h - 1) * w + (x % w)]; // Repeat last row
        }
      }

      biomeData = { pixels, heavenPixels, hellPixels, w, h };
    }
    // Restore pixel scene metadata + imgElement from cached RGBA data
    const pixelScenesByPW: Record<string, any[]> = {};
    for (const [pw, scenes] of Object.entries(entry.pixelScenesByPW)) {
      pixelScenesByPW[pw] = scenes.map((scene) => ({
        imgElement: scene.imgData ? new Uint8ClampedArray(scene.imgData) : null,
        x: scene.x,
        y: scene.y,
        width: scene.width,
        height: scene.height,
        name: scene.name,
        key: scene.key,
        variantKey: scene.variantKey || "",
      }));
    }

    console.log(`[TileCache] Cache hit for key ${cacheKey}`);
    return {
      cacheKey: entry.cacheKey,
      seed: entry.seed,
      ngPlus: entry.ngPlus,
      isNGP: entry.isNGP,
      worldSize: entry.worldSize,
      worldCenter: entry.worldCenter,
      parallelWorlds: entry.parallelWorlds,
      biomeData,
      tileLayers,
      poisByPW: entry.poisByPW,
      pixelScenesByPW,
    };
  } catch (e) {
    console.warn("[TileCache] Failed to read cache:", e);
    return null;
  }
}

/**
 * Prune entries older than MAX_AGE_MS.
 */
async function pruneOldEntries(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    const now = Date.now();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const entry = cursor.value as CachedGeneration;
      if (now - entry.timestamp > MAX_AGE_MS) {
        cursor.delete();
      }
      cursor.continue();
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[TileCache] Failed to prune:", e);
  }
}

/**
 * Completely clear the telescope generation cache.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    console.log("[TileCache] Cache cleared");
  } catch (e) {
    console.warn("[TileCache] Failed to clear cache:", e);
  }
}
