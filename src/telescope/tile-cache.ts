/**
 * tile-cache.ts
 *
 * IndexedDB cache for telescope generation results.
 * Keyed by seed — stores raw tile buffers, biome data, and POIs.
 * Also stores rendered biome layer blobs per (pw, pvt) so cache hits skip
 * the ~1.5-2s of CPU-bound tile-overlay generation on reload.
 * Prunes entries older than 30 days.
 */

const DB_NAME = "noitamap-telescope";
const DB_VERSION = 9; // bumped: drop imgData from generation entries (FF was 2.4s/read)
const STORE_NAME = "generations";
const RENDER_STORE_NAME = "biome_renders";
const SCENE_BITMAP_STORE_NAME = "pixel_scene_bitmaps";
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

export interface CachedBiomeRender {
  /** "${cacheKey}|${pw},${pvt}" */
  renderKey: string;
  cacheKey: string;
  timestamp: number;
  pw: number;
  pvt: number;
  blob: Blob;
  minX: number;
  minY: number;
  osdWidth: number;
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
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      // Bumping past v5 (the schema-change version) wiped data. From v6 onward
      // the upgrade is additive — keep existing cached generations when adding
      // new stores.
      if (oldVersion < 5) {
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      } else if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(RENDER_STORE_NAME)) {
        const renderStore = db.createObjectStore(RENDER_STORE_NAME, { keyPath: "renderKey" });
        renderStore.createIndex("cacheKey", "cacheKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(SCENE_BITMAP_STORE_NAME)) {
        db.createObjectStore(SCENE_BITMAP_STORE_NAME, { keyPath: "key" });
      } else if (oldVersion < 8) {
        // v8 fixes the temple/single-layer scene sizing bug — wipe the bitmap
        // store so cached corrupt bitmaps get re-composited.
        db.deleteObjectStore(SCENE_BITMAP_STORE_NAME);
        db.createObjectStore(SCENE_BITMAP_STORE_NAME, { keyPath: "key" });
      }
      // v9: generation entries bundled imgData per pixel scene (~MBs each).
      // Cache reads were taking ~2.4s on FF. Drop those entries; new ones
      // are written without imgData.
      if (oldVersion >= 5 && oldVersion < 9 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
        db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      }
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

    // Store pixel scene metadata only. We deliberately do NOT serialise
    // imgElement/imgData anymore — those bytes are duplicated:
    //   - PIXEL_SCENE_DATA[key].imgElement holds them on the main thread
    //   - pixel_scene_bitmaps store holds the composited PNG-encoded blob
    // Persisting them here used to inflate each generation entry to many MB,
    // which made `getCachedGeneration` take ~2-3s on FF (per IDB read).
    const pixelScenesByPW: Record<string, any[]> = {};
    for (const [pw, scenes] of Object.entries(result.pixelScenesByPW) as [string, any[]][]) {
      pixelScenesByPW[pw] = scenes.map((scene: any) => {
        return {
          x: scene.x,
          y: scene.y,
          width: scene.width,
          height: scene.height,
          name: scene.name,
          key: scene.key,
          variantKey: scene.variantKey || "",
          imgData: null,
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
    const tx = db.transaction([STORE_NAME, RENDER_STORE_NAME, SCENE_BITMAP_STORE_NAME], "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.objectStore(RENDER_STORE_NAME).clear();
    tx.objectStore(SCENE_BITMAP_STORE_NAME).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    console.log("[TileCache] Cache cleared (generations + biome_renders + pixel_scene_bitmaps)");
  } catch (e) {
    console.warn("[TileCache] Failed to clear cache:", e);
  }
}

// ─── Biome render cache (rendered blobs per pw,pvt) ─────────────────────────

function renderKeyFor(cacheKey: string, pw: number, pvt: number): string {
  return `${cacheKey}|${pw},${pvt}`;
}

export async function getCachedBiomeRender(
  cacheKey: string,
  pw: number,
  pvt: number,
): Promise<CachedBiomeRender | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(RENDER_STORE_NAME, "readonly");
    const req = tx.objectStore(RENDER_STORE_NAME).get(renderKeyFor(cacheKey, pw, pvt));
    const entry: CachedBiomeRender | undefined = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MAX_AGE_MS) return null;
    return entry;
  } catch (e) {
    console.warn("[TileCache] Failed to read biome render cache:", e);
    return null;
  }
}

export async function cacheBiomeRender(
  cacheKey: string,
  pw: number,
  pvt: number,
  blob: Blob,
  geom: { minX: number; minY: number; osdWidth: number },
): Promise<void> {
  try {
    const db = await openDB();
    const entry: CachedBiomeRender = {
      renderKey: renderKeyFor(cacheKey, pw, pvt),
      cacheKey,
      timestamp: Date.now(),
      pw,
      pvt,
      blob,
      minX: geom.minX,
      minY: geom.minY,
      osdWidth: geom.osdWidth,
    };
    const tx = db.transaction(RENDER_STORE_NAME, "readwrite");
    tx.objectStore(RENDER_STORE_NAME).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[TileCache] Failed to cache biome render:", e);
  }
}

// ─── Pixel scene bitmap cache (seed-independent, by scene key) ─────────────

export interface CachedSceneBitmap {
  key: string;
  blob: Blob;
  width: number;
  height: number;
  timestamp: number;
}

export async function getCachedSceneBitmap(key: string): Promise<CachedSceneBitmap | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(SCENE_BITMAP_STORE_NAME, "readonly");
    const req = tx.objectStore(SCENE_BITMAP_STORE_NAME).get(key);
    const entry: CachedSceneBitmap | undefined = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MAX_AGE_MS) return null;
    return entry;
  } catch (e) {
    console.warn("[TileCache] Failed to read scene bitmap cache:", e);
    return null;
  }
}

