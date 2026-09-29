/** Versioned, read-only game assets. ZIPs are extracted only during the build.
 * The compatibility entry API keeps existing consumers on the same shared
 * page cache; no ZIP parser or decompressor runs in the browser or workers. */
import { assetManifests } from 'virtual:noitamap-data-archives';
import { immutableTelescopeAssets } from './telescope/immutable-assets';

export interface AssetPage { file: string; revision: string; bytes: number }
interface AssetIndex {
  version: number;
  pages: AssetPage[];
  entries: Record<string, [number, number, number]>;
}
interface EntryOutputs { string: string; arraybuffer: ArrayBuffer; blob: Blob }
const baseUrl = () => typeof document !== 'undefined'
  ? new URL('./', document.baseURI || location.href).href
  : new URL('/', self.location.href).href;
const catalogs = new Map<string, Promise<AssetCatalog>>();

export async function readAssetPage(page: AssetPage, base = baseUrl()): Promise<Blob> {
  const url = new URL(page.file, base).href;
  const response = await immutableTelescopeAssets.fetch(`game-assets/${page.revision}`, page.revision, async () => {
    const result = await fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(30_000) });
    if (!result.ok) throw new Error(`Game asset unavailable: ${page.file} (HTTP ${result.status})`);
    const bytes = await result.arrayBuffer();
    if (bytes.byteLength !== page.bytes) throw new Error(`Truncated game asset: ${page.file}`);
    if (globalThis.crypto?.subtle) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== page.revision) throw new Error(`Game asset content mismatch: ${page.file}`);
    }
    return new Response(bytes, { headers: { 'Content-Type': page.file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  });
  if (!response.ok) throw new Error(`Game asset unavailable: ${page.file}`);
  const blob = await response.blob();
  if (blob.size !== page.bytes) throw new Error(`Invalid cached game asset: ${page.file}`);
  return blob;
}

class AssetEntry {
  readonly dir = false;
  constructor(readonly name: string, private page: AssetPage, private offset: number,
    private length: number, private base: string) {}
  async async<T extends keyof EntryOutputs>(type: T): Promise<EntryOutputs[T]> {
    const page = await readAssetPage(this.page, this.base);
    const mime = this.name.endsWith('.png') ? 'image/png' : this.name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    const blob = page.slice(this.offset, this.offset + this.length, mime);
    return (type === 'blob' ? blob : type === 'string' ? await blob.text() : await blob.arrayBuffer()) as EntryOutputs[T];
  }
}
export class AssetCatalog {
  readonly files: Record<string, AssetEntry> = Object.create(null);
  constructor(private index: AssetIndex, private base: string) {
    if (index.version !== 1 || !Array.isArray(index.pages) || !index.entries)
      throw new Error('Unsupported game asset index');
    for (const [path, [pageId, offset, length]] of Object.entries(index.entries)) {
      const page = index.pages[pageId];
      if (!page || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || offset + length > page.bytes)
        throw new Error(`Invalid game asset range: ${path}`);
      this.files[path] = new AssetEntry(path, page, offset, length, base);
    }
  }
  file(path: string): AssetEntry | null { return this.files[path] ?? null; }
  forEach(callback: (path: string, entry: AssetEntry) => void): void {
    for (const [path, entry] of Object.entries(this.files)) callback(path, entry);
  }
}

/** Compatibility name; returns an index of immutable pages, never a ZIP. */
export function getZip(key = 'main', silent = false): Promise<AssetCatalog> {
  const base = baseUrl(), identity = `${base}/${key}`;
  let pending = catalogs.get(identity);
  if (!pending) {
    pending = loadCatalog(key, base).then(catalog => {
      if (key === 'main' && !silent && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined')
        window.dispatchEvent(new CustomEvent('dataZipProgress', { detail: { loaded: 1, total: 1, percentage: 100 } }));
      return catalog;
    }).catch(error => { catalogs.delete(identity); throw error; });
    catalogs.set(identity, pending);
  }
  return pending;
}
async function loadCatalog(key: string, base: string): Promise<AssetCatalog> {
  const manifest = assetManifests[key];
  if (!manifest) throw new Error(`Unknown game asset group: ${key}`);
  const blob = await readAssetPage(manifest, base);
  return new AssetCatalog(JSON.parse(await blob.text()), base);
}
/** Prepare shared immutable pages without parsing ZIPs or decoding images. */
export async function prepareDataArchive(key: string, base: string): Promise<void> {
  // Images are warmed through their shared source atlas. Read the catalog
  // here; text/binary pages are fetched only when a consumer needs them.
  await loadCatalog(key, base);
}

/** Legacy alias */
export async function getDataZip(): Promise<AssetCatalog> {
  return getZip("main", false);
}

/**
 * Read a text file from the versioned asset pages.
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
 * Read a binary file from the versioned asset pages as a Blob.
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
 * Read an image from the versioned asset pages as an ImageBitmap.
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
 * Read a PNG from the versioned asset pages and return it as ImageData.
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
 * Read a PNG from the versioned asset pages and return it as an OffscreenCanvas (worker safe) or HTMLCanvasElement.
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
 * List all entries in the asset index matching a prefix.
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
