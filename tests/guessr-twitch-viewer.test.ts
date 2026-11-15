// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TwitchViewer, TWITCH_VIEWER_MESSAGE, savedTwitchViewerId } from '../src/guessr/twitch-viewer';

const clients: TwitchViewer[] = [];
const token = 'viewerToken123';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
  history.replaceState(null, '', '/guess/?pane=stream-picker&channel=wuote');
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, { getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      key: (index: number) => [...values.keys()][index] ?? null, clear: () => values.clear(),
      removeItem: vi.fn((key: string) => { values.delete(key); }), get length() { return values.size; } });
  }
});
afterEach(() => {
  clients.splice(0).forEach(client => client.dispose());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('identifies a saved result viewer without authenticating, validating a token or changing storage', () => {
  const fetch = vi.fn(() => { throw Error('Read-only identity must not contact Twitch'); }); vi.stubGlobal('fetch', fetch);
  const key = 'noitamap-guessr-twitch-identity-v2:client123';
  localStorage.setItem(key, JSON.stringify({ userId: '987654', expiresAt: 1 }));
  vi.mocked(localStorage.setItem).mockClear();
  expect(savedTwitchViewerId('client123')).toBe('987654');
  expect(fetch).not.toHaveBeenCalled(); expect(localStorage.setItem).not.toHaveBeenCalled();
  localStorage.setItem(key, '{'); expect(savedTwitchViewerId('client123')).toBeUndefined();
  localStorage.setItem(key, JSON.stringify({ userId: '<script>' })); expect(savedTwitchViewerId('client123')).toBeUndefined();
  localStorage.removeItem(key); expect(savedTwitchViewerId('client123')).toBeUndefined();
});

function fixture(chat = true) {
  const identity = { client_id: 'client123', user_id: '123', login: 'viewer', scopes: ['user:write:chat'], expires_in: 7200 };
  const popup = { closed: false, close: vi.fn() };
  const open = vi.fn<(url: string, name: string, features: string) => typeof popup | null>(() => popup);
  const request = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
    if (String(url).endsWith('/validate')) return json(identity);
    if (String(url).includes('/helix/users?')) return json({ data: [{ id: '456', login: new URL(String(url)).searchParams.get('login') }] });
    if (String(url).endsWith('/helix/chat/messages')) return json({ data: [{ is_sent: true, message_id: 'sent-id' }] });
    throw Error('Unexpected request');
  });
  const client = new TwitchViewer({ clientId: 'client123', popup: open, fetch: request, chat });
  clients.push(client);
  const reply = (change: Record<string, unknown> = {}, origin = location.origin, source = popup) => {
    const authorization = new URL(open.mock.calls.at(-1)![0] as unknown as string);
    window.dispatchEvent(new MessageEvent('message', { origin, source: source as unknown as Window,
      data: { type: TWITCH_VIEWER_MESSAGE, state: authorization.searchParams.get('state'), accessToken: token, ...change } }));
  };
  const connect = async () => { const pending = client.connect(); reply(); return pending; };
  const sends = () => request.mock.calls.filter(([url]) => String(url).endsWith('/helix/chat/messages'));
  return { client, identity, popup, open, request, reply, connect, sends };
}

