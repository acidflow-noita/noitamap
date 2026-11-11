// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginBrowserLogin, consumeBrowserLogin } from '../src/auth/browser-login';

const source = readFileSync('public/auth-bootstrap.js', 'utf8');
const run = () => new Function(source)();
const credential = (type: string) => 'header.' + btoa(JSON.stringify({ v: 2, typ: type, aud: 'noitamap-auth', sid: '11111111-1111-4111-8111-111111111111' })) + '.signature';
const mine = credential('access'), fresh = credential('access'), refresh = credential('refresh');
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
  }
  delete window.__noitamapAuthReturn;
  history.replaceState(null, '', '/guess/');
  localStorage.setItem('noitamap_session_format', '2');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('rejects attacker-supplied sessions and removes credentials before other scripts can see the URL', () => {
  localStorage.setItem('noitamap_jwt', mine);
  history.replaceState(null, '', '/guess/?auth=success&token=attacker&refresh_token=refresh#auth=success&token=attacker&refresh_token=refresh');
  run(); expect(localStorage.getItem('noitamap_jwt')).toBe(mine);
  expect(location.search).toBe(''); expect(location.hash).toBe(''); expect(consumeBrowserLogin()).toBeUndefined();
});
it('accepts a matching tab nonce once and never imports a query-string token', () => {
  const target = new URL(beginBrowserLogin(location.href)); target.hash = new URLSearchParams({ auth: 'success', token: fresh, refresh_token: refresh }).toString();
  history.replaceState(null, '', target); run();
  expect(localStorage.getItem('noitamap_jwt')).toBe(fresh); expect(consumeBrowserLogin()).toEqual({ success: true });
  expect(consumeBrowserLogin()).toBeUndefined();
  localStorage.setItem('noitamap_jwt', mine); history.replaceState(null, '', target); run();
  expect(localStorage.getItem('noitamap_jwt')).toBe(mine);
  const query = new URL(beginBrowserLogin(location.href)); query.searchParams.set('auth', 'success');
  query.searchParams.set('token', 'query-access'); query.searchParams.set('refresh_token', 'query-refresh');
  history.replaceState(null, '', query); run(); expect(localStorage.getItem('noitamap_jwt')).toBe(mine);
});
it('rejects an expired nonce, a different path and a different tab', () => {
  const target = new URL(beginBrowserLogin(location.href)); target.hash = 'auth=success&token=foreign&refresh_token=refresh';
  const pending = sessionStorage.getItem('noitamap_login_nonce_v2')!;
  const expired = JSON.parse(pending); expired.createdAt -= 600001; sessionStorage.setItem('noitamap_login_nonce_v2', JSON.stringify(expired));
  history.replaceState(null, '', target); run(); expect(localStorage.getItem('noitamap_jwt')).toBeNull();
  sessionStorage.setItem('noitamap_login_nonce_v2', pending); target.pathname = '/';
  history.replaceState(null, '', target); run(); expect(localStorage.getItem('noitamap_jwt')).toBeNull();
  sessionStorage.clear(); target.pathname = '/guess/'; history.replaceState(null, '', target); run();
  expect(localStorage.getItem('noitamap_jwt')).toBeNull();
});
it('forces old sessions out without notifying or preserving their tokens', () => {
  localStorage.removeItem('noitamap_session_format'); localStorage.setItem('noitamap_jwt', 'old');
  localStorage.setItem('noitamap_refresh_jwt', 'old-refresh');
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  run(); expect(localStorage.getItem('noitamap_jwt')).toBeNull(); expect(localStorage.getItem('noitamap_refresh_jwt')).toBeNull();
  expect(alert).not.toHaveBeenCalled(); alert.mockRestore();
});
it('preserves unrelated map/drawing fragments and runs before analytics in both entry pages', () => {
  history.replaceState(null, '', '/?token=discard#drawing-payload'); run();
  expect(location.hash).toBe('#drawing-payload');
  for (const path of ['index.html', 'guess/index.html']) {
    const html = readFileSync(path, 'utf8');
    expect(html.match(/<script\b[^>]*>/)?.[0]).toBe('<script data-cfasync="false" src="/auth-bootstrap.js">');
  }
});
