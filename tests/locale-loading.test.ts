// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:noitamap-locales', () => ({ default: {
  en: '/build/locale-en-contenthash.json',
  ru: '/build/locale-ru-contenthash.json',
  fr: '/build/locale-fr-contenthash.json',
} }));

afterEach(() => {
  window.history.replaceState({}, '', '/');
  document.cookie = 'i18next=; Max-Age=0; path=/';
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('on-demand locale requests', () => {
  it('loads only the detected language and English, then loads another complete dictionary on selection', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    window.history.replaceState({}, '', '/?lng=ru');
    const fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ greeting: url.includes('-ru-') ? 'Привет' : url.includes('-fr-') ? 'Bonjour' : 'Hello' }),
    }));
    vi.stubGlobal('fetch', fetch);
    const { default: i18next, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18next.t('greeting')).toBe('Привет');
    expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual([
      '/build/locale-en-contenthash.json', '/build/locale-ru-contenthash.json',
    ]);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: 'force-cache' }));
    await i18next.changeLanguage('fr');
    expect(i18next.t('greeting')).toBe('Bonjour');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe('/build/locale-fr-contenthash.json');
    await i18next.changeLanguage('ru');
    expect(i18next.t('greeting')).toBe('Привет');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
