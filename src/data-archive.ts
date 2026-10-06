/** Original game files indexed into immutable byte bundles at build time.
 * Compatibility accessor names stay in place; no ZIP parsing runs here. */
import { assetManifests } from "virtual:noitamap-asset-pages";
import { ImmutableTelescopeAssets } from "./telescope/immutable-assets";

interface AssetPage { file: string; revision: string; bytes: number }
interface AssetIndex {
  version: 1;
  pages: AssetPage[];
  entries: Record<string, [page: number, offset: number, length: number]>;
}
interface EntryOutputs { string: string; arraybuffer: ArrayBuffer; blob: Blob; uint8array: Uint8Array }

// Keep compressed PNG/file bytes bounded separately from decoded scene images.
const assets = new ImmutableTelescopeAssets(8 * 1024 * 1024);
const catalogs = new Map<string, Promise<AssetCatalog>>();
let reportedMain = false;
const workerScope = (globalThis as typeof globalThis & {
  WorkerGlobalScope?: new () => object;
}).WorkerGlobalScope;
const workerRealm = typeof workerScope === 'function' && globalThis instanceof workerScope;
function getBaseUrl(): string {
  // A worker may install a synthetic document for Telescope. That document
  // must never turn /assets/worker.js into the base for game-asset downloads.
  if (!workerRealm && typeof document !== 'undefined' && document.baseURI)
    return new URL('./', document.baseURI).href;
  return new URL(import.meta.env.BASE_URL || '/', globalThis.location.href).href;
}
function validPage(page: AssetPage): boolean {
  return !!page && typeof page.file === 'string' && typeof page.revision === 'string' && /^[a-f0-9]{64}$/.test(page.revision)
    && page.file === `game-assets/assets-${page.revision}.${page.file?.endsWith('.json') ? 'json' : 'bin'}`
    && Number.isSafeInteger(page.bytes) && page.bytes >= 0;
}
async function readPage(page: AssetPage, base: string): Promise<Blob> {
  if (!validPage(page)) throw new Error('Invalid game asset descriptor');
  const url = new URL(page.file, base).href;
  const response = await assets.fetch(page.file, page.revision, () => fetch(url, {
    cache: 'force-cache', signal: AbortSignal.timeout(30_000),
  }), undefined, async response => {
    if (!response.ok) throw new Error(`Game asset unavailable: ${page.file} (HTTP ${response.status})`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== page.bytes) throw new Error(`Truncated game asset: ${page.file}`);
    if (globalThis.crypto?.subtle) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== page.revision) throw new Error(`Game asset content mismatch: ${page.file}`);
    }
  });
  return response.blob();
}

class AssetEntry {
  readonly dir = false;
  constructor(readonly name: string, private page: AssetPage, private offset: number,
    private length: number, private base: string) {}
  async async<T extends keyof EntryOutputs>(type: T): Promise<EntryOutputs[T]> {
    const bytes = await readPage(this.page, this.base);
    const mime = this.name.endsWith('.png') ? 'image/png'
      : this.name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    const blob = bytes.slice(this.offset, this.offset + this.length, mime);
    switch (type) {
      // Small sprite object URLs must not retain an entire sliced 2 MiB page.
      case 'blob': return new Blob([await blob.arrayBuffer()], { type: mime }) as EntryOutputs[T];
      // JSZip preserved UTF-8 BOMs; Blob.text() strips them.
      case 'string': return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer()) as EntryOutputs[T];
      case 'arraybuffer': return await blob.arrayBuffer() as EntryOutputs[T];
      case 'uint8array': return new Uint8Array(await blob.arrayBuffer()) as EntryOutputs[T];
      default: throw new Error(`Unsupported asset output: ${type}`);
    }
  }
}

export class AssetCatalog {
  readonly files: Record<string, AssetEntry> = Object.create(null);
  constructor(index: AssetIndex, base: string) {
    if (!index || index.version !== 1 || !Array.isArray(index.pages)
      || !index.pages.every(validPage) || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries))
      throw new Error('Unsupported game asset index');
    for (const [path, range] of Object.entries(index.entries)) {
      if (!Array.isArray(range) || range.length !== 3) throw new Error(`Invalid game asset range: ${path}`);
      const [pageId, offset, length] = range, page = index.pages[pageId];
      if (!Number.isSafeInteger(pageId) || !page || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
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

function loadCatalog(key: string, base: string): Promise<AssetCatalog> {
  const descriptor = assetManifests[key];
  if (!descriptor) return Promise.reject(new Error(`Unknown game asset group: ${key}`));
  const identity = `${base}/${key}/${descriptor.revision}`;
  let pending = catalogs.get(identity);
  if (!pending) {
    pending = readPage(descriptor, base).then(async blob => new AssetCatalog(JSON.parse(await blob.text()), base))
      .catch(error => { catalogs.delete(identity); throw error; });
    catalogs.set(identity, pending);
  }
  return pending;
}

/** Compatibility name: metadata only. Individual files share lazy page reads. */
export async function getZip(key = 'main', silent = false): Promise<AssetCatalog | null> {
  try {
    const catalog = await loadCatalog(key, getBaseUrl());
    if (key === 'main' && !reportedMain && !silent && !workerRealm && typeof document !== 'undefined' && document.baseURI
      && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      reportedMain = true;
      window.dispatchEvent(new CustomEvent('dataZipProgress', { detail: { loaded: 1, total: 1, percentage: 100 } }));
    }
    return catalog;
  } catch (error) {
    console.error(`[DataArchive] Cannot load ${key} assets:`, error);
    return null;
  }
}

/** Optional baked-map preparation only fetches the small indexes. Files load
 * on demand; workers can fetch missing pages even when storage is unavailable. */
export async function prepareDataArchive(key: string, base: string): Promise<void> {
  await loadCatalog(key, base);
  await assets.flushWrites();
}
export async function getDataZip(): Promise<AssetCatalog | null> { return getZip('main'); }

/**
 * Read a text file from the game asset index.
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
 * Read a binary file from the game asset index as a Blob.
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
 * Read an image from the game asset index as an ImageBitmap.
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
 * Read a PNG from the game asset index and return it as ImageData.
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
 * Read a PNG from the game asset index and return it as an OffscreenCanvas (worker safe) or HTMLCanvasElement.
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
 * List all entries in the game asset index matching a prefix.
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
