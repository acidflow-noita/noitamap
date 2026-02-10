/**
 * Image Upload Proxy Worker - Forwards uploads to configured image host
 *
 * This worker acts as a transparent bridge to allow CORS-free uploads
 * to providers like Catbox and qu.ax.
 */

interface Env {
  ALLOWED_ORIGINS: string;
  UPLOAD_TARGET: string;
  UPLOAD_TARGET_FALLBACK: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
    const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow POST (Uploads only to save quota)
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const url = new URL(request.url);
      const hostParam = url.searchParams.get('host');
      const isFallback = hostParam === 'fallback';
      const uploadTarget = isFallback ? env.UPLOAD_TARGET_FALLBACK : env.UPLOAD_TARGET;

      console.log(`[Proxy] Uploading to: ${uploadTarget}`);

      // Parse the incoming multipart form data
      const incomingFormData = await request.formData();
      const forwardFormData = new FormData();

      if (isFallback) {
        // qu.ax expects 'files[]' field
        const file = incomingFormData.get('file') || incomingFormData.get('fileToUpload');
        if (file) forwardFormData.append('files[]', file);
      } else {
        // Primary (Catbox) uses 'fileToUpload'
        for (const [key, value] of incomingFormData.entries()) {
          forwardFormData.append(key, value);
        }
      }

      // Forward the request
      const response = await fetch(uploadTarget, {
        method: 'POST',
        body: forwardFormData,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
        redirect: 'follow'
      });

      let responseText = await response.text();
      
      // qu.ax returns JSON, extract the direct URL for the frontend
      if (isFallback && response.ok) {
        try {
          const json = JSON.parse(responseText);
          if (json.success && json.files && json.files[0]) {
            responseText = json.files[0].url;
          }
        } catch (e) {
          console.error('[Proxy] Failed to parse qu.ax JSON response');
        }
      }

      // Return response with CORS headers
      const headers = new Headers();
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      headers.set('Content-Type', 'text/plain');

      return new Response(responseText, {
        status: response.status,
        headers
      });
    } catch (error) {
      console.error('Image upload proxy error:', error);
      return new Response('Proxy error', {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
        },
      });
    }
  },
};