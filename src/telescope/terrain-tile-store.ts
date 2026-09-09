import { TERRAIN_VERSION } from "./terrain-policy";
/** Persistent completed tiles only. Browsing another zoom level must not
 * regenerate thousands of world pixels that were already rendered. */
let database: Promise<IDBDatabase | null> | undefined;
let disabled = false;
let writeDisabled = false;
function open(): Promise<IDBDatabase | null> {
  if (disabled || typeof indexedDB === "undefined")
    return Promise.resolve(null);
  return (database ??= new Promise((resolve) => {
    const request = indexedDB.open("noitamap-full-pixel-tiles", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tiles");
    request.onerror = () => {
      disabled = true;
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
  }));
}
export function terrainTileKey(
  seed: number,
  mode: string,
  plane: number,
  pw: number,
  bounds: string,
  level: number,
  x: number,
  y: number,
): string {
  return `${TERRAIN_VERSION}/${seed}/${mode}/${plane}/${pw}/${bounds}/${level}/${x}/${y}`;
}
export async function readTerrainTile(
  key: string,
): Promise<HTMLCanvasElement | null> {
  const db = await open();
  if (!db) return null;
  try {
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const r = db.transaction("tiles").objectStore("tiles").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  } catch {
    return null;
  }
}
export async function writeTerrainTile(
  key: string,
  canvas: HTMLCanvasElement,
): Promise<void> {
  if (writeDisabled) return;
  const db = await open();
  if (!db) return;
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error("Terrain tile encode failed")),
        "image/png",
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("tiles", "readwrite");
      tx.objectStore("tiles").put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    writeDisabled = true;
    console.warn(
      "[Terrain] persistent tile cache unavailable; keeping in-memory tiles",
      error,
    );
  }
}
