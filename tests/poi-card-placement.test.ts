// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availablePOICardRect, mountPOICardPlacement, planPOICardPlacement, type CardRect } from '../src/telescope/poi-card-placement';

const rect = (left: number, top: number, right: number, bottom: number): CardRect => ({ left, top, right, bottom });
const overlaps = (a: CardRect, b: CardRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const marker = (x: number, y: number) => rect(x - 18, y - 18, x + 18, y + 18);

it('uses the visible map intersection and the report exclusion for offset canvases and mobile keyboards', () => {
  expect(availablePOICardRect(rect(50, 80, 1250, 880), rect(0, 0, 1300, 700), rect(850, 100, 1250, 850)))
    .toEqual(rect(50, 80, 850, 700));
  expect(availablePOICardRect(rect(0, 0, 390, 844), rect(0, 60, 390, 540), rect(0, 400, 390, 844)))
    .toEqual(rect(0, 60, 390, 400));
});

it('keeps measured cards clear of the selected marker at every corner and against a sidebar', () => {
  const available = rect(60, 50, 800, 750);
  for (const [x, y] of [[90, 90], [760, 90], [90, 700], [760, 700], [430, 390]]) {
    const selected = marker(x, y);
    const p = planPOICardPlacement({ available, marker: selected, cardWidth: 420, cardHeight: 570, compact: false, allowPan: true });
    const card = rect(p.left, p.top, p.left + p.width, p.top + Math.min(570, p.maxHeight));
    const moved = { left: selected.left + p.markerShift.x, right: selected.right + p.markerShift.x, top: selected.top + p.markerShift.y, bottom: selected.bottom + p.markerShift.y };
    expect(overlaps(card, moved), `${x},${y}`).toBe(false);
    expect(card.left).toBeGreaterThanOrEqual(72);
    expect(card.right).toBeLessThanOrEqual(788);
    expect(card.top).toBeGreaterThanOrEqual(62);
    expect(card.bottom).toBeLessThanOrEqual(738);
  }
});

it('reserves sheet growth on the first opening and shifts a covered marker only into the free map area', () => {
  const p = planPOICardPlacement({ available: rect(0, 0, 390, 844), marker: marker(330, 750), cardWidth: 448, cardHeight: 1200, compact: true, allowPan: true });
  expect(p.sheet).toBe(true);
  expect(p.markerShift.x).toBe(0);
  expect(750 + 18 + p.markerShift.y).toBeCloseTo(p.top - 12);
  expect(p.maxHeight).toBeLessThan(422);
  const short = planPOICardPlacement({ available: rect(0, 0, 390, 844), marker: marker(330, 750), cardWidth: 448, cardHeight: 120, compact: true, allowPan: true });
  expect(short.markerShift).toEqual(p.markerShift);
});

it('scrolls a tall card above the marker instead of hiding it or moving the camera during relayout', () => {
  const p = planPOICardPlacement({ available: rect(0, 0, 800, 700), marker: marker(400, 480), cardWidth: 448, cardHeight: 1800, compact: false, allowPan: false });
  expect(p.markerShift).toEqual({ x: 0, y: 0 });
  expect(p.top + p.maxHeight).toBeLessThanOrEqual(462 - 12);
});

it('moves a side card up to fit its full fractional natural height near the bottom edge', () => {
  const selected = marker(120, 750), naturalHeight = 480.625;
  const p = planPOICardPlacement({ available: rect(0, 0, 1200, 844), marker: selected, cardWidth: 448, cardHeight: naturalHeight, compact: false, allowPan: false });
  expect(p.sheet).toBe(false);
  expect(p.maxHeight).toBeGreaterThanOrEqual(naturalHeight);
  expect(p.top + naturalHeight).toBe(832);
  expect(overlaps(rect(p.left, p.top, p.left + p.width, p.top + naturalHeight), selected)).toBe(false);
  expect(p.markerShift).toEqual({ x: 0, y: 0 });
});

it.each([true, false])('fits a slightly taller sheet in existing marker-free space without a tiny scrollbar (initial=%s)', allowPan => {
  const naturalHeight = 400.375;
  const p = planPOICardPlacement({ available: rect(0, 0, 390, 844), marker: marker(190, 320), cardWidth: 366, cardHeight: naturalHeight, compact: true, allowPan });
  expect(p.maxHeight).toBe(naturalHeight);
  expect(p.top).toBe(832 - naturalHeight);
  expect(p.markerShift).toEqual({ x: 0, y: 0 });
});

it('keeps real overflow scrollable when a full sheet would cover the marker or substantially exceed its cap', () => {
  for (const [naturalHeight, y] of [[400.375, 404], [430, 320]]) {
    const p = planPOICardPlacement({ available: rect(0, 0, 390, 844), marker: marker(190, y), cardWidth: 366, cardHeight: naturalHeight, compact: true, allowPan: false });
    expect(p.maxHeight).toBeLessThan(naturalHeight);
    expect(p.maxHeight).toBeLessThanOrEqual(820 * .48);
    expect(p.top).toBeGreaterThanOrEqual(y + 18 + 12);
    expect(p.markerShift).toEqual({ x: 0, y: 0 });
  }
});

it('fits the whole short-overflow sheet above a marker when a resized viewport leaves no room below it', () => {
  const p = planPOICardPlacement({ available: rect(0, 0, 390, 430), marker: marker(190, 385), cardWidth: 366, cardHeight: 200.375, compact: true, allowPan: false });
  expect(p.top).toBe(12);
  expect(p.maxHeight).toBe(200.375);
  expect(p.markerShift).toEqual({ x: 0, y: 0 });
});

describe('mounted card placement lifecycle', () => {
  afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  function mount(flipped = false, rotation = false) {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
    const canvas = document.createElement('div'), card = document.createElement('div');
    document.body.append(canvas, card);
    canvas.getBoundingClientRect = () => ({ ...rect(0, 0, 390, 844), width: 390, height: 844 } as DOMRect);
    Object.defineProperty(canvas, 'clientWidth', { value: 390 });
    Object.defineProperty(canvas, 'clientHeight', { value: 844 });
    let contentHeight = 600;
    card.getBoundingClientRect = () => ({ ...rect(0, 0, 366, contentHeight), width: 366, height: contentHeight } as DOMRect);
    Object.defineProperty(card, 'scrollHeight', { configurable: true, get: () => contentHeight });
    let center = { x: 195, y: 422 };
    const matrix = rotation ? { a: 0, b: 2, c: -2, d: 0 } : { a: 2, b: 0, c: 0, d: 2 };
    const viewport = {
      getFlip: () => flipped,
      pixelFromPoint: ({ x, y }: { x: number; y: number }) => ({
        x: 195 + matrix.a * (x - center.x) + matrix.c * (y - center.y),
        y: 422 + matrix.b * (x - center.x) + matrix.d * (y - center.y),
      }),
      getCenter: () => center,
      panTo: vi.fn((next: { x: number; y: number }) => { center = next; }),
    };
    const viewer = { canvas, viewport, addHandler: vi.fn(), removeHandler: vi.fn() };
    const anchor = rotation ? { x: 359, y: 422 } : { x: 195, y: 586 };
    let current = true;
    const opening = { mayPan: true };
    const cleanup = mountPOICardPlacement(card, { viewer, anchor, opening, isCurrent: () => current });
    return { card, viewport, viewer, cleanup, opening, anchor, grow: () => { contentHeight = 1800; card.append(document.createElement('p')); }, invalidate: () => { current = false; } };
  }

  it.each([[false, false], [true, false], [false, true], [true, true]])('uses the rendered camera transform (flip=%s, rotation=%s), never zooming', (flip, rotation) => {
    const m = mount(flip, rotation);
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(m.card.classList.contains('poi-card-sheet')).toBe(true);
    expect(m.opening.mayPan).toBe(false);
    const projected = m.viewport.pixelFromPoint(rotation ? { x: 359, y: 422 } : { x: 195, y: 586 });
    expect(projected.y + (rotation ? 20 : 24)).toBeLessThanOrEqual(Number.parseFloat(m.card.style.top) - 11);
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    m.cleanup();
  });

  it('does not pan again for late details, hover, translation rebuild, resize, or stale callbacks', async () => {
    const m = mount();
    m.grow(); await Promise.resolve(); vi.runOnlyPendingTimers();
    m.card.dispatchEvent(new MouseEvent('mouseenter'));
    m.cleanup();
    // A translated/variant rebuild reuses the opening token.
    const rebuiltCleanup = mountPOICardPlacement(m.card, { viewer: m.viewer, anchor: m.anchor, opening: m.opening, isCurrent: () => true });
    window.dispatchEvent(new Event('resize')); vi.runOnlyPendingTimers();
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    m.invalidate(); window.dispatchEvent(new Event('resize')); vi.runOnlyPendingTimers();
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    rebuiltCleanup();
    expect(m.viewer.removeHandler).toHaveBeenCalledTimes(4);
    window.dispatchEvent(new Event('resize'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures desktop sheet fallback at its final width and settles after resize delivery', () => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 1400); vi.stubGlobal('innerHeight', 240);
    vi.stubGlobal('OpenSeadragon', { Point: class { constructor(public x: number, public y: number) {} } });
    let notifyResize: () => void = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {} disconnect() {}
    });
    const canvas = document.createElement('div'), card = document.createElement('div'), report = document.createElement('div');
    report.id = 'seed-report-v3'; report.className = 'open';
    document.body.append(canvas, card, report);
    canvas.getBoundingClientRect = () => ({ ...rect(0, 0, 1400, 240), width: 1400, height: 240 } as DOMRect);
    report.getBoundingClientRect = () => ({ ...rect(600, 0, 1400, 240), width: 800, height: 240 } as DOMRect);
    const measurements: { width: number; maxHeight: string; scrollTop: number }[] = [];
    // A long wrapped row is 180px tall at the desktop width, 60px when the
    // fallback sheet uses the whole map width. Include CSS max-height behavior
    // so a stale constraint cannot pass as a natural content measurement.
    const size = () => {
      const width = Number.parseFloat(card.style.width) || 448;
      const naturalHeight = width >= 576 ? 60 : 180;
      const height = Math.min(naturalHeight, Number.parseFloat(card.style.maxHeight) || Infinity);
      return { width, height };
    };
    card.getBoundingClientRect = () => {
      measurements.push({ width: size().width, maxHeight: card.style.maxHeight, scrollTop: card.scrollTop });
      const { width, height } = size();
      return { ...rect(0, 0, width, height), width, height } as DOMRect;
    };
    Object.defineProperty(card, 'scrollHeight', { get: () => (size().width >= 576 ? 58 : 178) });
    const viewport = { getFlip: () => false, pixelFromPoint: (p: { x: number; y: number }) => p, getCenter: () => ({ x: 700, y: 120 }), panTo: vi.fn() };
    const cleanup = mountPOICardPlacement(card, { viewer: { canvas, viewport }, anchor: { x: 300, y: 120 }, opening: { mayPan: false }, isCurrent: () => true });
    const expected = { top: card.style.top, width: card.style.width, height: size().height };
    expect(expected).toEqual({ top: '168px', width: '576px', height: 60 });
    for (let i = 0; i < 8; i++) {
      notifyResize(); vi.runOnlyPendingTimers();
      expect({ top: card.style.top, width: card.style.width, height: size().height }).toEqual(expected);
    }
    expect(measurements.every(m => m.maxHeight === 'none' && m.scrollTop === 0)).toBe(true);
    expect(viewport.panTo).not.toHaveBeenCalled();
    cleanup();
  });

  it('uses fractional natural height without scroll overflow and preserves a scrolled creature card', () => {
    const m = mount();
    m.cleanup();
    const measurements: number[] = [];
    m.card.scrollTop = 137;
    m.card.getBoundingClientRect = () => {
      measurements.push(m.card.scrollTop);
      const height = Math.min(1400.375, Number.parseFloat(m.card.style.maxHeight) || Infinity);
      return { ...rect(0, 0, 366, height), width: 366, height } as DOMRect;
    };
    // scrollHeight is rounded and may include sticky overflow. The card's
    // unconstrained border box, rather than that live scroll area, drives layout.
    const scrollHeight = vi.spyOn(m.card, 'scrollHeight', 'get');
    const cleanup = mountPOICardPlacement(m.card, { viewer: m.viewer, anchor: m.anchor, opening: m.opening, isCurrent: () => true });
    const top = m.card.style.top;
    for (let i = 0; i < 8; i++) {
      window.dispatchEvent(new Event('resize')); vi.runOnlyPendingTimers();
      expect(m.card.style.top).toBe(top);
      expect(m.card.scrollTop).toBe(137);
    }
    expect(measurements.every(scrollTop => scrollTop === 0)).toBe(true);
    expect(scrollHeight).not.toHaveBeenCalled();
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    cleanup();
  });

  it('keeps the whole near-cap sheet visible and stable across repeated content and resize delivery', async () => {
    const m = mount();
    m.cleanup();
    const naturalHeight = 400.375;
    m.card.getBoundingClientRect = () => {
      const height = Math.min(naturalHeight, Number.parseFloat(m.card.style.maxHeight) || Infinity);
      return { ...rect(0, 0, 366, height), width: 366, height } as DOMRect;
    };
    const cleanup = mountPOICardPlacement(m.card, {
      viewer: m.viewer, anchor: { ...m.anchor, y: m.anchor.y - 100 },
      opening: m.opening, isCurrent: () => true,
    });
    const expected = { top: '431.625px', maxHeight: '400.375px' };
    for (let i = 0; i < 8; i++) {
      m.card.append(document.createTextNode('details'));
      await Promise.resolve();
      window.dispatchEvent(new Event('resize')); vi.runOnlyPendingTimers();
      expect({ top: m.card.style.top, maxHeight: m.card.style.maxHeight }).toEqual(expected);
      expect(m.card.getBoundingClientRect().height).toBe(naturalHeight);
    }
    expect(m.viewport.panTo).toHaveBeenCalledOnce();
    cleanup();
  });
});

it('moves the compact card above the marker after a viewport resize instead of panning again or collapsing controls', () => {
  const p = planPOICardPlacement({ available: rect(0, 0, 390, 430), marker: marker(190, 385), cardWidth: 366, cardHeight: 1500, compact: true, allowPan: false });
  expect(p.markerShift).toEqual({ x: 0, y: 0 });
  expect(p.maxHeight).toBeGreaterThan(112);
  expect(p.top + p.maxHeight).toBeLessThan(367);
});
