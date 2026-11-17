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
it('clears fitting for a hidden review and restores it without rebuilding the grid', async () => {
  await tick(); const grid = document.querySelector<HTMLElement>('.stream-viewer-layout')!, clue = grid.querySelector<HTMLElement>('.stream-viewer-clue')!;
  clue.hidden = true; await tick(); expect(grid.dataset.roundFrame).toBeUndefined();
  clue.hidden = false; await tick(); expect(grid.dataset.roundFrame).toBe('split');
});
