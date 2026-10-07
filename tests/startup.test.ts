// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { showStartupFailure, startWhenReady, STARTUP_REQUEST_TIMEOUT_MS } from '../src/startup';

beforeEach(() => { vi.resetModules(); document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

describe('document readiness', () => {
  it('starts once after DOM readiness, even if readiness is dispatched again while setup is pending', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    let resolve!: () => void;
    const start = vi.fn(() => new Promise<void>(done => { resolve = done; })), error = vi.fn();
    startWhenReady(start, error); expect(start).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('DOMContentLoaded')); document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(start).toHaveBeenCalledOnce(); resolve(); await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['interactive', 'complete'] as const)('starts when the entrypoint arrives at readyState=%s', state => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue(state);
    const start = vi.fn(async () => {});
    startWhenReady(start, vi.fn()); document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(['sync', 'async'])('reports a %s initialization failure once', async kind => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    const failure = new Error('controlled startup failure'), report = vi.fn();
    startWhenReady(() => { if (kind === 'sync') throw failure; return Promise.reject(failure); }, report);
    await vi.waitFor(() => expect(report).toHaveBeenCalledExactlyOnceWith(failure));
    document.dispatchEvent(new Event('DOMContentLoaded')); expect(report).toHaveBeenCalledOnce();
  });

  it('shows one readable recovery message and stops the loading indicators', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<i id="loadingIndicator"></i><div id="map-loading-strip" class="visible fade-out"></div>';
    const failure = new Error('internal details');
    showStartupFailure(failure, 'Map unavailable <test>', 'Reload');
    showStartupFailure(failure, 'Map unavailable <test>', 'Reload');
    expect(document.querySelectorAll('#startup-error')).toHaveLength(1);
    expect(document.getElementById('startup-error')?.textContent).toBe('Map unavailable <test>Reload');
    expect(document.getElementById('startup-error')?.querySelector('test')).toBeNull();
    expect(document.querySelector('#startup-error button')?.textContent).toBe('Reload');
    expect(document.activeElement).toBe(document.querySelector('#startup-error button'));
    expect(document.getElementById('loadingIndicator')?.style.display).toBe('none');
    expect(document.getElementById('map-loading-strip')?.className).toBe('');
    expect(log).toHaveBeenCalledWith('[Noitamap] Startup failed:', failure);
  });

  it('provides recovery text in every existing UI language', () => {
    for (const language of readdirSync('src/locales')) {
      const data = JSON.parse(readFileSync(`src/locales/${language}/translation.json`, 'utf8'));
      expect(data.startup.failed, language).toContain('Noitamap');
      expect(data.startup.retry, language).toMatch(/\S/);
    }
  });
});

describe('translation availability', () => {
  it('starts in English without a locale request', async () => {
    history.replaceState(null, '', '/?lng=en');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.t('dynamicMap.generate.label')).toBe('Generate');
    expect(i18n.t('startup.retry')).toBe('Reload page');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the requested language when its locale responds normally', async () => {
    history.replaceState(null, '', '/?lng=ru');
    const russian = JSON.parse(readFileSync('src/locales/ru/translation.json', 'utf8'));
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify(russian)));
    vi.stubGlobal('fetch', fetcher);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.t('dynamicMap.generate.label')).toBe(russian.dynamicMap.generate.label);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toContain('/ru/translation.json');
  });

  it.each(['headers', 'body'])('falls back to readable English when locale %s stall', async stage => {
    history.replaceState(null, '', '/?lng=ru');
    const controllers: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController(); controllers.push(controller); return controller.signal;
    });
    const stalled = (signal: AbortSignal) => new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const body = vi.fn();
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      if (stage === 'headers') return stalled(options.signal!);
      body.mockImplementation(() => stalled(options.signal!));
      return Promise.resolve({ ok: true, status: 200, text: body });
    });
    vi.stubGlobal('fetch', fetcher);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    const ready = initializeTranslations();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    if (stage === 'body') await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
    controllers.forEach(controller => controller.abort(new DOMException('Translation request timed out', 'TimeoutError')));
    await ready;
    expect(timeout).toHaveBeenCalledWith(STARTUP_REQUEST_TIMEOUT_MS);
    expect(i18n.t('dynamicMap.generate.label')).toBe('Generate');
    expect(i18n.t('startup.failed')).toContain('Noitamap');
    expect(i18n.language).toBe('ru'); // Do not overwrite the user's preference.
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([404, 503])('does not leave startup waiting through retries after HTTP %s', async status => {
    history.replaceState(null, '', '/?lng=ru');
    const fetcher = vi.fn(async () => new Response('', { status })); vi.stubGlobal('fetch', fetcher);
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    await initializeTranslations();
    expect(i18n.t('dynamicMap.generate.label')).toBe('Generate');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
