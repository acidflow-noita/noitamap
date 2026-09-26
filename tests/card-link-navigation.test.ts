// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/i18n', () => ({ default: { t: (_key: string, value: { defaultValue: string }) => value.defaultValue } }));
import { attachHoverPopover, attachWikiLinkPopover } from '../src/popover-util';

const trackers: Array<{ destroy(): void }> = [];
let OpenSeadragon: typeof import('openseadragon');
beforeAll(async () => {
  // Only MouseTracker is exercised. Its package also probes canvas support
  // at import time, which jsdom correctly does not supply.
  const canvasProbe = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  try { OpenSeadragon = (await import('openseadragon')).default; }
  finally { canvasProbe.mockRestore(); }
});
afterEach(() => {
  trackers.splice(0).forEach(tracker => tracker.destroy());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture() {
  const canvas = document.createElement('div');
  canvas.innerHTML = '<div class="osOverlayPopup"><a href="https://bartender.runfast.stream/reactions?reagents=blood" target="_blank"><span>Blood</span><i>↗</i></a></div>';
  document.body.append(canvas);
  const clickHandler = vi.fn();
  const pressHandler = vi.fn();
  const tracker = new OpenSeadragon.MouseTracker({ element: canvas, clickHandler, pressHandler });
  trackers.push(tracker);
  tracker.setTracking(true);
  return { canvas, link: canvas.querySelector('a')!, clickHandler, pressHandler };
}

describe('native card navigation inside the real OSD mouse tracker', () => {
  it('demonstrates why unprotected overlay links fail while map clicks stay owned by OSD', () => {
    const { canvas, link } = fixture();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    attachHoverPopover(link, 'Open in Bartender', 'top', { focus: true });
    const mapClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(mapClick);
    expect(mapClick.defaultPrevented).toBe(true);
  });

  it.each(['link', 'text', 'icon'])('preserves native Bartender navigation from the %s, including modifiers and keyboard clicks', targetName => {
    const { link } = fixture();
    attachHoverPopover(link, 'Open in Bartender', 'top', { focus: true });
    const target = targetName === 'text' ? link.querySelector('span')! : targetName === 'icon' ? link.querySelector('i')! : link;
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { detail: 0 }]) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
      target.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    target.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    expect(link.href).toBe('https://bartender.runfast.stream/reactions?reagents=blood');
  });

  it.each(['mouse', 'touch', 'pen'])('does not let a %s press on a card link become a map gesture', pointerType => {
    const { link, pressHandler, clickHandler } = fixture();
    attachHoverPopover(link, 'Open in Bartender', 'top', { focus: true });
    const target = link.querySelector('span')!;
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(pressHandler).not.toHaveBeenCalled();
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it('also protects Wiki links without requiring Bootstrap or window.open overrides', () => {
    const { link } = fixture();
    vi.stubGlobal('bootstrap', undefined);
    link.href = 'https://noita.wiki.gg/wiki/Rotta';
    attachWikiLinkPopover(link);
    attachWikiLinkPopover(link); // Translation refresh does not duplicate handlers.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.querySelector('i')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(link.href).toBe('https://noita.wiki.gg/wiki/Rotta');
  });
});
