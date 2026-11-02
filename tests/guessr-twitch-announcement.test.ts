import { expect, it, vi } from 'vitest';
import { ANNOUNCEMENT_SCOPE, postTwitchAnnouncement } from '../src/guessr/twitch-announcement';

const credentials = () => ({ accessToken: 'test-token', clientId: 'test-client', userId: '123',
  scopes: ['user:read:chat', ANNOUNCEMENT_SCOPE], expiresAt: Date.now() + 60_000 });
const message = 'Join NoitaGuessr: https://noitamap.test/guess/stream/streamer/';

it('posts one announcement directly to the signed-in streamer’s channel', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  await postTwitchAnnouncement(credentials(), '123', message, request);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'https://api.twitch.tv/helix/chat/announcements?broadcaster_id=123&moderator_id=123',
    expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { Authorization: 'Bearer test-token', 'Client-Id': 'test-client', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color: 'primary' }) }),
  );
});

it('requires explicit announcement permission and the game’s own streamer identity before posting', async () => {
  const request = vi.fn<typeof fetch>();
  await expect(postTwitchAnnouncement({ ...credentials(), scopes: ['user:read:chat'] }, '123', message, request))
    .rejects.toMatchObject({ permissionRequired: true });
  await expect(postTwitchAnnouncement({ ...credentials(), expiresAt: 0 }, '123', message, request))
    .rejects.toMatchObject({ permissionRequired: true });
  await expect(postTwitchAnnouncement(credentials(), '456', message, request))
    .rejects.toMatchObject({ permissionRequired: false });
  await expect(postTwitchAnnouncement(credentials(), '123', 'x'.repeat(501), request)).rejects.toThrow('too long');
  expect(request).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 500, 200])('never reports success or retries a rejected announcement (%s)', async status => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
  await expect(postTwitchAnnouncement(credentials(), '123', message, request))
    .rejects.toMatchObject({ permissionRequired: status === 401 || status === 403 });
  expect(request).toHaveBeenCalledOnce();
});

it('reports uncertain delivery after a network failure without silently posting twice', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Network failed'));
  await expect(postTwitchAnnouncement(credentials(), '123', message, request)).rejects.toThrow('Check your Twitch chat');
  expect(request).toHaveBeenCalledOnce();
});
