// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availablePOICardRect, mountPOICardPlacement, planPOICardPlacement, type CardRect } from '../src/telescope/poi-card-placement';

const rect = (left: number, top: number, right: number, bottom: number): CardRect => ({ left, top, right, bottom });
const overlaps = (a: CardRect, b: CardRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('visible map area for POI cards', () => {
  it('excludes the report in its actual position, including an offset canvas', () => {
    expect(availablePOICardRect(rect(50, 80, 1250, 880), rect(0, 0, 1300, 700), rect(850, 100, 1250, 850)))
      .toEqual(rect(50, 80, 850, 700));
    expect(availablePOICardRect(rect(0, 76, 390, 844), rect(0, 110, 390, 540), rect(0, 464, 390, 844)))
      .toEqual(rect(0, 110, 390, 464));
  });

  it('handles a keyboard and horizontal visual-viewport offset without using window dimensions', () => {
    expect(availablePOICardRect(rect(0, 76, 1200, 844), rect(80, 130, 470, 350)))
      .toEqual(rect(80, 130, 470, 350));
  });

  it('ignores an offscreen report and retains usable controls if the report covers everything', () => {
    const visible = rect(0, 76, 390, 410);
    expect(availablePOICardRect(visible, visible, rect(0, 464, 390, 844))).toEqual(visible);
    expect(availablePOICardRect(visible, visible, visible)).toEqual(visible);
    expect(availablePOICardRect(visible, rect(0, 0, 390, 70))).toBeNull();
  });

  it('keeps short and overflowing cards within every corner of the available map', () => {
    for (const available of [rect(60, 80, 780, 760), rect(0, 110, 390, 464), rect(80, 130, 470, 350)]) {
      for (const [x, y] of [[available.left + 20, available.top + 20], [available.right - 20, available.bottom - 20],
        [available.left - 200, available.top - 200], [available.right + 200, available.bottom + 500],
        [(available.left + available.right) / 2, (available.top + available.bottom) / 2]]) {
        for (const h of [110.375, 500.625, 1800]) {
          const selected = rect(x - 18, y - 18, x + 18, y + 18);
          const p = planPOICardPlacement(available, selected, 448, h);
          const card = rect(p.left, p.top, p.left + p.width, p.top + Math.min(h, p.maxHeight));
          expect(card.left).toBeGreaterThanOrEqual(available.left + 12);
          expect(card.top).toBeGreaterThanOrEqual(available.top + 12);
          expect(card.right).toBeLessThanOrEqual(available.right - 12);
          expect(card.bottom).toBeLessThanOrEqual(available.bottom - 12);
        }
      }
    }
  });

  it('keeps the selected sprite uncovered when there is a usable side or vertical space', () => {
    for (const [available, selected] of [
      [rect(0, 76, 1280, 800), rect(180, 330, 220, 370)],
      [rect(0, 76, 390, 844), rect(175, 402, 215, 442)],
    ]) {
      const p = planPOICardPlacement(available, selected, 448, 1200);
      expect(overlaps(rect(p.left, p.top, p.left + p.width, p.top + p.maxHeight), selected)).toBe(false);
    }
  });
});

describe('card placement ownership and updates', () => {
  const cleanups: Array<() => void> = [];
  let resizeObservers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>;
  beforeEach(() => {
    vi.useFakeTimers(); resizeObservers = [];
    vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
      constructor(public callback: () => void) { resizeObservers.push(this); }
    });
  });
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const tick = async () => { await Promise.resolve(); vi.advanceTimersByTime(20); await Promise.resolve(); };

  function mount() {
    const canvas = document.createElement('div'), card = document.createElement('div');
    document.body.append(canvas, card);
    let canvasBounds = new DOMRect(0, 76, 1200, 724), naturalHeight = 530.625, current = true;
    canvas.getBoundingClientRect = () => canvasBounds;
    Object.defineProperty(canvas, 'clientWidth', { get: () => canvasBounds.width });
    Object.defineProperty(canvas, 'clientHeight', { get: () => canvasBounds.height });
    const measurements: Array<{ maxHeight: string; scrollTop: number }> = [];
    card.getBoundingClientRect = vi.fn(() => {
      measurements.push({ maxHeight: card.style.maxHeight, scrollTop: card.scrollTop });
      return new DOMRect(parseFloat(card.style.left) || 0, parseFloat(card.style.top) || 0,
        Math.min(parseFloat(card.style.width) || 448, parseFloat(card.style.maxWidth) || Infinity),
        Math.min(naturalHeight, parseFloat(card.style.maxHeight) || Infinity));
    });
    const visual = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 1200, height: 800 });
    vi.stubGlobal('visualViewport', visual);
    const handlers = new Map<string, Set<() => void>>();
    const viewport = {
      pixelFromPoint: vi.fn(({ x, y }: { x: number; y: number }, displayed: boolean) => ({ x: x + (displayed ? 0 : 500), y })),
      panTo: vi.fn(), zoomTo: vi.fn(),
    };
    const viewer = { canvas, viewport,
      addHandler: (name: string, cb: () => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(cb); },
      removeHandler: (name: string, cb: () => void) => handlers.get(name)?.delete(cb),
    };
    const cleanup = mountPOICardPlacement(card, { viewer, anchor: { x: 200, y: 280 }, isCurrent: () => current });
    cleanups.push(cleanup);
    return { canvas, card, visual, viewport, cleanup, measurements,
      emit: (name: string) => { for (const cb of [...handlers.get(name) ?? []]) cb(); },
      invalidate: () => { current = false; },
      shrink: () => { canvasBounds = new DOMRect(0, 76, 390, 768); visual.width = 390; visual.height = 844; window.dispatchEvent(new Event('resize')); },
      grow: () => { naturalHeight = 1800; card.append(document.createElement('p')); },
    };
  }
  const bounds = (card: HTMLElement) => card.getBoundingClientRect();

  it('tracks the reduced visual viewport and its offset while an existing card stays open', async () => {
    const f = mount(); f.shrink(); await tick();
    Object.assign(f.visual, { offsetLeft: 30, offsetTop: 130, width: 330, height: 220 });
    f.visual.dispatchEvent(new Event('resize')); f.visual.dispatchEvent(new Event('scroll')); await tick();
    const r = bounds(f.card);
    expect(r.left).toBeGreaterThanOrEqual(42); expect(r.right).toBeLessThanOrEqual(348);
    expect(r.top).toBeGreaterThanOrEqual(142); expect(r.bottom).toBeLessThanOrEqual(338);
    expect(f.viewport.panTo).not.toHaveBeenCalled(); expect(f.viewport.zoomTo).not.toHaveBeenCalled();
    expect(f.viewport.pixelFromPoint.mock.calls.every(([, displayed]) => displayed === true)).toBe(true);
  });

  it('finds a late report, observes its resize/removal, and does not mistake a hidden legacy panel for it', async () => {
    const f = mount(), legacy = document.createElement('aside'), report = document.createElement('aside');
    legacy.id = 'seed-report-sidebar'; legacy.hidden = true;
    report.id = 'seed-report-v3'; report.hidden = true;
    let left = 700;
    report.getBoundingClientRect = () => new DOMRect(left, 76, 1200 - left, 724);
    document.body.append(legacy, report); await tick();
    report.hidden = false; report.classList.add('open'); await tick();
    expect(bounds(f.card).right).toBeLessThanOrEqual(688);
    left = 500; resizeObservers[0].callback(); await tick();
    expect(bounds(f.card).right).toBeLessThanOrEqual(488);
    report.remove(); await tick();
    expect(bounds(f.card).right).toBeGreaterThan(500);
    expect(resizeObservers[0].unobserve).toHaveBeenCalledWith(report);
  });

  it('uses height above a bottom sheet instead of subtracting its full screen width', async () => {
    const f = mount(); f.shrink();
    const report = document.createElement('aside'); report.id = 'seed-report-v3'; report.className = 'open';
    report.getBoundingClientRect = () => new DOMRect(0, 464, 390, 380);
    document.body.append(report); await tick();
    const r = bounds(f.card);
    expect(r.width).toBe(366); expect(r.top).toBeGreaterThanOrEqual(88); expect(r.bottom).toBeLessThanOrEqual(452);
  });

  it('keeps allowed POI cards clear of a late drawing sidebar and its bottom toolbar', async () => {
    const container = document.createElement('div'); container.id = 'drawing-sidebar-container';
    document.body.append(container);
    const f = mount(), sidebar = document.createElement('aside'), toolbar = document.createElement('div');
    sidebar.className = 'drawing-sidebar open'; toolbar.className = 'drawing-toolbar open';
    sidebar.getBoundingClientRect = () => new DOMRect(900, 76, 300, 724);
    toolbar.getBoundingClientRect = () => new DOMRect(0, 680, 1200, 120);
    container.append(sidebar, toolbar); await tick();
    const r = bounds(f.card);
    expect(r.right).toBeLessThanOrEqual(888); expect(r.bottom).toBeLessThanOrEqual(668);
    sidebar.remove(); toolbar.remove(); await tick();
    expect(bounds(f.card).bottom).toBeGreaterThan(680);
  });

  it('keeps scroll position and stable geometry through repeated content and resize notifications', async () => {
    const f = mount(); f.card.scrollTop = 137; f.grow(); await tick();
    const initial = bounds(f.card);
    for (let i = 0; i < 8; i++) {
      resizeObservers[0].callback(); window.dispatchEvent(new Event('resize')); await tick();
      expect(bounds(f.card).toJSON()).toEqual(initial.toJSON()); expect(f.card.scrollTop).toBe(137);
    }
    // Remove the explicit inspection reads: production measures only with
    // its old cap removed and its displaced sticky header scrolled to zero.
    expect(f.measurements.filter(m => m.maxHeight === 'none').every(m => m.scrollTop === 0)).toBe(true);
  });

  it('coalesces viewport, content and window events into one pending layout', async () => {
    const f = mount(); vi.mocked(f.card.getBoundingClientRect).mockClear();
    for (let i = 0; i < 20; i++) { f.emit('viewport-change'); window.dispatchEvent(new Event('resize')); }
    f.grow(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1); await tick();
    expect(f.card.getBoundingClientRect).toHaveBeenCalledOnce();
  });

  it.each(['close', 'remove', 'retire', 'destroy'])('stops queued layout and listeners after %s', async action => {
    const f = mount(); f.emit('viewport-change');
    if (action === 'close') f.cleanup();
    else if (action === 'remove') f.card.remove();
    else if (action === 'retire') f.invalidate();
    else f.emit('before-destroy');
    vi.mocked(f.card.getBoundingClientRect).mockClear();
    await tick();
    resizeObservers[0].callback(); f.visual.dispatchEvent(new Event('resize')); f.emit('viewport-change'); window.dispatchEvent(new Event('resize'));
    await tick();
    expect(f.card.getBoundingClientRect).not.toHaveBeenCalled();
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
