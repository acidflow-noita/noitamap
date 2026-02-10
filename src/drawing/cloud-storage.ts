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
 * - Legacy Fallback: 0x0:{filename} (preserved for backward compatibility)
 */

// Proxy URL - use dev or prod based on current hostname
const IMAGE_UPLOAD_PROXY_URL =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === 'dev.noitamap.com' ||
  window.location.hostname === 'vectorize-images.noitamap.com'
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
 * 
 * Testing: Use ?force_cloud=fallback or ?force_cloud=primary in URL to skip providers.
 */
export async function uploadDrawing(blob: Blob, provider?: 'primary' | 'fallback'): Promise<UploadResult | null> {
  const urlParams = new URLSearchParams(window.location.search);
  const forceProvider = provider || urlParams.get('force_cloud') as 'primary' | 'fallback';

  // Try Primary (unless fallback is forced)
  if (forceProvider !== 'fallback') {
    const primaryId = await uploadToPrimary(blob);
    if (primaryId) {
      return {
        param: `cb:${primaryId}`,
        url: `${PRIMARY_FILES_URL}/${primaryId}.webp`
      };
    }
    // If we specifically wanted primary and it failed, don't try fallback
    if (forceProvider === 'primary') return null;
  }

  if (forceProvider !== 'primary') {
    console.warn('[Cloud] Primary skipped or failed, trying Fallback...');

    // Try Fallback
    const fallbackId = await uploadToFallback(blob);
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
 * Fetch a drawing from cloud storage using the param (cb:ID, qx:ID, or 0x0:ID).
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
  return param.startsWith('cb:') || param.startsWith('qx:') || param.startsWith('0x0:');
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
    // Ensure we have .webp extension for direct file access
    const filename = id.includes('.') ? id : `${id}.webp`;
    return `${FALLBACK_FILES_URL}/${filename}`;
  }

  // Legacy fallback support
  if (param.startsWith('0x0:')) {
    const id = extractId(param, '0x0:');
    if (!id) return null;
    // Map legacy 0x0 prefix to qu.ax and ensure .webp extension
    const filename = id.includes('.') ? id : `${id}.webp`;
    return `${FALLBACK_FILES_URL}/${filename}`;
  }

  return null;
}

// --- Internal Providers (Exported for testing) ---

export async function uploadToPrimary(blob: Blob): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', blob, 'drawing.webp');

    // Default host is Primary, no need for ?host= param
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

export async function uploadToFallback(blob: Blob): Promise<string | null> {
  try {
    const formData = new FormData();
    // Fallback expects 'file' field
    formData.append('file', blob, 'drawing.webp');

    // Use proxy with ?host=fallback (requires latest worker deployment)
    const response = await fetch(`${IMAGE_UPLOAD_PROXY_URL}?host=fallback`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      console.warn('[Fallback] Upload failed with status:', response.status);
      return null;
    }

    const responseText = await response.text();
    console.log('[Fallback] Response received:', responseText.trim());

    // Fallback returns a direct URL or ID string depending on implementation
    // qu.ax returns a full URL in the responseText (processed by proxy)
    const fallbackHost = new URL(FALLBACK_FILES_URL).hostname.replace(/\./g, '\\.');
    const regex = new RegExp(`${fallbackHost}/([^/.]+)(?:\\.\\w+)?$`);
    const match = responseText.trim().match(regex);
    
    if (!match) {
      // If it's already just the filename/ID without extension
      const text = responseText.trim();
      if (text.length > 0 && text.length < 50 && !text.includes('/')) {
          return text.split('.')[0];
      }
      console.warn('[Fallback] Failed to match ID in response:', responseText);
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
  // For Primary, we historically strip .webp
  if (prefix === 'cb:' && id.toLowerCase().endsWith('.webp')) {
    id = id.slice(0, -5);
  }
  if (!id) return null;
  return id;
}

// --- Deprecated / Compatibility Exports (to minimize refactoring noise if needed, but prefer new API) ---

export { 
  uploadDrawing as uploadToCloud, 
  fetchDrawing as fetchFromCloud,
  isCloudRef as isCloudRefLocal,
  getCloudUrl as getCloudUrlLocal
};

export function extractCloudFileId(param: string): string | null {
  if (param.startsWith('cb:')) return extractId(param, 'cb:');
  if (param.startsWith('qx:')) return extractId(param, 'qx:');
  if (param.startsWith('0x0:')) return extractId(param, '0x0:');
  return null;
}

export function createCloudParam(fileId: string, provider: 'cb' | 'qx' | '0x0' = 'cb'): string {
  return `${provider}:${fileId}`;
}