/**
 * Bulk fetch many scene bitmaps in one IDB transaction. Far faster than N
 * single-key lookups in browsers with high per-transaction overhead (Brave, FF).
 */
export async function getCachedSceneBitmapsBulk(keys: string[]): Promise<Map<string, CachedSceneBitmap>> {
  const result = new Map<string, CachedSceneBitmap>();
  if (keys.length === 0) return result;
  try {
    const db = await openDB();
    const tx = db.transaction(SCENE_BITMAP_STORE_NAME, "readonly");
    const store = tx.objectStore(SCENE_BITMAP_STORE_NAME);
    const now = Date.now();
    await Promise.all(
      keys.map(
        (key) =>
          new Promise<void>((resolve) => {
            const req = store.get(key);
            req.onsuccess = () => {
              const entry = req.result as CachedSceneBitmap | undefined;
              if (entry && now - entry.timestamp <= MAX_AGE_MS) {
                result.set(key, entry);
              }
              resolve();
            };
            req.onerror = () => resolve();
          }),
      ),
    );
    db.close();
  } catch (e) {
    console.warn("[TileCache] Failed bulk scene bitmap read:", e);
  }
  return result;
}

/**
 * Bulk fetch every cached biome render for a generation cacheKey in one IDB
 * transaction. Returns a map keyed by "pw,pvt".
 */
export async function getCachedBiomeRendersForKey(cacheKey: string): Promise<Map<string, CachedBiomeRender>> {
  const result = new Map<string, CachedBiomeRender>();
  try {
    const db = await openDB();
    const tx = db.transaction(RENDER_STORE_NAME, "readonly");
    const store = tx.objectStore(RENDER_STORE_NAME);
    const idxReq = store.index("cacheKey").getAll(cacheKey);
    const entries: CachedBiomeRender[] = await new Promise((resolve) => {
      idxReq.onsuccess = () => resolve((idxReq.result as CachedBiomeRender[]) || []);
      idxReq.onerror = () => resolve([]);
    });
    db.close();
    const now = Date.now();
    for (const e of entries) {
      if (now - e.timestamp <= MAX_AGE_MS) {
        result.set(`${e.pw},${e.pvt}`, e);
      }
    }
  } catch (e) {
    console.warn("[TileCache] Failed bulk biome render read:", e);
  }
  return result;
}

export async function getCachedSceneBitmapKeys(): Promise<Set<string>> {
  try {
    const db = await openDB();
    const tx = db.transaction(SCENE_BITMAP_STORE_NAME, "readonly");
    const req = tx.objectStore(SCENE_BITMAP_STORE_NAME).getAllKeys();
    const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return new Set(keys.map((k) => String(k)));
  } catch (e) {
    console.warn("[TileCache] Failed to read scene bitmap keys:", e);
    return new Set();
  }
}

export async function cacheSceneBitmap(key: string, blob: Blob, width: number, height: number): Promise<void> {
  try {
    const db = await openDB();
    const entry: CachedSceneBitmap = { key, blob, width, height, timestamp: Date.now() };
    const tx = db.transaction(SCENE_BITMAP_STORE_NAME, "readwrite");
    tx.objectStore(SCENE_BITMAP_STORE_NAME).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[TileCache] Failed to cache scene bitmap:", e);
  }
}

