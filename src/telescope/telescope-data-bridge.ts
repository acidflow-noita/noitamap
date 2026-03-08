/**
 * telescope-data-bridge.ts
 *
 * Bridges between various zip archives (data.zip, pixel_scenes.zip, wang_tiles.zip)
 * and telescope's expected `./data/...` fetch paths.
 */

import { getDataZip, getZip } from "../data-archive";
import { decodePngToRgba, rgbaToPngBlobUrl } from "./png-decode";

// ─── Path Mapping ───────────────────────────────────────────────────────────

/**
 * Maps a telescope fetch path (e.g. "./data/biome_maps/biome_map.png")
 * to the internal path inside our zip archives.
 */
export function telescopePathToZipPath(telescopePath: string): string {
  // Strip leading ./
  let path = telescopePath.replace(/^\.\//, "");
  // Telescope library uses ./data/biome_maps/ for the base maps,
  // but Noita's data.zip has them in data/biome_impl/
  if (path.includes("data/biome_maps/")) {
    path = path.replace("data/biome_maps/", "data/biome_impl/");
  }
  return path;
}

// ─── Fetch Interceptor ──────────────────────────────────────────────────────

/**
 * Intercepts global fetch() calls. If the URL starts with `./data/`,
 * it searches for the file in available zip archives.
 */
export function installFetchInterceptor(): void {
  const originalFetch = window.fetch;

  (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith("./data/") || url.includes("/data/")) {
      const match = url.match(/data\/.+/);
      if (match) {
        const telescopePath = "./" + match[0];
        const fullZipPath = telescopePathToZipPath(telescopePath);

        // Search order: main -> pixel_scenes -> wang_tiles
        const zipConfigs = [
          { key: "main", strip: "" },
          { key: "pixel_scenes", strip: "data/pixel_scenes/" },
          { key: "wang_tiles", strip: "data/wang_tiles/" },
        ];

        for (const config of zipConfigs) {
          const zip = await getZip(config.key);
          if (zip) {
            // 1. Try exact path (relative to zip root)
            let zipPath = config.strip && fullZipPath.startsWith(config.strip)
              ? fullZipPath.substring(config.strip.length)
              : fullZipPath;

            let file = zip.file(zipPath);

            // 2. If not found in main zip, try common Noita fallback paths
            if (!file && config.key === "main") {
              const fallbacks = [
                fullZipPath.replace("data/pixel_scenes/general/", "data/biome_impl/"),
                fullZipPath.replace("data/pixel_scenes/general/", "data/biome_impl/the_end/"),
                fullZipPath.replace("data/pixel_scenes/general/teleportroom", "data/biome_impl/mystery_teleport"),
                fullZipPath.replace("data/pixel_scenes/general/cauldron", "data/biome_impl/cauldron"),
                fullZipPath.replace("data/pixel_scenes/spliced/", "data/biome_impl/"),
                fullZipPath.replace("data/biome_maps/", "data/biome_impl/"),
              ];
              for (const fallback of fallbacks) {
                if (fallback !== fullZipPath) {
                  file = zip.file(fallback);
                  if (file) break;
                }
              }
            }

            if (file) {
              // console.log(`[FetchInterceptor] Intercepted ${url} -> zip:${config.key}:${file.name}`);
              const blob = await file.async("blob");
              const isImage = file.name.toLowerCase().endsWith(".png");
              return new Response(blob, {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": isImage ? "image/png" : "application/octet-stream" },
              });
            } else {
              // console.warn(`[FetchInterceptor] NOT FOUND: ${url} (Zip path: ${zipPath})`);
            }
          }
        }
      }
    }

    return originalFetch(input, init);
  };
}

// ─── Image src Interceptor ───────────────────────────────────────────────────

/**
 * Intercepts HTMLImageElement.prototype.src setter.
 * Decodes PNGs in pure JS to bypass canvas fingerprinting blocks in privacy browsers.
 */
export function installImageSrcInterceptor(): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (!descriptor || !descriptor.set) return;

  const originalSet = descriptor.set;

  Object.defineProperty(HTMLImageElement.prototype, "src", {
    set: function (value: string) {
      const self = this as HTMLImageElement;

      if (typeof value === "string" && (value.startsWith("./data/") || value.includes("/data/"))) {
        const match = value.match(/data\/.+/);
        if (match) {
          const telescopePath = "./" + match[0];
          const zipPath = telescopePathToZipPath(telescopePath);

          // We don't want to block the setter, so we run the search in an async task
          (async () => {
            const zipKeys = ["main", "pixel_scenes", "wang_tiles"];
            for (const key of zipKeys) {
              const zip = await getZip(key);
              if (!zip) continue;

              const file = zip.file(zipPath);
              if (file) {
                try {
                  const buf = await file.async("arraybuffer");
                  const { data, width, height } = decodePngToRgba(buf);
                  const blobUrl = await rgbaToPngBlobUrl(data, width, height);
                  originalSet.call(self, blobUrl);
                  return;
                } catch (err) {
                  console.warn(`[ImageInterceptor] Failed to decode ${zipPath} from ${key}`, err);
                }
              }
            }
            // Fallback
            originalSet.call(self, value);
          })();
          return;
        }
      }

      originalSet.call(self, value);
    },
    configurable: true,
  });
}
