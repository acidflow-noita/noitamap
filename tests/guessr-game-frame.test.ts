// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fitGameFrame } from '../src/guessr/game-frame';

let callback: ResizeObserverCallback, observed: Set<Element>, dispose = () => {};
let width = 1232, scroll = 0;
beforeEach(() => {
  vi.useFakeTimers(); width = 1232; scroll = 0; observed = new Set();
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900); vi.stubGlobal('scrollY', 0);
  vi.stubGlobal('ResizeObserver', class {
    constructor(fn: ResizeObserverCallback) { callback = fn; }
    observe(node: Element) { observed.add(node); }
    unobserve(node: Element) { observed.delete(node); }
    disconnect() { observed.clear(); }
  });
  document.body.innerHTML = `<main style="padding:16px"><div class="stream-viewer-layout">
    <section class="game-panel stream-viewer-clue"><div class="panel-bar"></div><div class="clue-controls"></div><div class="clue-stage"></div></section>
    <section class="game-panel stream-picker"><div class="map-toolbar"></div><div class="map-board"></div></section>
  </div></main>`;
  const main = document.querySelector('main')!, grid = main.firstElementChild as HTMLElement;
  Object.defineProperty(main, 'clientWidth', { get: () => width });
  // Model the old horizontal-flex bug: fitted content had a narrower intrinsic
  // width. A correct fit must not use that output as the next sizing input.
  Object.defineProperty(grid, 'clientWidth', { get: () => grid.dataset.roundFrame ? 800 : width - 32 });
  for (const node of document.querySelectorAll<HTMLElement>('.game-panel,.clue-stage,.map-board')) {
    const top = node.classList.contains('clue-stage') ? 200 : node.classList.contains('map-board') ? 160 : 100;
    node.getBoundingClientRect = () => new DOMRect(0, top - scroll, 0, 0);
  }
  dispose = fitGameFrame(grid);
});
afterEach(() => { dispose(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const tick = () => vi.advanceTimersByTimeAsync(32);
function resizeParent(height: number) {
  const size = { inlineSize: width, blockSize: height };
  callback([{ target: document.querySelector('main')!, contentRect: new DOMRectReadOnly(0, 0, width, height),
    borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
  }], { observe() {}, unobserve() {}, disconnect() {} });
}
it('does not alternate layouts when its own fitted size changes', async () => {
  await tick(); const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!;
  expect(grid.dataset.roundFrame).toBe('split'); expect(grid.style.getPropertyValue('--round-clue-width')).toBe('752px');
  const style = grid.getAttribute('style');
  for (let i = 0; i < 12; i++) { resizeParent(600 + i * 20); await tick(); expect(grid.dataset.roundFrame).toBe('split'); }
  expect(grid.getAttribute('style')).toBe(style);
  expect(observed.has(grid)).toBe(false); expect(observed.has(document.querySelector('main')!)).toBe(true);
});
it('does not enlarge the clue because the page was scrolled', async () => {
  width = 2032; await tick(); const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!;
  const before = grid.style.getPropertyValue('--round-clue-width');
  scroll = 240; vi.stubGlobal('scrollY', scroll); window.dispatchEvent(new Event('resize')); await tick();
  expect(grid.style.getPropertyValue('--round-clue-width')).toBe(before);
});
it('keeps the fitted panels in place when a countdown covers the clue and then ends', async () => {
  width = 1904;
  await tick();
  const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!;
  const before = grid.getAttribute('style');
  const countdown = document.createElement('div');
  countdown.style.position = 'absolute';
  countdown.getBoundingClientRect = () => new DOMRect(0, 100, 900, 600);
  grid.querySelector('.stream-viewer-clue')!.append(countdown);
  await tick();
  expect(grid.getAttribute('style')).toBe(before);
  countdown.remove(); await tick();
  expect(grid.getAttribute('style')).toBe(before);
});
it('settles before paint when fitting the clue wraps its controls at an intermediate width', async () => {
  vi.stubGlobal('innerHeight', 582);
  const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!;
  const stage = grid.querySelector<HTMLElement>('.clue-stage')!, controls = grid.querySelector<HTMLElement>('.clue-controls')!;
  stage.after(controls);
  const widthOfClue = () => parseFloat(grid.style.getPropertyValue('--round-clue-width'));
  controls.getBoundingClientRect = () => new DOMRect(0, 0, widthOfClue(), widthOfClue() > 512 && widthOfClue() < 650 ? 158 : 104);
  await tick();
  const fitted = widthOfClue();
  expect(fitted / 2.25 + controls.getBoundingClientRect().height + 200 + 16).toBeLessThanOrEqual(582);
  for (let i = 0; i < 5; i++) {
    window.dispatchEvent(new Event('resize')); await tick();
    expect(widthOfClue()).toBe(fitted);
  }
  vi.stubGlobal('innerHeight', 900); window.dispatchEvent(new Event('resize')); await tick();
  expect(widthOfClue()).toBeGreaterThan(fitted);
});
it('clears fitting for a hidden review and restores it without rebuilding the grid', async () => {
  await tick(); const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!, clue = grid.querySelector<HTMLElement>('.stream-viewer-clue')!;
  clue.hidden = true; await tick(); expect(grid.dataset.roundFrame).toBeUndefined();
  clue.hidden = false; await tick(); expect(grid.dataset.roundFrame).toBe('split');
});

it('keeps a usable map on a short phone and does not grow it when the page scrolls', async () => {
  width = 360; vi.stubGlobal('innerWidth', 360); vi.stubGlobal('innerHeight', 690);
  const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!;
  const map = grid.querySelector<HTMLElement>('.map-board')!;
  map.getBoundingClientRect = () => new DOMRect(0, 420 - scroll, 360, 240);
  await tick();
  expect(grid.style.getPropertyValue('--round-map-height')).toBe('254px');
  scroll = 120; vi.stubGlobal('scrollY', scroll); window.dispatchEvent(new Event('resize')); await tick();
  expect(grid.style.getPropertyValue('--round-map-height')).toBe('254px');
  vi.stubGlobal('innerHeight', 520); window.dispatchEvent(new Event('resize')); await tick();
  expect(grid.style.getPropertyValue('--round-map-height')).toBe('192px');
});
