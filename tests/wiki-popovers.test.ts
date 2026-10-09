// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/i18n', () => ({ default: {
  t: (_key: string, options: { defaultValue: string }) => state.language === 'ru'
    ? 'Открыть в Noita Wiki' : options.defaultValue,
} }));
import { attachWikiLinkPopover, dismissPopovers, installPopoverTouchDismiss } from '../src/popover-util';

class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  hide = vi.fn();
  dispose = vi.fn(() => { Popover.instances.delete(this.element); });
  constructor(readonly element: Element, readonly config: Record<string, unknown>) {
    Popover.instances.set(element, this);
  }
}

describe('Noita Wiki link help', () => {
  beforeEach(() => {
    state.language = 'en';
    vi.stubGlobal('bootstrap', { Popover });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    document.body.innerHTML = '<section><h2><a href="https://noita.wiki.gg/wiki/Rotta" target="_blank" rel="noopener">Rotta</a></h2></section>';
  });
  afterEach(() => {
    dismissPopovers(document.body);
    Popover.instances.clear(); document.body.replaceChildren(); vi.unstubAllGlobals();
  });

  it('attaches hover/focus help to the actual link and preserves its name and destination', () => {
    const link = document.querySelector('a')!;
    attachWikiLinkPopover(link);
    expect(Popover.instances.size).toBe(1);
    expect(Popover.getInstance(link)!.config).toMatchObject({
      content: 'Open in Noita Wiki', trigger: 'hover focus', container: 'body',
      placement: 'top', delay: { show: 80, hide: 120 },
    });
    expect(Popover.getInstance(link.parentElement!)).toBeNull();
    expect(link.textContent).toBe('Rotta');
    expect(link.href).toBe('https://noita.wiki.gg/wiki/Rotta');
    expect(link.target).toBe('_blank');
    expect(link.getAttribute('aria-description')).toBe('Open in Noita Wiki');
    expect(link.dataset.popoverOwner).toBe('wiki-link');
    expect(link.classList.contains('wiki-link')).toBe(true);
  });

  it('replaces translated help without leaving the previous instance behind', () => {
    const link = document.querySelector('a')!;
    attachWikiLinkPopover(link);
    const previous = Popover.getInstance(link)!;
    state.language = 'ru'; attachWikiLinkPopover(link);
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(Popover.instances.size).toBe(1);
    expect(Popover.getInstance(link)!.config.content).toBe('Открыть в Noita Wiki');
    expect(link.getAttribute('aria-description')).toBe('Открыть в Noita Wiki');
    const current = Popover.getInstance(link)!;
    dismissPopovers(document.querySelector('section')!);
    dismissPopovers(document.querySelector('section')!);
    expect(current.dispose).toHaveBeenCalledOnce();
    expect(Popover.instances.size).toBe(0);
  });

  it('suppresses touch help while leaving the link click available for native navigation', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    installPopoverTouchDismiss();
    const link = document.querySelector('a')!;
    attachWikiLinkPopover(link);
    const show = new Event('show.bs.popover', { bubbles: true, cancelable: true });
    link.dispatchEvent(show);
    expect(show.defaultPrevented).toBe(true);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    let navigationAvailable = false;
    link.addEventListener('click', event => { navigationAvailable = !event.defaultPrevented; });
    // Stop jsdom navigating only after observing that the link's action is free.
    link.parentElement!.addEventListener('click', event => event.preventDefault());
    link.dispatchEvent(click);
    expect(navigationAvailable).toBe(true);
  });

  it('allows hover help on desktop', () => {
    installPopoverTouchDismiss();
    const link = document.querySelector('a')!;
    attachWikiLinkPopover(link);
    const show = new Event('show.bs.popover', { bubbles: true, cancelable: true });
    link.dispatchEvent(show);
    expect(show.defaultPrevented).toBe(false);
  });
});