describe('Twitch identity and optional host sharing', () => {
  it('uses a verified site identity without opening a popup or contacting Twitch', async () => {
    const request = vi.fn(), popup = vi.fn(), signOut = vi.fn(), authorize = vi.fn(async () => 'signed-game-ticket');
    const client = new TwitchViewer({ chat: false, clientId: 'client123', fetch: request, popup,
      siteIdentity: { userId: '123', login: 'wuote', displayName: 'WUOTE' }, siteAuthorization: authorize, siteSignOut: signOut });
    clients.push(client); await client.ready;
    expect(client.getState()).toMatchObject({ connected: true, userId: '123', login: 'wuote' });
    expect(await client.transportAuthorization()).toEqual({ role: 'host', ticket: 'signed-game-ticket' });
    await client.connect(); expect(popup).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(localStorage)).not.toContain('signed-game-ticket');
    client.dispose(); expect(signOut).not.toHaveBeenCalled();
  });
  it.each([undefined, null])('accepts an identity-only token with empty scopes represented as %s', async scopes => {
    const f = fixture(false); f.identity.scopes = scopes as any;
    await f.connect(); expect(f.client.getState().connected).toBe(true);
  });
  it('uses identity-only Twitch authorization for private PvP', async () => {
    const f = fixture(false); f.identity.scopes = [];
    const connected = f.client.connect();
    expect(new URL(f.open.mock.calls[0][0]).searchParams.get('scope')).toBe('');
    f.reply(); await connected;
    expect(f.client.getState()).toMatchObject({ connected: true, userId: '123' });
    expect(f.sends()).toHaveLength(0);
    expect(await f.client.transportAuthorization()).toMatchObject({ role: 'player', accessToken: token });
  });
  it('asks for announcement permission only when the local streamer explicitly enables sharing', async () => {
    const f = fixture();
    f.identity.scopes.push('moderator:manage:announcements');
    const pending = f.client.connect({ announcements: true });
    expect(new URL(f.open.mock.calls[0][0]).searchParams.get('scope'))
      .toBe('user:write:chat moderator:manage:announcements');
    f.reply(); await pending;
    expect(f.sends()).toHaveLength(0);
    f.request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await f.client.postGameLink('viewer', 'Join NoitaGuessr: https://noitamap.test/guess/stream/viewer/', true);
    expect(f.request.mock.lastCall![0]).toContain('broadcaster_id=123&moderator_id=123');
    await expect(f.client.postGameLink('someone_else', 'Join this game', true)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('binds consent to the popup, origin and random state; connecting never sends a guess', async () => {
    const f = fixture(), pending = f.client.connect();
    expect(f.client.connect()).toBe(pending);
    const auth = new URL(f.open.mock.calls[0][0] as unknown as string);
    expect(auth.origin).toBe('https://id.twitch.tv');
    expect(auth.searchParams.get('scope')).toBe('user:write:chat');
    expect(auth.searchParams.get('redirect_uri')).toBe(location.origin + '/guess/twitch-callback.html');
    expect(auth.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
    f.reply({}, 'https://untrusted.example');
    f.reply({}, location.origin, { ...f.popup });
    f.reply({ state: 'wrong' });
    expect(f.request).not.toHaveBeenCalled();
    f.reply(); f.reply();
    await pending;
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.sends()).toHaveLength(0);
    expect(f.client.getState()).toMatchObject({ connected: true, login: 'viewer', userId: '123' });
    expect(JSON.stringify(f.client.getState())).not.toContain(token);
    expect(JSON.parse(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')!)).toMatchObject({ token, userId: '123' });
    expect(localStorage.getItem('noitamap-guessr-twitch-identity-v2:client123')).not.toContain(token);
    expect(localStorage.getItem('noitamap-guessr-twitch-v1:client123')).toBeNull();
  });

  it.each([
    { client_id: 'different' }, { scopes: [] }, { scopes: ['user:read:chat'] }, { user_id: 'bad-id' }, { expires_in: 0 },
  ])('rejects invalid token validation: %j', async change => {
    const f = fixture(); Object.assign(f.identity, change);
    await expect(f.connect()).rejects.toMatchObject({ code: 'validation' });
    expect(f.client.getState().connected).toBe(false);
    expect(f.sends()).toHaveLength(0);
  });

  it.each(['denied', 'closed', 'timeout', 'blocked'] as const)('handles %s sign-in without sending', async reason => {
    const f = fixture();
    if (reason === 'blocked') f.open.mockReturnValueOnce(null as any);
    const result = f.client.connect().catch(error => error);
    if (reason === 'denied') f.reply({ error: 'access_denied', accessToken: null });
    if (reason === 'closed') { f.popup.closed = true; await vi.advanceTimersByTimeAsync(250); }
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(300000);
    expect((await result).code).toBe(reason === 'denied' ? 'denied' : 'popup');
    expect(f.client.getState().connecting).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('validates hourly and disconnects if the token changes identity', async () => {
    const f = fixture(); await f.connect();
    f.identity.user_id = '999';
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.client.getState().connected).toBe(false);
    await expect(f.client.transportAuthorization()).rejects.toMatchObject({ code: 'disconnected' });
    expect(f.sends()).toHaveLength(0);
  });

  it('expires credentials without issuing a message', async () => {
    const f = fixture(); f.identity.expires_in = 10; await f.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.client.getState()).toMatchObject({ connected: false, error: expect.stringContaining('expired') });
    expect(f.sends()).toHaveLength(0);
  });

  it('removes the callback token from history and returns it only to the same-origin opener', () => {
    const message = vi.fn();
    vi.stubGlobal('opener', { postMessage: message });
    history.replaceState(null, '', '/guess/twitch-callback.html#access_token=' + token + '&state=nonce');
    document.body.innerHTML = '<p id="status"></p>';
    const callback = readFileSync('public/guess/twitch-callback.html', 'utf8').match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1];
    window.eval(callback);
    expect(location.hash).toBe(''); expect(location.search).toBe('');
    expect(message).toHaveBeenCalledExactlyOnceWith({ type: TWITCH_VIEWER_MESSAGE, state: 'nonce', accessToken: token, error: null }, location.origin);
    expect(document.body.textContent).not.toContain(token);
    vi.unstubAllGlobals();
  });

  it('restores remembered access after a page reload without another popup, then forgets it on sign out', async () => {
    const f = fixture(); await f.connect(); f.client.dispose();
    const popup = vi.fn(() => null);
    const next = new TwitchViewer({ clientId: 'client123', fetch: f.request, popup }); clients.push(next);
    expect(next.getState().restoring).toBe(true);
    await next.ready;
    expect(next.getState()).toMatchObject({ connected: true, login: 'viewer', restoring: false });
    expect(popup).not.toHaveBeenCalled(); expect(f.sends()).toHaveLength(0);
    next.disconnect();
    expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).toBeNull();
  });

  it('retains a read-only saved identity for score recovery when Twitch is unreachable', async () => {
    const f = fixture(); await f.connect(); f.client.dispose();
    f.request.mockRejectedValueOnce(new TypeError('Offline'));
    const next = new TwitchViewer({ clientId: 'client123', fetch: f.request, popup: f.open }); clients.push(next);
    expect(next.getState()).toMatchObject({ connected: false, restoring: true, savedUserId: '123' });
    await next.ready;
    expect(next.getState()).toMatchObject({ connected: false, savedUserId: '123' });
    expect(f.sends()).toHaveLength(0);
    next.disconnect(); expect(next.getState().savedUserId).toBeNull();
  });

  it('drops a revoked remembered token without opening a popup or sending a message', async () => {
    const f = fixture(); await f.connect(); f.client.dispose();
    f.request.mockResolvedValueOnce(json({}, 401));
    const popup = vi.fn(() => null);
    const next = new TwitchViewer({ clientId: 'client123', fetch: f.request, popup }); clients.push(next);
    await next.ready;
    expect(next.getState().connected).toBe(false);
    expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).toBeNull();
    expect(popup).not.toHaveBeenCalled(); expect(f.sends()).toHaveLength(0);
  });

  it('does not restore credentials after signing out during validation', async () => {
    const f = fixture(); await f.connect(); f.client.dispose();
    let finish!: (response: Response) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const next = new TwitchViewer({ clientId: 'client123', fetch: f.request }); clients.push(next);
    next.disconnect(); finish(json(f.identity)); await next.ready;
    expect(next.getState().connected).toBe(false);
    expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).toBeNull();
  });
});


