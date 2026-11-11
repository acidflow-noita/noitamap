// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/auth/confirm-link', () => ({ confirmAccountLink: async () => true }));

let auth: typeof import('../src/auth/auth-service')['authService'];
let prepare: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; } });
  const tabStorage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => tabStorage.get(key) ?? null,
    setItem: (key: string, value: string) => tabStorage.set(key, value), removeItem: (key: string) => tabStorage.delete(key) });
  window.history.replaceState({}, '', '/guess/');
  localStorage.setItem('noitamap_session_format', '2');
  localStorage.setItem('noitamap_jwt', 'header.' + btoa(JSON.stringify({ v: 2, typ: 'access', aud: 'noitamap-auth', sid: '11111111-1111-4111-8111-111111111111' })) + '.signature');
  localStorage.setItem('noitamap_refresh_jwt', 'header.' + btoa(JSON.stringify({ v: 2, typ: 'refresh', aud: 'noitamap-auth', sid: '11111111-1111-4111-8111-111111111111' })) + '.signature');
  const imported = await import('../src/auth/auth-service');
  auth = imported.authService;
  (auth as any).state = { authenticated: true, provider: 'patreon', accountId: 'account-1', isSubscriber: true };
  prepare = vi.fn(async () => location.href);
  (auth as any).loginReturn.prepare = prepare;
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetcher = vi.fn(async () => Response.json({ error: 'Account connections are not configured yet.' }, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('authenticated provider connections', () => {
  it('saves the workspace and starts an authenticated link without replacing the existing Pro session', async () => {
    auth.loginTwitch();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as any;
    expect(url).toMatch(/\/auth\/link\/start$/);
    expect(init.headers.Authorization).toBe('Bearer ' + localStorage.getItem('noitamap_jwt'));
    expect(JSON.parse(init.body)).toMatchObject({ provider: 'twitch', chat: false });
    expect(new URL(JSON.parse(init.body).redirect).searchParams.get('auth_nonce')).toMatch(/^[a-f0-9]{64}$/);
    expect(localStorage.getItem('noitamap_jwt')).toMatch(/^header\./);
    expect(auth.isSubscriber()).toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(window.alert).toHaveBeenCalledWith('Account connections are not configured yet.'));
  });

  it('requests explicit chat consent through the same saved-workspace link flow', async () => {
    await auth.connectTwitchChat();
    expect(prepare).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ provider: 'twitch', chat: true });
  });

  it('refuses to silently upgrade an old provider session for linking', async () => {
    delete (auth as any).state.accountId;
    await auth.connectTwitchChat();
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith('Sign in again before connecting another account.');
  });

  it('never starts OAuth when saving the current workspace fails', async () => {
    prepare.mockRejectedValue(new Error('Workspace save failed'));
    await auth.connectTwitchChat();
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith('Workspace save failed');
  });

  it('keeps Twitch access tokens in memory and returns null when consent is missing', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: 'Authorize chat' }, { status: 409 }));
    expect(await auth.getTwitchChatSession()).toBeNull();
    const credentials = { accessToken: 'chat-access', clientId: 'client', userId: '12345', login: 'host', expiresAt: Date.now() + 10000 };
    fetcher.mockResolvedValueOnce(Response.json(credentials));
    expect(await auth.getTwitchChatSession()).toEqual(credentials);
    expect([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).join('')).not.toContain('chat-access');
  });

  it.each([false, true])('completes OAuth only with the same tab and account (pending %s)', async (pending) => {
    if (pending) sessionStorage.setItem('noitamap_pending_account_link', 'account-1');
    const { beginBrowserLogin } = await import('../src/auth/browser-login');
    const redirect = new URL(beginBrowserLogin(location.href));
    redirect.searchParams.set('token', 'injected');
    redirect.hash = 'auth=linked&link_token=' + 'a'.repeat(43);
    window.history.replaceState({}, '', redirect);
    new Function(readFileSync('public/auth-bootstrap.js', 'utf8'))();
    fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/auth/link/complete')
      ? { authenticated: true, token: 'linked-access', refresh_token: 'linked-refresh', accountId: 'account-1', provider: 'patreon', isSubscriber: true }
      : { authenticated: true, accountId: 'account-1', provider: 'patreon', isSubscriber: true }));
    const original = localStorage.getItem('noitamap_jwt');
    await auth.init();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/auth/link/complete'))).toHaveLength(pending ? 1 : 0);
    expect(localStorage.getItem('noitamap_jwt')).toBe(pending ? 'linked-access' : original);
    expect(location.search).toBe('');
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem('noitamap_pending_account_link')).toBeNull();
  });
});
