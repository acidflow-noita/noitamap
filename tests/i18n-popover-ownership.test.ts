// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translations = vi.hoisted(() => ({
  language: 'en',
  listeners: [] as Array<() => void>,
  t(key: string) {
    return key === 'dynamicMap.seedTooltipCustom'
      ? `<span style="color:var(--daily-fg);font-weight:600">${this.language} daily</span>`
      : `${this.language}:${key}`;
  },
  on(_event: string, listener: () => void) { this.listeners.push(listener); },
}));
vi.mock('../src/i18n', () => ({ default: translations }));
vi.mock('i18next', () => ({ default: translations }));
vi.mock('../src/nav', () => ({ updateMapLinkTranslations: vi.fn() }));
vi.mock('../src/data_sources/overlays', () => ({ refreshOverlayTranslations: vi.fn() }));
vi.mock('../src/main', () => ({ refreshSearchTranslations: vi.fn() }));
vi.mock('../src/data_sources/daily_seed', () => ({ getCachedDailySeedIdentity: vi.fn() }));
vi.mock('../src/data_sources/url', () => ({}));
vi.mock('../src/dynamic-map', () => ({ getCurrentDynamicSeed: () => 42 }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));
vi.mock('../src/overflow-menu', () => ({}));
import { getCachedDailySeedIdentity } from '../src/data_sources/daily_seed';

// Bootstrap's dispose is intentionally not idempotent: a second call must
// expose stale owner references, rather than silently hiding the regression.
class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  disposed = false;
  _config: Record<string, unknown>;
  tip?: HTMLElement;
  constructor(private element: Element, config?: Record<string, unknown>) {
    this._config = { html: false, sanitize: true, title: element.getAttribute('data-bs-title'),
      content: element.getAttribute('data-bs-content'), ...config };
    Popover.instances.set(element, this);
  }
  dispose() {
    if (this.disposed) throw new Error('Popover already disposed');
    this.disposed = true;
    this.tip?.remove();
    Popover.instances.delete(this.element);
  }
  hide() {}
}

describe('translation refresh preserves programmatically owned popovers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    translations.language = 'en';
    translations.listeners = [];
    Popover.instances.clear();
    vi.stubGlobal('bootstrap', { Popover, Tooltip: Popover });
    document.body.innerHTML = '<div class="collapse navbar-collapse"><div class="d-flex flex-wrap"></div></div>';
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  async function createToolbar() {
    const { createDynamicUI } = await import('../src/dynamic_ui');
    createDynamicUI({} as Parameters<typeof createDynamicUI>[0]);
    return document.getElementById('dynamicSeedInput')!;
  }

  it.each([
    { identity: null, dailyMode: true, className: null },
    { identity: null, dailyMode: false, className: null },
    { identity: 'today' as const, dailyMode: false, className: 'seed-daily' },
    { identity: 'previous' as const, dailyMode: true, className: 'seed-prev-daily' },
  ])('colours seed identity $identity independently of daily generation mode $dailyMode', async ({ identity, dailyMode, className }) => {
    const input = await createToolbar();
    input.classList.add('seed-daily', 'seed-prev-daily');
    vi.mocked(getCachedDailySeedIdentity).mockReturnValue(identity);
    const { setDynamicUISeed } = await import('../src/dynamic_ui');
    setDynamicUISeed(42, dailyMode);
    expect(input.classList.contains('seed-daily')).toBe(className === 'seed-daily');
    expect(input.classList.contains('seed-prev-daily')).toBe(className === 'seed-prev-daily');
  });

  it('keeps the actual seed input HTML configuration and its visible panel during a map refresh', async () => {
    const input = await createToolbar();
    const original = Popover.getInstance(input)!;
    const dispose = vi.spyOn(original, 'dispose');
    const tip = document.createElement('div');
    tip.className = 'popover'; tip.id = 'seed-tip';
    input.setAttribute('aria-describedby', 'seed-tip');
    document.body.appendChild(tip);
    const orphan = document.createElement('div');
    orphan.className = 'popover'; document.body.appendChild(orphan);
    const { updateTranslations } = await import('../src/i18n-dom');
    updateTranslations(); updateTranslations();
    expect(Popover.getInstance(input)).toBe(original);
    expect(dispose).not.toHaveBeenCalled();
    expect(original._config).toMatchObject({ html: true, sanitize: false });
    expect(tip.isConnected).toBe(true);
    expect(orphan.isConnected).toBe(false);
  });

  it('lets the toolbar owner translate the seed once while ordinary popovers still refresh', async () => {
    const input = await createToolbar();
    const original = Popover.getInstance(input)!;
    const dispose = vi.spyOn(original, 'dispose');
    const daily = document.getElementById('dynamicDailySeedButton')!;
    const { updateTranslations } = await import('../src/i18n-dom');
    translations.language = 'ru';
    updateTranslations();
    expect(Popover.getInstance(daily)!._config.title).toBe('ru:dynamicMap.daily');
    translations.listeners.forEach(listener => listener());
    expect(dispose).toHaveBeenCalledOnce();
    const translated = Popover.getInstance(input)!;
    expect(translated).not.toBe(original);
    expect(translated._config).toMatchObject({ html: true, sanitize: false });
    expect(translated._config.content).toContain('ru daily');
    updateTranslations();
    expect(Popover.getInstance(input)).toBe(translated);
  });

  it('leaves a custom report popover available for its owner to dispose after translation', async () => {
    const link = document.createElement('a');
    link.setAttribute('data-bs-toggle', 'popover');
    link.setAttribute('data-popover-owner', 'seed-report');
    document.body.appendChild(link);
    const body = document.createElement('div');
    body.textContent = 'Sage details';
    const original = new Popover(link, { html: true, content: body });
    const { updateTranslations } = await import('../src/i18n-dom');
    updateTranslations();
    expect(Popover.getInstance(link)).toBe(original);
    expect(original._config.content).toBe(body);
    expect(() => original.dispose()).not.toThrow();
    expect(Popover.getInstance(link)).toBeNull();
  });

  it.each([false, true])('preserves hover-help ownership and disposes the current registration (declarative trigger: %s)', async declarative => {
    const { attachHoverPopover, dismissPopovers } = await import('../src/popover-util');
    const root = document.createElement('div');
    const badge = document.createElement('span');
    if (declarative) badge.dataset.bsToggle = 'popover';
    root.appendChild(badge); document.body.appendChild(root);
    attachHoverPopover(badge, 'Always casts', 'bottom');
    const original = Popover.getInstance(badge)!;
    const dispose = vi.spyOn(original, 'dispose');
    const { updateTranslations } = await import('../src/i18n-dom');
    updateTranslations();
    expect(Popover.getInstance(badge)).toBe(original);
    expect(dispose).not.toHaveBeenCalled();
    expect(original._config).toMatchObject({ content: 'Always casts', placement: 'bottom' });
    // Another legitimate owner refresh can replace an instance before teardown.
    original.dispose();
    const replacement = new Popover(badge, { content: 'Translated help' });
    const disposeReplacement = vi.spyOn(replacement, 'dispose');
    dismissPopovers(root); dismissPopovers(root);
    expect(disposeReplacement).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(Popover.getInstance(badge)).toBeNull();
    expect((badge as any).__disposePopover).toBeUndefined();
  });
});
