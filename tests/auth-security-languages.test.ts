// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18next, { initializeTranslations } from '../src/i18n';
import { authSecurityMessage, loadAuthSecurityTranslations } from '../src/auth/security-messages';
import { resolveAuthWorkerUrl } from '../src/auth/auth-service';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

it('loads every security dialog/error catalog and switches its messages with the chosen language', async () => {
  await initializeTranslations();
  const languages = ['en','br','cs','de','es','fi','fr','id','it','ja','nl','pl','ru','sv','uk','zh'];
  for (const language of languages) i18next.addResourceBundle(language, 'translation', {});
  await loadAuthSecurityTranslations();
  for (const language of languages) {
    await i18next.changeLanguage(language);
    const catalog = JSON.parse(readFileSync(`src/auth/locales/${language}.json`, 'utf8'));
    for (const key of ['Confirm linking your accounts', 'Account you want to link', 'Link this account', 'Could not connect this account.'])
      expect(await authSecurityMessage(key)).toBe(catalog[key]);
  }
  await i18next.changeLanguage('en');
});
it('routes previews to isolated auth and never uses a remote production override on localhost', () => {
  expect(resolveAuthWorkerUrl('dynamic-map.noitamap.com')).toBe('https://noitamap-auth.wuote.workers.dev');
  expect(resolveAuthWorkerUrl('noitamap.com')).toBe('https://noitamap-auth.wuote.workers.dev');
  for (const host of ['dev.noitamap.com', 'dynamic-map.noitamap.pages.dev', 'untrusted.test'])
    expect(resolveAuthWorkerUrl(host)).toBe('https://noitamap-auth-dev.wuote.workers.dev');
  localStorage.setItem('noitamap_auth_worker', 'https://noitamap-auth.wuote.workers.dev');
  expect(resolveAuthWorkerUrl('localhost')).toBe('https://noitamap-auth-dev.wuote.workers.dev');
  localStorage.setItem('noitamap_auth_worker', 'http://127.0.0.1:8787');
  expect(resolveAuthWorkerUrl('localhost')).toBe('http://127.0.0.1:8787');
  localStorage.removeItem('noitamap_auth_worker');
});
