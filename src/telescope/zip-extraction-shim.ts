/**
 * zip-extraction-shim.ts
 *
 * Replaces telescope's zip_extraction.js which imports from a CDN URL that
 * Vite can't bundle.  Instead of going through a fetch() → interceptor
 * round-trip (fragile in production bundles), we directly search the zip
 * archives that data-archive.ts already manages.
 *
 * The original telescope zip_extraction.js searches pixel_scenes.zip and
 * wang_tiles.zip by stripping their prefix from the URL.  We replicate the
 * same logic but also search data.zip (main) with fallback paths for biome
 * assets.
 */

import { getZip } from "../data-archive";
import { telescopePathToZipPath } from "./telescope-data-bridge";

// prettier-ignore
const FALLBACK_PNG = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, // PNG signature
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52, // IHDR chunk
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01, // 1×1
  0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4, // 8-bit RGBA
  0x89,
  0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54, // IDAT chunk
  0x78,0x5e,0x63,0x00,0x01,0x00,0x00,0x05,
  0x00,0x01,0x9b,0x3b,0x06,0x7a,
  0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44, // IEND chunk
  0xae,0x42,0x60,0x82,
]);

/**
 * Zip search configurations.  Order matters — we search main first (it has
 * the biome maps and other core data), then the specialised zips.
 *
 * `strip` is the prefix to remove from the full zip path to get the path
 * inside that specific zip archive (e.g. `data/wang_tiles/extra_layers/coalmine.png`
 * becomes `extra_layers/coalmine.png` inside wang_tiles.zip).
 */
const ZIP_CONFIGS = [
  { key: "main", strip: "" },
  { key: "pixel_scenes", strip: "data/pixel_scenes/" },
  { key: "wang_tiles", strip: "data/wang_tiles/" },
] as const;

/**
 * Fallback paths for the main zip — Noita stores some assets in locations
 * that don't match telescope's expected fetch paths.
 */
function mainZipFallbacks(fullZipPath: string): string[] {
  return [
    fullZipPath.replace("data/pixel_scenes/general/", "data/biome_impl/"),
    fullZipPath.replace("data/pixel_scenes/general/", "data/biome_impl/the_end/"),
    fullZipPath.replace("data/pixel_scenes/general/teleportroom", "data/biome_impl/mystery_teleport"),
    fullZipPath.replace("data/pixel_scenes/general/cauldron", "data/biome_impl/cauldron"),
    fullZipPath.replace("data/pixel_scenes/spliced/", "data/biome_impl/"),
    fullZipPath.replace("data/biome_maps/", "data/biome_impl/"),
  ].filter((p) => p !== fullZipPath);
}

/**
 * Directly search zip archives for the requested file.
 *
 * This is the replacement for telescope's `getFromZipFirst`.  Instead of
 * calling fetch() (which depends on the fetch interceptor being installed),
 * it goes straight into data-archive.ts's `getZip()`.
 */
export async function getFromZipFirst(url: string): Promise<Blob> {
  try {
    // Normalise the URL the same way the fetch interceptor does
    const match = url.match(/data\/.+/);
    if (match) {
      const telescopePath = "./" + match[0];
      const fullZipPath = telescopePathToZipPath(telescopePath);

      for (const config of ZIP_CONFIGS) {
        const zip = await getZip(config.key);
        if (!zip) continue;

        // Strip the prefix for specialised zips
        const zipPath =
          config.strip && fullZipPath.startsWith(config.strip)
            ? fullZipPath.substring(config.strip.length)
            : fullZipPath;

        let file = zip.file(zipPath);

        // Fallback paths only apply to the main zip
        if (!file && config.key === "main") {
          for (const fallback of mainZipFallbacks(fullZipPath)) {
            file = zip.file(fallback);
            if (file) break;
          }
        }

        if (file) {
          const buf = await file.async("arraybuffer");
          return new Blob([buf], { type: "image/png" });
        }
      }
    }

    // File not in any zip — return fallback PNG immediately.
    // Network fetch is pointless: the SPA server returns HTML for missing assets.
    console.warn(`[zip-shim] Not found in zips: ${url}, using fallback PNG`);
    return new Blob([FALLBACK_PNG], { type: "image/png" });
  } catch (e) {
    console.warn(`[zip-shim] Failed to resolve ${url}, using fallback PNG`, e);
    return new Blob([FALLBACK_PNG], { type: "image/png" });
  }
}
