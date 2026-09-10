import { fullPixelDataUrl } from "./full-pixel-data";
import { isGLTerrainEnabled } from "../renderer_settings";
import { decodePngToRgba, rgbaToPngBlobUrl } from "./png-decode";
import {
  isPackagedTelescopeAsset,
  readTelescopeAsset,
} from "./telescope-assets";
import { normalizeTelescopePath } from "./telescope-asset-paths";
export { telescopePathToZipPath } from "./telescope-asset-paths";

// Install once per fetch function; rebuilding a view must not stack wrappers.
const interceptedFetch = new WeakMap<typeof fetch, { fullPixels: boolean }>();

export function installFetchInterceptor(
  fullPixels = isGLTerrainEnabled(),
): void {
  const originalFetch = window.fetch;
  const installed = interceptedFetch.get(originalFetch);
  if (installed) {
    installed.fullPixels = fullPixels;
    return;
  }
  const mode = { fullPixels };
  const wrapped: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (method !== "GET" && method !== "HEAD")
      return originalFetch.call(window, input, init);
    signal?.throwIfAborted();
    const asset = mode.fullPixels && fullPixelDataUrl(url);
    if (asset) return originalFetch.call(window, asset, init);
    if (!isPackagedTelescopeAsset(url) && normalizeTelescopePath(url)) {
      const blob = await readTelescopeAsset(url);
      signal?.throwIfAborted();
      if (blob)
        return new Response(method === "HEAD" ? null : blob, {
          headers: {
            "Content-Type": blob.type,
            "Content-Length": String(blob.size),
          },
        });
    }
    return originalFetch.call(window, input, init);
  };
  interceptedFetch.set(wrapped, mode);
  window.fetch = wrapped;
}

const interceptedImages = new WeakSet<object>();

/** Decode archive PNGs in JS, keeping canvas fingerprint protection intact. */
export function installImageSrcInterceptor(): void {
  if (typeof HTMLImageElement === "undefined") return;
  const prototype = HTMLImageElement.prototype;
  if (interceptedImages.has(prototype)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
  if (!descriptor?.set) return;
  const originalSet = descriptor.set;
  const requests = new WeakMap<HTMLImageElement, object>();
  Object.defineProperty(prototype, "src", {
    ...descriptor,
    set(value: string) {
      const self = this as HTMLImageElement;
      const request = {};
      requests.set(self, request);
      if (
        typeof value !== "string" ||
        isPackagedTelescopeAsset(value) ||
        !normalizeTelescopePath(value)
      ) {
        originalSet.call(self, value);
        return;
      }
      void (async () => {
        const blob = await readTelescopeAsset(value);
        if (requests.get(self) !== request) return;
        if (!blob) {
          originalSet.call(self, value);
          return;
        }
        const { data, width, height } = decodePngToRgba(
          await blob.arrayBuffer(),
        );
        const blobUrl = await rgbaToPngBlobUrl(data, width, height);
        if (requests.get(self) !== request) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        originalSet.call(self, blobUrl);
      })().catch((error) => {
        if (requests.get(self) !== request) return;
        console.error(`[Telescope assets] Cannot load image ${value}`, error);
        self.dispatchEvent(new Event("error"));
      });
    },
    configurable: true,
  });
  interceptedImages.add(prototype);
}
