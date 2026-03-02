/**
 * tile-cache.ts
 *
 * IndexedDB cache for telescope generation results.
 * Keyed by seed — stores serialized tile canvases, POI data, and pixel scenes.
 * Prunes entries older than 30 days.
 */

const DB_NAME = 'noitamap-telescope';
const DB_VERSION = 1;
const STORE_NAME = 'generations';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CachedGeneration {
  seed: number;
  timestamp: number;
  tileLayers: Array<{
    blob: Blob;
    correctedX: number;
    correctedY: number;
    w: number;
    h: number;
  }>;
  poisByPW: Record<string, any[]>;
  pixelScenesByPW: Record<string, Array<{
    blob: Blob;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    key: string;
  }>>;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'seed' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Serialize a canvas to a Blob (PNG).
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed'));
    }, 'image/png');
  });
}

/**
 * Deserialize a Blob back to a canvas.
 */
async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * Store a generation result in the cache.
 */
export async function cacheGeneration(seed: number, result: any): Promise<void> {
  try {
    const db = await openDB();

    // Serialize tile layer canvases to blobs
    const tileLayers = await Promise.all(
      result.tileLayers.map(async (layer: any) => ({
        blob: layer.canvas ? await canvasToBlob(layer.canvas) : null,
        correctedX: layer.correctedX,
        correctedY: layer.correctedY,
        w: layer.w,
        h: layer.h,
      }))
    );

    // Serialize pixel scene canvases to blobs
    const pixelScenesByPW: Record<string, any[]> = {};
    for (const [pw, scenes] of Object.entries(result.pixelScenesByPW) as [string, any[]][]) {
      pixelScenesByPW[pw] = await Promise.all(
        scenes.map(async (scene: any) => ({
          blob: scene.imgElement ? await canvasToBlob(scene.imgElement) : null,
          x: scene.x,
          y: scene.y,
          width: scene.width,
          height: scene.height,
          name: scene.name,
          key: scene.key,
        }))
      );
    }

    const entry: CachedGeneration = {
      seed,
      timestamp: Date.now(),
      tileLayers,
      poisByPW: result.poisByPW,
      pixelScenesByPW,
    };

    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
    console.log(`[TileCache] Cached generation for seed ${seed}`);
  } catch (e) {
    console.warn('[TileCache] Failed to cache generation:', e);
  }
}

/**
 * Retrieve a cached generation, or null if not found / expired.
 */
export async function getCachedGeneration(seed: number): Promise<any | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(seed);

    const entry: CachedGeneration | undefined = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    db.close();

    if (!entry) return null;
    if (Date.now() - entry.timestamp > MAX_AGE_MS) {
      // Expired — don't use, but don't block on deleting it
      pruneOldEntries().catch(() => {});
      return null;
    }

    // Deserialize blobs back to canvases
    const tileLayers = await Promise.all(
      entry.tileLayers.map(async (layer) => ({
        canvas: layer.blob ? await blobToCanvas(layer.blob) : null,
        correctedX: layer.correctedX,
        correctedY: layer.correctedY,
        w: layer.w,
        h: layer.h,
      }))
    );

    const pixelScenesByPW: Record<string, any[]> = {};
    for (const [pw, scenes] of Object.entries(entry.pixelScenesByPW)) {
      pixelScenesByPW[pw] = await Promise.all(
        scenes.map(async (scene) => ({
          imgElement: scene.blob ? await blobToCanvas(scene.blob) : null,
          x: scene.x,
          y: scene.y,
          width: scene.width,
          height: scene.height,
          name: scene.name,
          key: scene.key,
        }))
      );
    }

    console.log(`[TileCache] Cache hit for seed ${seed}`);
    return {
      tileLayers,
      poisByPW: entry.poisByPW,
      pixelScenesByPW,
    };
  } catch (e) {
    console.warn('[TileCache] Failed to read cache:', e);
    return null;
  }
}

/**
 * Prune entries older than MAX_AGE_MS.
 */
async function pruneOldEntries(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
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
    console.warn('[TileCache] Failed to prune:', e);
  }
}
