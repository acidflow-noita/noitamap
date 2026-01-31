/**
 * Catbox.moe Integration - Anonymous image upload and fetch
 *
 * Catbox.moe provides free anonymous file hosting.
 * Files are stored at: https://files.catbox.moe/{fileId}.{ext}
 *
 * Uploads go through our CF Worker proxy (catbox doesn't support CORS).
 * Downloads are direct from catbox (no CORS issues for GET requests).
 *
 * For URL sharing, we use a short format: cb:{fileId}
 * Example: cb:vs77xc (reconstructs to https://files.catbox.moe/vs77xc.webp)
 */

// Proxy URL - use dev or prod based on current hostname
const IMAGE_UPLOAD_PROXY_URL = window.location.hostname === 'localhost'
  || window.location.hostname === 'dev.noitamap.com'
  ? 'https://noitamap-image-upload-proxy-dev.wuote.workers.dev'
  : 'https://noitamap-image-upload-proxy.wuote.workers.dev';

const CATBOX_FILES_URL = 'https://files.catbox.moe';

/**
 * Upload a WebP blob to catbox.moe anonymously.
 * Returns the file ID (e.g., "vs77xc") on success, or null on failure.
 */
export async function uploadToCatbox(blob: Blob): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', blob, 'drawing.webp');

    // Use proxy to avoid CORS issues
    const response = await fetch(IMAGE_UPLOAD_PROXY_URL, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      console.error('[Catbox] Upload failed:', response.status, response.statusText);
      return null;
    }

    // Catbox returns the full URL as plain text
    // e.g., "https://files.catbox.moe/vs77xc.webp"
    const fullUrl = await response.text();
    const trimmed = fullUrl.trim();

    // Extract file ID from URL
    const match = trimmed.match(/files\.catbox\.moe\/([a-zA-Z0-9]+)\.webp/);
    if (!match) {
      console.error('[Catbox] Unexpected response format:', trimmed);
      return null;
    }

    const fileId = match[1];
    console.log('[Catbox] Upload success, file ID:', fileId);
    return fileId;
  } catch (error) {
    console.error('[Catbox] Upload error:', error);
    return null;
  }
}

/**
 * Fetch a WebP file from catbox.moe by file ID.
 * Returns the blob on success, or null if not found/error.
 */
export async function fetchFromCatbox(fileId: string): Promise<Blob | null> {
  try {
    const url = `${CATBOX_FILES_URL}/${fileId}.webp`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        console.warn('[Catbox] File not found:', fileId);
      } else {
        console.error('[Catbox] Fetch failed:', response.status, response.statusText);
      }
      return null;
    }

    const blob = await response.blob();
    console.log('[Catbox] Fetched', blob.size, 'bytes for file ID:', fileId);
    return blob;
  } catch (error) {
    console.error('[Catbox] Fetch error:', error);
    return null;
  }
}

/**
 * Check if a drawing param is a catbox reference.
 * Catbox refs have format: cb:{fileId}
 */
export function isCatboxRef(param: string): boolean {
  return param.startsWith('cb:');
}

/**
 * Extract file ID from catbox reference.
 * Input: "cb:vs77xc" -> Output: "vs77xc"
 */
export function extractCatboxFileId(param: string): string | null {
  if (!isCatboxRef(param)) return null;
  const fileId = param.slice(3); // Remove "cb:" prefix
  // Validate file ID format (alphanumeric, typically 6 chars)
  if (!/^[a-zA-Z0-9]+$/.test(fileId)) return null;
  return fileId;
}

/**
 * Create a catbox URL param from file ID.
 * Input: "vs77xc" -> Output: "cb:vs77xc"
 */
export function createCatboxParam(fileId: string): string {
  return `cb:${fileId}`;
}

/**
 * Get the full catbox URL for a file ID (for display/debug purposes).
 */
export function getCatboxUrl(fileId: string): string {
  return `${CATBOX_FILES_URL}/${fileId}.webp`;
}
