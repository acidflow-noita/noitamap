// Shim: telescope's zip_extraction.js imports from a CDN URL that Vite can't
// bundle. Our fetch interceptor already serves ./data/* from data.zip, so
// telescope's own zip extraction is unnecessary — just delegate to fetch().
export async function getFromZipFirst(url: string): Promise<Blob> {
  const response = await fetch(url);
  return response.blob();
}
