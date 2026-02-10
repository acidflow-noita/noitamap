/**
 * Cloud Image Host Integration - Anonymous image upload and fetch
 *
 * Supports:
 * 1. Primary (currently Catbox.moe)
 * 2. Fallback (currently qu.ax)
 *
 * Uploads go through our CF Worker proxy to avoid CORS issues.
 * Downloads are direct from the host.
 *
 * URL Param Format:
 * - Primary: cb:{fileId} (e.g., cb:vs77xc)
 * - Fallback: qx:{fileId} (e.g., qx:abcd.webp)
 */

// Proxy URL - use dev or prod based on current hostname
const IMAGE_UPLOAD_PROXY_URL =
  /dev\.noitamap\.com|vectorize-images\.noitamap\.com|localhost|127\.0\.0\.1/.test(window.location.hostname)
    ? 'https://noitamap-image-upload-proxy-dev.wuote.workers.dev'
    : 'https://noitamap-image-upload-proxy.wuote.workers.dev';

const PRIMARY_FILES_URL = 'https://files.catbox.moe';
const FALLBACK_FILES_URL = 'https://qu.ax/x';

export interface UploadResult {
  param: string; // The URL parameter (e.g. "cb:xyz" or "qx:xyz")
  url: string;   // The direct HTTP URL
}

/**
 * Upload a drawing (WebP blob) to cloud storage.
 * Tries Primary host first, falls back to Fallback if it fails.
 */
export async function uploadDrawing(blob: Blob, provider?: 'primary' | 'fallback', filename = 'drawing.webp'): Promise<UploadResult | null> {
  const urlParams = new URLSearchParams(window.location.search);
  const forceProvider = provider || urlParams.get('force_cloud') as 'primary' | 'fallback';

  // Try Primary
  if (forceProvider !== 'fallback') {
    const primaryId = await uploadToPrimary(blob, filename);
    if (primaryId) {
      return {
        param: `cb:${primaryId}`,
        url: `${PRIMARY_FILES_URL}/${primaryId}.webp`
      };
    }
    if (forceProvider === 'primary') return null;
  }

  // Try Fallback
  if (forceProvider !== 'primary') {
    console.warn('[Cloud] Fallback triggered.');
    const fallbackId = await uploadToFallback(blob, filename);
    if (fallbackId) {
      return {
        param: `qx:${fallbackId}`,
        url: `${FALLBACK_FILES_URL}/${fallbackId}.webp`
      };
    }
  }

  console.error('[Cloud] All upload providers failed.');
  return null;
}

/**
 * Fetch a drawing from cloud storage using the param (cb:ID or qx:ID).
 */
export async function fetchDrawing(param: string): Promise<Blob | null> {
  const url = getCloudUrl(param);
  if (!url) return null;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[Cloud] Fetch failed for ${url}:`, response.status);
      return null;
    }
    return await response.blob();
  } catch (error) {
    console.error(`[Cloud] Fetch error for ${url}:`, error);
    return null;
  }
}

/**
 * Check if a URL parameter is a cloud reference.
 */
export function isCloudRef(param: string): boolean {
  return param.startsWith('cb:') || param.startsWith('qx:');
}

/**
 * Get the direct HTTP URL from a cloud reference param.
 */
export function getCloudUrl(param: string): string | null {
  if (param.startsWith('cb:')) {
    const id = extractId(param, 'cb:');
    if (!id) return null;
    return `${PRIMARY_FILES_URL}/${id}.webp`;
  }
  
  if (param.startsWith('qx:')) {
    const id = extractId(param, 'qx:');
    if (!id) return null;
    const filename = id.includes('.') ? id : `${id}.webp`;
    return `${FALLBACK_FILES_URL}/${filename}`;
  }

  return null;
}

// --- Internal Providers ---

export async function uploadToPrimary(blob: Blob, filename: string): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', blob, filename);

    const response = await fetch(IMAGE_UPLOAD_PROXY_URL, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) return null;

    const fullUrl = await response.text();
    // Primary returns a full URL, we extract the ID
    const primaryHost = new URL(PRIMARY_FILES_URL).hostname.replace(/\./g, '\\.');
    const regex = new RegExp(`${primaryHost}/([a-zA-Z0-9]+)\\.\\w+`);
    const match = fullUrl.trim().match(regex);
    return match ? match[1] : null;
  } catch (e) {
    console.error('[Primary] Upload error:', e);
    return null;
  }
}

export async function uploadToFallback(blob: Blob, filename: string): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('file', blob, filename);

    const response = await fetch(`${IMAGE_UPLOAD_PROXY_URL}?host=fallback`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) return null;

    const responseText = await response.text();
    const fallbackHost = new URL(FALLBACK_FILES_URL).hostname.replace(/\./g, '\\.');
    const regex = new RegExp(`${fallbackHost}/(?:x/)?([^/.]+)(?:\\.\\w+)?$`);
    const match = responseText.trim().match(regex);
    
    if (!match) {
      const text = responseText.trim();
      if (text.length > 0 && text.length < 50 && !text.includes('/')) {
          return text.split('.')[0];
      }
      return null;
    }
    
    return match[1];
  } catch (e) {
    console.error('[Fallback] Upload error:', e);
    return null;
  }
}

function extractId(param: string, prefix: string): string | null {
  let id = param.slice(prefix.length);
  if (prefix === 'cb:' && id.toLowerCase().endsWith('.webp')) {
    id = id.slice(0, -5);
  }
  if (!id) return null;
  return id;
}

// --- Compatibility ---

export { 
  uploadDrawing as uploadToCloud, 
  fetchDrawing as fetchFromCloud,
  isCloudRef as isCloudRefLocal,
  getCloudUrl as getCloudUrlLocal
};

export function extractCloudFileId(param: string): string | null {
  if (param.startsWith('cb:')) return extractId(param, 'cb:');
  if (param.startsWith('qx:')) return extractId(param, 'qx:');
  return null;
}

export function createCloudParam(fileId: string, provider: 'cb' | 'qx' = 'cb'): string {
  return `${provider}:${fileId}`;
}
