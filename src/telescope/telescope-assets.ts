import { getZip } from "../data-archive";
import {
  normalizeTelescopePath,
  telescopeAssetCandidates,
} from "./telescope-asset-paths";

// These authored PNGs are absent from the published archives. Bundle the real
// source files instead of ever substituting transparent 1x1 images. Both pinned
// telescope forks contain byte-identical copies (covered by the asset audit).
const PACKAGED_PNGS: Record<string, string> = {
  "data/biome_maps/biome_map_nightmare.png": new URL(
    "../../lib/noita-telescope/data/biome_maps/biome_map_nightmare.png",
    import.meta.url,
  ).href,
  "data/pixel_scenes/general/cauldron.png": new URL(
    "../../lib/noita-telescope/data/pixel_scenes/general/cauldron.png",
    import.meta.url,
  ).href,
};

/** Avoid re-intercepting the dev-server /lib/.../data/ URL of a packaged PNG. */
export function isPackagedTelescopeAsset(url: string): boolean {
  return Object.values(PACKAGED_PNGS).includes(url);
}

// Cache successful compressed PNG blobs, not decoded world pixels. Bound both
// bytes and entries for phones; coalesce concurrent extraction across callers.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 64;
const cached = new Map<object | string, Blob>();
const pending = new Map<object | string, Promise<Blob>>();
let cachedBytes = 0;

async function readOnce(
  key: object | string,
  read: () => Promise<Blob>,
): Promise<Blob> {
  const found = cached.get(key);
  if (found) {
    cached.delete(key);
    cached.set(key, found);
    return found;
  }
  const underway = pending.get(key);
  if (underway) return underway;
  const result = read().then((blob) => {
    if (blob.size <= MAX_BYTES) {
      cached.set(key, blob);
      cachedBytes += blob.size;
      while (cached.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
        const oldest = cached.keys().next().value!;
        cachedBytes -= cached.get(oldest)!.size;
        cached.delete(oldest);
      }
    }
    return blob;
  });
  pending.set(key, result);
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}

export function clearTelescopeAssetCache(): void {
  cached.clear();
  cachedBytes = 0;
}

export async function readTelescopeAsset(url: string): Promise<Blob | null> {
  const path = normalizeTelescopePath(url);
  if (!path) return null;
  const archives = new Map<string, Awaited<ReturnType<typeof getZip>>>();
  for (const candidate of telescopeAssetCandidates(url)) {
    if (!archives.has(candidate.archive))
      archives.set(candidate.archive, await getZip(candidate.archive));
    const zip = archives.get(candidate.archive);
    const file = zip?.file(candidate.path);
    if (!file) continue;
    return readOnce(file, async () => {
      try {
        const bytes = await file.async("arraybuffer");
        const type = file.name.endsWith(".png")
          ? "image/png"
          : file.name.endsWith(".json")
            ? "application/json"
            : file.name.endsWith(".csv")
              ? "text/csv"
              : "application/octet-stream";
        return new Blob([bytes], { type });
      } catch (cause) {
        // A damaged archive is a real error, not a reason to cache a blank PNG.
        if (typeof caches !== "undefined")
          await caches
            .delete(`noitamap-archive-${candidate.archive}-v2`)
            .catch(() => {});
        throw new Error(
          `Cannot extract ${candidate.path} from ${candidate.archive}.zip; archive cache cleared. Please reload.`,
          { cause },
        );
      }
    });
  }
  const packaged = PACKAGED_PNGS[path];
  if (!packaged) return null;
  return readOnce(packaged, async () => {
    const response = await fetch(packaged);
    if (!response.ok)
      throw new Error(
        `Packaged telescope PNG unavailable: ${path} (HTTP ${response.status})`,
      );
    const bytes = await response.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
    if (
      ![137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, i) => signature[i] === value,
      )
    ) {
      throw new Error(`Packaged telescope asset is not a PNG: ${path}`);
    }
    return new Blob([bytes], { type: "image/png" });
  });
}
