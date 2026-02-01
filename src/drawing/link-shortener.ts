/**
 * Link Shortener Client for go.noitamap.com
 */

const SHORTENER_API_URL = 'https://go.noitamap.com';

interface ShortenerResponse {
  key: string;
  delete_token: string;
}

/**
 * Shorten a URL using the Noitamap shortener service
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
    return `${SHORTENER_API_URL}/${data.key}`;
  } catch (e) {
    console.error('[Link Shortener] Error shortening URL:', e);
    return null;
  }
}
