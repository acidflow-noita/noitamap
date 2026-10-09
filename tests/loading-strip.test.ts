// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindLoadingProgress } from './helpers/loading-progress';

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/dynamic-map', () => ({ getCurrentDynamicSeed: vi.fn(), getCompletedDynamicSeed: vi.fn(), runDynamicMap: vi.fn() }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));
vi.mock('../src/overflow-menu', () => ({ updateOverflowMenu: vi.fn() }));

let ui: typeof import('../src/dynamic_ui');
let progress: ReturnType<typeof bindLoadingProgress>;
let frames: FrameRequestCallback[];
const markup = `<div id="map-loading-strip">
  <div id="loading-bar-download"></div><div id="loading-bar-generation"></div><div id="loading-bar-items"></div>
  <span id="map-loading-title"></span><span id="map-loading-status"></span></div>`;
const element = (id: string) => document.getElementById(id)!;
const strip = () => element('map-loading-strip');
const width = (phase: string) => element(`loading-bar-${phase}`).style.width;
const frame = () => { for (const callback of frames.splice(0)) callback(performance.now()); };

const itemsProgress = (percentage: number) => progress.update('items', percentage);

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); frames = [];
  document.body.innerHTML = markup;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  ui = await import('../src/dynamic_ui');
  progress = bindLoadingProgress(ui); progress.start(); progress.setBaked(true);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps new progress visible after a previous load started fading', () => {
  ui.showLoadingStrip(); ui.hideLoadingStrip();
  vi.advanceTimersByTime(200);
  ui.showLoadingStrip(); element('loading-bar-generation').style.width = '48%';
  vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true);
  expect(strip().classList.contains('fade-out')).toBe(false);
  expect(width('generation')).toBe('48%');
});

it('does not shorten a newer fade with an older cleanup callback', () => {
  ui.showLoadingStrip(); ui.hideLoadingStrip();
  vi.advanceTimersByTime(200);
  ui.showLoadingStrip(); ui.hideLoadingStrip();
  vi.advanceTimersByTime(200);
  expect(strip().classList.contains('visible')).toBe(true);
  expect(strip().classList.contains('fade-out')).toBe(true);
  vi.advanceTimersByTime(200);
  expect(strip().classList.contains('visible')).toBe(false);
});

it('keeps repeated hide calls from leaving a timer that can hide the following load', () => {
  ui.showLoadingStrip(); ui.hideLoadingStrip();
  vi.advanceTimersByTime(100); ui.hideLoadingStrip();
  vi.advanceTimersByTime(300);
  expect(strip().classList.contains('visible')).toBe(false);
  ui.showLoadingStrip();
  vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true);
});

it.each([0, 1])('does not let the old items completion reset progress restarted after %s animation frames', elapsedFrames => {
  itemsProgress(100);
  if (elapsedFrames) frame();
  ui.showLoadingStrip();
  element('loading-bar-generation').style.width = '63%';
  element('loading-bar-items').style.width = '18%';
  frame(); frame(); vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true);
  expect(strip().classList.contains('fade-out')).toBe(false);
  expect(width('generation')).toBe('63%');
  expect(width('items')).toBe('18%');
});

it('completes current progress after the same two frames and fade', () => {
  itemsProgress(100);
  expect(width('items')).toBe('100%');
  frame();
  expect(width('items')).toBe('100%');
  expect(strip().classList.contains('fade-out')).toBe(false);
  frame();
  expect(strip().classList.contains('fade-out')).toBe(true);
  for (const phase of ['download', 'generation', 'items']) expect(width(phase)).toBe('0%');
  vi.advanceTimersByTime(399); expect(strip().classList.contains('visible')).toBe(true);
  vi.advanceTimersByTime(1); expect(strip().classList.contains('visible')).toBe(false);
});

it('lets later item progress supersede a queued completion', () => {
  itemsProgress(100); frame(); progress.start(); progress.setBaked(true); itemsProgress(50); frame();
  vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true);
  expect(width('items')).toBe('50%');
  itemsProgress(100); frame(); frame(); vi.advanceTimersByTime(400);
  expect(strip().classList.contains('visible')).toBe(false);
});

it('does not reset a replacement strip element from an old completion', () => {
  itemsProgress(100); frame();
  document.body.innerHTML = markup;
  strip().classList.add('visible');
  element('loading-bar-generation').style.width = '52%';
  frame(); vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true);
  expect(width('generation')).toBe('52%');
});
