// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { GameApi } from '../src/guessr/api';

afterEach(() => vi.unstubAllGlobals());
it('reads public scores, answers and legacy images without an auth request or credentials', async () => {
  const fetch = vi.fn(async (url: string, _options: RequestInit) => url.endsWith('/image/0')
    ? new Response('image', { headers: { 'Content-Type': 'image/webp' } })
    : Response.json({ status: 'complete' }));
  vi.stubGlobal('fetch', fetch);
  const api = new GameApi('https://game.test');
  await api.publicResult('result-1');
  await api.publicResult('result-1', true);
  await api.image('/api/daily/results/result-1/image/0');
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    'https://game.test/api/daily/results/result-1', 'https://game.test/api/daily/results/result-1/answers',
    'https://game.test/api/daily/results/result-1/image/0',
  ]);
  for (const call of fetch.mock.calls) {
    expect(call[1].credentials).toBe('omit');
    expect(new Headers(call[1].headers).has('Authorization')).toBe(false);
  }
});
it('rejects untrusted paths without fetching and preserves API status for owner resume', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'The player has not finished this game yet.' }, { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  const api = new GameApi('https://game.test');
  await expect(api.publicResult('../attempts/private')).rejects.toMatchObject({ status: 404 });
  await expect(api.image('/api/attempts/private/guess')).rejects.toThrow('Invalid round image');
  expect(fetch).not.toHaveBeenCalled();
  await expect(api.publicResult('active')).rejects.toMatchObject({ status: 409 });
});
