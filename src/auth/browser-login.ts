const LOGIN_NONCE_KEY = 'noitamap_login_nonce_v2';
interface LoginResponse { success?: true; linkToken?: string; error?: string }
declare global { interface Window { __noitamapAuthReturn?: LoginResponse } }

/** The nonce binds the final provider return to the tab that started it. */
export function beginBrowserLogin(redirect: string): string {
  const url = new URL(redirect);
  if (url.origin !== location.origin) throw Error('Invalid login return.');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(LOGIN_NONCE_KEY, JSON.stringify({ nonce, origin: url.origin, path: url.pathname, createdAt: Date.now() }));
  url.searchParams.set('auth_nonce', nonce);
  return url.href;
}
export function cancelBrowserLogin(): void { sessionStorage.removeItem(LOGIN_NONCE_KEY); }
export function consumeBrowserLogin(): LoginResponse | undefined {
  const result = window.__noitamapAuthReturn;
  delete window.__noitamapAuthReturn;
  return result;
}
