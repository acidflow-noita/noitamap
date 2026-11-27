import { expect, it, vi } from 'vitest';
import { verifiedChatColor } from '../workers/noitamap-auth/src/twitch-chat-color';

it('reads the official color with an app token when the player token is absent, and reuses it across player lookups', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app', expires_in: 3600 });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-app');
    return Response.json({ data: [{ user_id: target.searchParams.get('user_id'), color: '#1e90ff' }] });
  });
  const secret = async () => 'test-secret';
  expect(await verifiedChatColor('200', 'app-test', undefined, secret, fetcher)).toBe('#1E90FF');
  expect(await verifiedChatColor('201', 'app-test', undefined, secret, fetcher)).toBe('#1E90FF');
  expect(await verifiedChatColor('200', 'app-test', undefined, secret, fetcher)).toBe('#1E90FF');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('preserves a known color on a temporary outage and accepts Twitch explicitly clearing the color', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [{ user_id: '200', color: '#123456' }] }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ data: [{ user_id: '200', color: '' }] }));
  const secret = async () => null;
  expect(await verifiedChatColor('200', 'cached-test', 'user', secret, fetcher, 1)).toBe('#123456');
  expect(await verifiedChatColor('200', 'cached-test', 'user', secret, fetcher, 1000000)).toBe('#123456');
  expect(await verifiedChatColor('200', 'cached-test', 'user', secret, fetcher, 1000001)).toBeUndefined();
});
