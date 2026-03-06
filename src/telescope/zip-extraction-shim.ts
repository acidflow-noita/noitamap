// Shim: telescope's zip_extraction.js imports from a CDN URL that Vite can't
// bundle. Our fetch interceptor already serves ./data/* from data.zip, so
// telescope's own zip extraction is unnecessary — just delegate to fetch().
//
// The library's real getFromZipFirst always returns a Blob (via BlobWriter
// from @zip.js or response.blob()).  sanitizePng then calls blob.arrayBuffer()
// and checks the PNG signature.  If the data isn't a valid PNG it returns the
// raw URL string, which crashes createImageBitmap downstream.
//
// To guard against missing assets (dev-server returning HTML fallback),
// we verify the response is actually image/png and return a minimal 1×1
// transparent PNG when the asset is missing.

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

export async function getFromZipFirst(url: string): Promise<Blob> {
  try {
    const response = await fetch(url);
    const contentType = response.headers.get("Content-Type") || "";
    if (response.ok && contentType.startsWith("image/")) {
      return response.blob();
    }
    // Non-image response (e.g. HTML fallback from dev server) — return fallback
    console.warn(`[zip-shim] Non-image response for ${url} (${contentType}), using fallback PNG`);
    return new Blob([FALLBACK_PNG], { type: "image/png" });
  } catch {
    console.warn(`[zip-shim] Fetch failed for ${url}, using fallback PNG`);
    return new Blob([FALLBACK_PNG], { type: "image/png" });
  }
}
