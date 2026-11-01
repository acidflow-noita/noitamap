// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  localStorage.setItem('noitamap_jwt', 'existing-account-access');
  localStorage.setItem('noitamap_refresh_jwt', 'existing-account-refresh');
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
    expect(init.headers.Authorization).toBe('Bearer existing-account-access');
    expect(JSON.parse(init.body)).toMatchObject({ provider: 'twitch', chat: false, redirect: location.href });
    expect(localStorage.getItem('noitamap_jwt')).toBe('existing-account-access');
    expect(auth.isSubscriber()).toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(window.alert).toHaveBeenCalledWith('Account connections are not configured yet.'));
  });

  it('requests explicit chat consent through the same saved-workspace link flow', async () => {
    await auth.connectTwitchChat();
    expect(prepare).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ provider: 'twitch', chat: true });
  });

  it('migrates old provider sessions via their encrypted refresh token before linking', async () => {
    delete (auth as any).state.accountId;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/auth/refresh')
      ? Response.json({ authenticated: true, token: 'new-account-access', refresh_token: 'new-account-refresh',
        accountId: 'account-1', provider: 'patreon', isSubscriber: true })
      : Response.json({ error: 'Connection failed' }, { status: 503 }));
    auth.loginTwitch();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[0][0]).toMatch(/\/auth\/refresh$/);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer existing-account-refresh');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer new-account-access');
    expect(auth.isSubscriber()).toBe(true);
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
    window.history.replaceState({}, '', '/guess/?auth=success&token=injected#auth=linked&link_token=completion');
    fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/auth/link/complete')
      ? { authenticated: true, token: 'linked-access', refresh_token: 'linked-refresh', accountId: 'account-1', provider: 'patreon', isSubscriber: true }
      : { authenticated: true, accountId: 'account-1', provider: 'patreon', isSubscriber: true }));
    await auth.init();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/auth/link/complete'))).toHaveLength(pending ? 1 : 0);
    expect(localStorage.getItem('noitamap_jwt')).toBe(pending ? 'linked-access' : 'existing-account-access');
    expect(location.search).toBe('');
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem('noitamap_pending_account_link')).toBeNull();
  });
});
