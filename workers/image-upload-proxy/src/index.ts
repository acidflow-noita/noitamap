/**
 * Image Upload Proxy Worker - Forwards uploads to configured image host
 *
 * Some image hosts don't support CORS, so we proxy the upload request.
 * This is a tiny passthrough - no storage, no processing.
 *
 * Configure UPLOAD_TARGET in wrangler.toml to change the image host.
 */

interface Env {
  ALLOWED_ORIGINS: string;
  UPLOAD_TARGET: string;
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

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Forward the request to the configured upload target
      const response = await fetch(env.UPLOAD_TARGET, {
        method: 'POST',
        body: request.body,
        headers: {
          'Content-Type': request.headers.get('Content-Type') || 'multipart/form-data',
        },
      });

      // Return response with CORS headers
      const responseText = await response.text();
      return new Response(responseText, {
        status: response.status,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Content-Type': 'text/plain',
        },
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
