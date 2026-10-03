import { TERRAIN_VERSION } from "./terrain-policy";
/** Persistent completed tiles only. Browsing another zoom level must not
 * regenerate thousands of world pixels that were already rendered. */
import { OptionalCacheDatabase, warnCacheFailure } from "./cache-storage";
const database = new OptionalCacheDatabase(
  "noitamap-full-pixel-tiles",
  1,
  (db) => db.createObjectStore("tiles"),
);
let writeDisabled = false;
async function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    return await database.open();
  } catch {
    return null;
  }
}

// Canvas codecs and image decoders are optional storage work too. A browser
// that never calls toBlob's callback must not stop terrain refinement forever.
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terrain cache codec timed out")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    const blob = await database.read<Blob | undefined>(
      db.transaction("tiles").objectStore("tiles").get(key),
    );
    if (!blob) return null;
    let timedOut = false;
    const decoding = createImageBitmap(blob).then((bitmap) => {
      if (timedOut) bitmap.close();
      return bitmap;
    });
    const bitmap = await withDeadline(decoding).catch((error) => {
      timedOut = true;
      throw error;
    });
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
    const blob = await withDeadline(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Terrain tile encode failed")),
          "image/png",
        ),
      ),
    );
    const tx = db.transaction("tiles", "readwrite");
    tx.objectStore("tiles").put(blob, key);
    await database.complete(tx);
  } catch (error) {
    writeDisabled = true;
    warnCacheFailure(
      "[Terrain] persistent tile cache unavailable; keeping in-memory tiles",
      error,
    );
  }
}
