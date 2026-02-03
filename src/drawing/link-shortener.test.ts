import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shortenUrl } from './link-shortener';

describe('Link Shortener', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return shortened URL on success', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ key: 'abc123', delete_token: 'xyz' }),
    };
    (global.fetch as any).mockResolvedValue(mockResponse);

    const result = await shortenUrl('https://noitamap.com/?x=100&y=200');

    expect(result).toBe('https://go.noitamap.com/abc123');
    expect(global.fetch).toHaveBeenCalledWith('https://m.uq.rs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://noitamap.com/?x=100&y=200' }),
    });
  });

  it('should return null when API returns non-ok response', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    };
    (global.fetch as any).mockResolvedValue(mockResponse);

    const result = await shortenUrl('https://noitamap.com/?x=100');
    expect(result).toBeNull();
  });

  it('should return null when fetch throws an error', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));

    const result = await shortenUrl('https://noitamap.com/?x=100');
    expect(result).toBeNull();
  });

  it('should return null when response JSON is malformed', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.reject(new Error('Invalid JSON')),
    };
    (global.fetch as any).mockResolvedValue(mockResponse);

    const result = await shortenUrl('https://noitamap.com/?x=100');
    expect(result).toBeNull();
  });
});
