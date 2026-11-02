// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { afterStartupPaint, finishNavbarStartup, showStartupFailure, startWhenReady, STARTUP_REQUEST_TIMEOUT_MS } from '../src/startup';

beforeEach(() => { vi.resetModules(); document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

describe('navbar startup', () => {
  function mount() {
    const page = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    const navbar = page.querySelector('.mapNavbar')!;
    document.body.append(navbar);
    return navbar;
  }

  it('keeps parser-time controls inert until the complete toolbar is ready', () => {
    const navbar = mount();
    const controls = navbar.querySelector('#map-menu-controls')!;
    expect(navbar.hasAttribute('data-navbar-loading')).toBe(true);
    expect(controls.hasAttribute('inert')).toBe(true);
    const button = document.createElement('button');
    button.id = 'dynamicGenerateButton';
    controls.append(button);
    const click = vi.fn(); button.addEventListener('click', click);
    finishNavbarStartup();
    expect(navbar.hasAttribute('data-navbar-loading')).toBe(false);
    expect(controls.hasAttribute('inert')).toBe(false);
    expect(navbar.getAttribute('aria-busy')).toBe('false');
    expect(navbar.querySelector('.navbar-startup')).toBeNull();
    button.click(); expect(click).toHaveBeenCalledOnce();
  });

  it('stops the placeholder on failure without revealing the unfinished static controls', () => {
    const navbar = mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    showStartupFailure(new Error('Map setup failed'), 'Noitamap could not start.', 'Reload page');
    expect(navbar.hasAttribute('data-navbar-loading')).toBe(true);
    expect(navbar.querySelector('#map-menu-controls')!.hasAttribute('inert')).toBe(true);
    expect(navbar.querySelector('.navbar-startup')).toBeNull();
    expect(navbar.getAttribute('aria-busy')).toBe('false');
    expect(document.querySelector('#startup-error button')!.textContent).toBe('Reload page');
  });
});

describe('document readiness', () => {
  it('gives the ready toolbar a paint opportunity before heavy initialization', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      let frame!: FrameRequestCallback;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
      const work = vi.fn(); afterStartupPaint(work);
      expect(work).not.toHaveBeenCalled();
      frame(0); expect(work).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync(); expect(work).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
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
  it('provides readable controls while the selected language is still downloading', async () => {
    history.replaceState(null, '', '/?lng=ru');
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const { default: i18n, initializeTranslations } = await import('../src/i18n');
    const loading = initializeTranslations();
    expect(i18n.isInitialized).not.toBe(true);
    expect(i18n.t('dynamicMap.generate.label')).toBe('Generate');
    await vi.waitFor(() => expect(release).toBeDefined());
    const russian = JSON.parse(readFileSync('src/locales/ru/translation.json', 'utf8'));
    release(new Response(JSON.stringify(russian))); await loading;
    expect(i18n.t('dynamicMap.generate.label')).toBe(russian.dynamicMap.generate.label);
  });
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