it('removes and revokes old persistent tokens without importing them into the current tab', async () => {
  localStorage.setItem('noitamap-guessr-twitch-v1:client123', JSON.stringify({ token, userId: '123', expiresAt: Date.now() + 3600000 }));
  const f = fixture(); await f.client.ready;
  expect(f.client.getState().connected).toBe(false);
  expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).toBeNull();
  expect(localStorage.getItem('noitamap-guessr-twitch-v1:client123')).toBeNull();
  expect(f.request).toHaveBeenCalledOnce();
  const [url, init] = f.request.mock.calls[0]; expect(url).toBe('https://id.twitch.tv/oauth2/revoke');
  expect(new URLSearchParams(init!.body as URLSearchParams).get('token')).toBe(token);
  expect(f.sends()).toHaveLength(0);
});
it('revokes on explicit sign-out but preserves a current-tab connection through disposal/F5', async () => {
  const f = fixture(); await f.connect(); f.client.dispose();
  expect(f.request.mock.calls.some(([url]) => String(url).endsWith('/revoke'))).toBe(false);
  const next = new TwitchViewer({ clientId: 'client123', fetch: f.request }); clients.push(next); await next.ready;
  next.disconnect(); await Promise.resolve();
  expect(f.request.mock.calls.filter(([url]) => String(url).endsWith('/revoke'))).toHaveLength(1);
  expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).toBeNull();
  expect(savedTwitchViewerId('client123')).toBeUndefined();
});
it('cannot restore a connection in a fresh tab from the public saved identity', async () => {
  const f = fixture(); await f.connect(); f.client.dispose(); sessionStorage.clear();
  f.request.mockClear();
  const next = new TwitchViewer({ clientId: 'client123', fetch: f.request }); clients.push(next); await next.ready;
  expect(next.getState()).toMatchObject({ connected: false, savedUserId: '123' });
  expect(f.request).not.toHaveBeenCalled();
});

