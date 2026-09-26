// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/i18n', () => ({ default: { t: (_key: string, value: { defaultValue: string }) => value.defaultValue } }));
import { attachHoverPopover, attachWikiLinkPopover, dismissPopovers } from '../src/popover-util';

// Exercise the exact Bootstrap version loaded by index.html, including its
// timers, event listeners, DOM panels, focus state and disposal. No browser.
import Popover from 'bootstrap/js/dist/popover';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('bootstrap', { Popover });
});

afterEach(() => {
  dismissPopovers(document.body);
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(kind: 'bartender' | 'wiki' = 'bartender') {
  const card = document.createElement('div');
  card.innerHTML = '<a href="https://bartender.runfast.stream/reactions?reagents=blood" target="_blank"><span>Blood</span><i>↗</i></a>';
  document.body.append(card);
  const link = card.querySelector('a')!;
  const attach = () => kind === 'wiki'
    ? attachWikiLinkPopover(link)
    : attachHoverPopover(link, 'Open in Bartender', 'top', { focus: true, owner: 'bartender-link' });
  attach();
  return { card, link, attach };
}

function hover(link: HTMLElement, relatedTarget: EventTarget | null = document.body) {
  link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }));
}

function activate(target: Element, type = 'click', options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  return event;
}

describe('card-link popover dismissal', () => {
  it.each(['bartender', 'wiki'] as const)('dismisses a visible %s panel while preserving link focus and destination', kind => {
    const { link } = fixture(kind);
    const destination = link.href;
    link.focus();
    hover(link);
    vi.advanceTimersByTime(80);
    expect(document.querySelector('.popover')).not.toBeNull();

    activate(link.querySelector('span')!);
    expect(document.querySelector('.popover')).toBeNull();
    expect(link.hasAttribute('aria-describedby')).toBe(false);
    expect(document.activeElement).toBe(link);
    expect(link.href).toBe(destination);
    expect(link.target).toBe('_blank');
    vi.runAllTimers();
    expect(document.querySelector('.popover')).toBeNull();
  });

  it.each(['bartender', 'wiki'] as const)('keeps %s dismissed when opening a tab restores focus to the link', kind => {
    const { link } = fixture(kind);
    link.focus();
    hover(link);
    vi.advanceTimersByTime(80);
    activate(link);
    expect(document.querySelector('.popover')).toBeNull();

    // A new tab/window takes focus without focusing another element in the map.
    link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    link.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    window.dispatchEvent(new FocusEvent('blur'));
    window.dispatchEvent(new FocusEvent('focus'));
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null }));
    hover(link, null);
    vi.advanceTimersByTime(500);
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('cancels help that is still waiting for its hover delay when clicked', () => {
    const { link } = fixture();
    link.focus();
    hover(link);
    vi.advanceTimersByTime(40);
    activate(link);
    vi.runAllTimers();
    expect(document.querySelector('.popover')).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it('does not rearm while the pointer moves between the activated link text and icon', () => {
    const { link } = fixture();
    hover(link);
    vi.advanceTimersByTime(80);
    activate(link.querySelector('span')!);
    link.querySelector('i')!.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true, relatedTarget: link.querySelector('span'),
    }));
    vi.advanceTimersByTime(500);
    expect(document.querySelector('.popover')).toBeNull();
    expect(Popover.getInstance(link)).toBeNull();
  });

  it.each(['hover', 'focus'] as const)('shows help again on a fresh %s after activation', trigger => {
    const { link } = fixture();
    link.focus();
    hover(link);
    vi.advanceTimersByTime(80);
    activate(link);
    expect(document.querySelector('.popover')).toBeNull();

    if (trigger === 'hover') {
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      hover(link);
    } else {
      const next = document.createElement('button');
      document.body.append(next);
      next.focus();
      link.focus();
    }
    vi.advanceTimersByTime(80);
    expect(document.querySelector('.popover')?.textContent).toBe('Open in Bartender');
  });

  it.each([
    ['middle', 'auxclick', { button: 1 }],
    ['Ctrl', 'click', { ctrlKey: true }],
    ['Command', 'click', { metaKey: true }],
    ['Shift', 'click', { shiftKey: true }],
    ['keyboard', 'click', { detail: 0 }],
  ] as const)('dismisses on %s activation without cancelling native navigation', (_name, type, options) => {
    const { link } = fixture();
    hover(link);
    vi.advanceTimersByTime(80);
    activate(link.querySelector('i')!, type, options);
    expect(document.querySelector('.popover')).toBeNull();
    vi.runAllTimers();
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('leaves native context menus and right-button auxiliary clicks alone', () => {
    const { link } = fixture();
    hover(link);
    vi.advanceTimersByTime(80);
    const instance = Popover.getInstance(link);
    activate(link, 'contextmenu', { button: 2 });
    activate(link, 'auxclick', { button: 2 });
    expect(Popover.getInstance(link)).toBe(instance);
    expect(document.querySelector('.popover')).not.toBeNull();
  });

  it('cleans old activation handlers when translated help is reattached', () => {
    const { link, attach } = fixture();
    attach();
    hover(link);
    vi.advanceTimersByTime(80);
    activate(link);
    expect(document.querySelector('.popover')).toBeNull();
    expect(Popover.getInstance(link)).toBeNull();
    hover(link);
    vi.advanceTimersByTime(80);
    expect(document.querySelectorAll('.popover')).toHaveLength(1);
  });

  it('cancels pending help and activation handlers when its card is torn down', () => {
    const { card, link } = fixture();
    hover(link);
    dismissPopovers(card);
    card.remove();
    vi.runAllTimers();
    expect(document.querySelector('.popover')).toBeNull();
    activate(link);
    expect(Popover.getInstance(link)).toBeNull();
  });

  it('removes dormant rearm handlers when an activated card is disposed', () => {
    const { card, link } = fixture();
    activate(link);
    dismissPopovers(card);
    hover(link);
    vi.advanceTimersByTime(500);
    expect(document.querySelector('.popover')).toBeNull();
    expect(Popover.getInstance(link)).toBeNull();
  });

  it('disables link transition callbacks while retaining ordinary hover-help animation', () => {
    const { link } = fixture();
    expect((Popover.getInstance(link) as any)?._config.animation).toBe(false);
    const badge = document.createElement('span');
    document.body.append(badge);
    attachHoverPopover(badge, 'Always casts');
    expect((Popover.getInstance(badge) as any)?._config.animation).not.toBe(false);
  });
});
