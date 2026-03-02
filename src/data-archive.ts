/**
 * Runtime data.zip archive loader.
 * Fetches data.zip once, caches it, and provides typed accessors for
 * individual entries (text, blob, ImageBitmap, etc.).
 */
import JSZip from 'jszip';

const DATA_ZIP_URL = './data.zip';

let zipPromise: Promise<JSZip | null> | null = null;
let zip: JSZip | null = null;

/**
 * Lazily fetch and cache data.zip.  Subsequent calls return the same instance.
 */
export async function getDataZip(): Promise<JSZip | null> {
  if (zip) return zip;
  if (!zipPromise) {
    zipPromise = (async () => {
      try {
        const resp = await fetch(DATA_ZIP_URL);
        if (!resp.ok) {
          console.warn(`data.zip fetch failed (${resp.status})`);
          return null;
        }
        const buf = await resp.arrayBuffer();
        zip = await JSZip.loadAsync(buf);
        console.log('[DataArchive] data.zip loaded');
        return zip;
      } catch (e) {
        console.error('[DataArchive] Failed to load data.zip:', e);
        return null;
      }
    })();
  }
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
  return file.async('string');
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
  const buf = await file.async('arraybuffer');
  return new Blob([buf], mimeType ? { type: mimeType } : undefined);
}

/**
 * Read an image from data.zip as an ImageBitmap.
 */
export async function readImage(path: string): Promise<ImageBitmap | null> {
  const blob = await readBlob(path, 'image/png');
  if (!blob) return null;
  return createImageBitmap(blob);
}

/**
 * Read a PNG from data.zip and return it as ImageData.
 */
export async function readImageData(path: string): Promise<ImageData | null> {
  const blob = await readBlob(path, 'image/png');
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Read a PNG from data.zip and return it as an HTMLCanvasElement.
 */
export async function readCanvas(path: string): Promise<HTMLCanvasElement | null> {
  const blob = await readBlob(path, 'image/png');
  if (!blob) return null;
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
