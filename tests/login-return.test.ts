// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginReturn, LOGIN_RETURN_KEY, LOGIN_RETURN_PARAM } from '../src/auth/login-return';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  history.replaceState(null, '', '/?m=dy&se=12345#original-fragment');
});
afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

it('waits for drawing persistence and returns only an opaque ticket in the OAuth URL', async () => {
  const flow = new LoginReturn(); let finish!: () => void;
  flow.register('map', () => ({ view: { x: 1.125, y: -8.875, zoom: 0.00123456789 } }));
  flow.register('drawing', async id => { await new Promise<void>(r => { finish = r; }); return { checkpointId: id, sidebarOpen: true }; });
  let ready = false; const pending = flow.prepare().then(url => { ready = true; return url; });
  await Promise.resolve(); expect(ready).toBe(false); expect(values.size).toBe(0);
  finish(); const url = new URL(await pending);
  expect(url.searchParams.get(LOGIN_RETURN_PARAM)).toBeTruthy();
  expect(url.searchParams.get('se')).toBe('12345'); expect(url.hash).toBe('#original-fragment');
  expect(url.href).not.toContain('checkpointId'); expect(url.href).not.toContain('0.00123456789');
  expect(flow.get('drawing')).toBeNull();
  url.hash = '#auth=success&token=secret';
  expect(flow.arrive(url)).toBe(true); expect(url.hash).toBe('#original-fragment');
  expect(url.searchParams.has(LOGIN_RETURN_PARAM)).toBe(false);
  expect(flow.get('map')?.data).toEqual({ view: { x: 1.125, y: -8.875, zoom: 0.00123456789 } });
});

it('consumes map and drawing independently and cannot clear a newer return with an old callback', async () => {
  const flow = new LoginReturn(); flow.register('map', () => ({})); flow.register('drawing', () => ({}));
  const first = new URL(await flow.prepare()); flow.arrive(first);
  const old = flow.get('map')!.id; flow.complete('map', old);
  expect(flow.get('map')).toBeNull(); expect(flow.get('drawing')).not.toBeNull();
  const next = new URL(await flow.prepare()); flow.arrive(next);
  flow.complete('drawing', old); expect(flow.get('drawing')).not.toBeNull();
  const current = flow.get('drawing')!.id;
  flow.complete('map', current); flow.complete('drawing', current); expect(values.size).toBe(0);
});

it('restores error/cancel returns and an uncached Back navigation', async () => {
  const flow = new LoginReturn(); flow.register('drawing', () => ({ sidebarOpen: true }));
  const denied = new URL(await flow.prepare()); denied.searchParams.set('auth_error', 'access_denied');
  flow.arrive(denied); expect(flow.get('drawing')).not.toBeNull();
  await flow.prepare();
  expect(flow.arrive(new URL(location.href))).toBe(true);
  expect(flow.get('drawing')).not.toBeNull();
});

it('does not replay an abandoned checkpoint after a live Back/Forward-cache return', async () => {
  const flow = new LoginReturn(), discard = vi.fn(); flow.register('drawing', () => ({}), discard);
  const first = new URL(await flow.prepare());
  flow.discardUnreturned(); expect(values.size).toBe(0);
  await Promise.resolve(); expect(discard).toHaveBeenCalledExactlyOnceWith(first.searchParams.get(LOGIN_RETURN_PARAM));
  const retry = new URL(await flow.prepare()); flow.arrive(retry); flow.discardUnreturned();
  expect(flow.get('drawing')).not.toBeNull(); expect(discard).toHaveBeenCalledOnce();
});

it('rejects mismatched tickets and resumes only on the original origin/path', async () => {
  const flow = new LoginReturn(); flow.register('drawing', () => ({}));
  const url = new URL(await flow.prepare()); url.searchParams.set(LOGIN_RETURN_PARAM, 'wrong');
  flow.arrive(url); expect(flow.get('drawing')).toBeNull();
  const saved = JSON.parse(values.get(LOGIN_RETURN_KEY)!); saved.url = 'https://unrelated.example/'; saved.returned = true;
  values.set(LOGIN_RETURN_KEY, JSON.stringify(saved)); expect(flow.get('drawing')).toBeNull();
});

it('never puts auth credentials into the checkpoint or return URL', async () => {
  history.replaceState(null, '', '/?token=private&refresh_token=private2&auth=success#auth=success&token=private3');
  const flow = new LoginReturn(); flow.register('map', () => ({}));
  const url = await flow.prepare();
  expect(url).not.toContain('private'); expect([...values.values()].join('')).not.toContain('private');
});

it('rolls back completed checkpoints if a save fails, after all captures settle', async () => {
  const flow = new LoginReturn(), remove = vi.fn(); let finish!: () => void;
  flow.register('map', async () => { throw new Error('save failed'); });
  flow.register('drawing', () => new Promise(r => { finish = () => r({}); }), remove);
  const pending = flow.prepare(); const failed = expect(pending).rejects.toThrow('save failed');
  await Promise.resolve(); expect(remove).not.toHaveBeenCalled(); finish(); await failed;
  expect(remove).toHaveBeenCalledOnce(); expect(values.size).toBe(0);
});

it('cancels the redirect preparation and cleans up if session storage is unavailable', async () => {
  const flow = new LoginReturn(), remove = vi.fn(); flow.register('drawing', () => ({}), remove);
  vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(flow.prepare()).rejects.toThrow('quota'); expect(remove).toHaveBeenCalledOnce();
});