it('discards the old chat-transport credential once and requests identity-only access for gameplay', async () => {
  sessionStorage.setItem('noitamap-guessr-twitch-tab-v2:client123', JSON.stringify({ token, userId: '123', expiresAt: Date.now() + 3600000 }));
  const f = fixture(false); await f.client.ready;
  expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v2:client123')).toBeNull();
  expect(f.client.getState().connected).toBe(false);
  expect(f.request.mock.calls.map(([url]) => String(url))).toEqual(['https://id.twitch.tv/oauth2/revoke']);
  const pending = f.client.connect(); expect(new URL(f.open.mock.calls[0][0]).searchParams.get('scope')).toBe('');
  f.reply(); await pending;
  expect(f.client.getState().connected).toBe(true); expect(f.sends()).toHaveLength(0);
});

it('restores after a temporary verification outage without another popup or discarding the saved token', async () => {
  const f = fixture(false); await f.connect(); f.client.dispose();
  f.request.mockResolvedValueOnce(json({}, 503));
  const popup = vi.fn(); const next = new TwitchViewer({ clientId: 'client123', fetch: f.request, popup }); clients.push(next);
  await next.ready;
  expect(next.getState()).toMatchObject({ connected: false, restoring: true });
  expect(sessionStorage.getItem('noitamap-guessr-twitch-tab-v3:client123')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(30000);
  expect(next.getState()).toMatchObject({ connected: true, restoring: false, userId: '123' });
  expect(popup).not.toHaveBeenCalled(); expect(f.sends()).toHaveLength(0);
});

it('requests posting access only for an explicit host-sharing action, not later ordinary sign-ins', async () => {
  const f = fixture(false); f.identity.scopes = []; await f.connect();
  expect(new URL(f.open.mock.calls.at(-1)![0]).searchParams.get('scope')).toBe('');
  const posting = f.client.connect({ posting: true });
  expect(new URL(f.open.mock.calls.at(-1)![0]).searchParams.get('scope')).toBe('user:write:chat');
  f.identity.scopes = ['user:write:chat']; f.reply(); await posting;
  expect(f.client.canShare(false)).toBe(true);
  f.client.disconnect(); const ordinary = f.client.connect();
  expect(new URL(f.open.mock.calls.at(-1)![0]).searchParams.get('scope')).toBe('');
  f.identity.scopes = []; f.reply(); await ordinary;
  expect(f.client.getState().connected).toBe(true); expect(f.client.canShare(false)).toBe(false);
});
