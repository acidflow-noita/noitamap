import { decodePngToRgba, type RawImageData } from "./png";

/** Immutable input provider owned by one generation worker. Paths are game paths. */
export interface NativeAssets {
  readonly revision: string;
  read(path: string): Promise<Uint8Array>;
}

let host: NativeAssets | undefined;
const pngs = new Map<string, Promise<RawImageData>>();
const jsons = new Map<string, Promise<any>>();

export function installNativeAssets(assets: NativeAssets): void {
  if (!assets.revision || typeof assets.read !== "function")
    throw new Error("Native assets need an immutable revision and reader");
  if (host && host !== assets)
    throw new Error("One asset revision per worker; create a new worker to replace it");
  host = assets;
}

export function gameAssetPath(url: string): string {
  const path = url.replace(/^(?:\.\.\/|\.\/)+/, "");
  if (!path.startsWith("data/") || path.includes("..") || /[?#\\]/.test(path))
    throw new Error(`Invalid game asset path: ${url}`);
  return path;
}

export async function readBytes(url: string): Promise<Uint8Array> {
  if (!host) throw new Error("Install native assets before loading generation rules");
  return host.read(gameAssetPath(url));
}

function once<T>(cache: Map<string, Promise<T>>, url: string, load: () => Promise<T>) {
  const key = gameAssetPath(url);
  let pending = cache.get(key);
  if (!pending) {
    pending = load().catch(error => { cache.delete(key); throw error; });
    cache.set(key, pending);
  }
  return pending;
}

export function readJson(url: string): Promise<any> {
  return once(jsons, url, async () => JSON.parse(new TextDecoder().decode(await readBytes(url))));
}

export function readPng(url: string): Promise<RawImageData> {
  return once(pngs, url, async () => {
    const bytes = await readBytes(url);
    return decodePngToRgba(Uint8Array.from(bytes).buffer);
  });
}

/** Geometry snapshots its inputs, so compressed/source PNG residency can end. */
export function releaseDecodedInputImages(): void { pngs.clear(); }
