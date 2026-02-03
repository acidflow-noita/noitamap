/**
 * Link Shortener Client for go.noitamap.com
 *
 * Uses the m.uq.rs shortener API to create shortened URLs.
 * Short URLs are served from go.noitamap.com via CNAME pointing to m.uq.rs.
 */

// API endpoint for creating short links
const SHORTENER_API_URL = 'https://m.uq.rs';

// Domain for short URLs (must match CNAME setup)
const SHORT_URL_DOMAIN = 'https://go.noitamap.com';

interface ShortenerResponse {
  key: string;
  delete_token: string;
}

/**
 * Shorten a URL using the Noitamap shortener service
 * Returns the short URL (e.g. https://go.noitamap.com/abc123) or null on failure
 */
export async function shortenUrl(longUrl: string): Promise<string | null> {
  try {
    const response = await fetch(SHORTENER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: longUrl,
        // No expiry by default for map links
      }),
    });

    if (!response.ok) {
      console.error('[Link Shortener] Failed to shorten URL:', response.status, response.statusText);
      return null;
    }

    const data = (await response.json()) as ShortenerResponse;
    return `${SHORT_URL_DOMAIN}/${data.key}`;
  } catch (e) {
    console.error('[Link Shortener] Error shortening URL:', e);
    return null;
  }
}
