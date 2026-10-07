// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindLoadingProgress } from './helpers/loading-progress';

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/dynamic-map', () => ({ getCurrentDynamicSeed: vi.fn(), getCompletedDynamicSeed: vi.fn(), runDynamicMap: vi.fn() }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));
vi.mock('../src/overflow-menu', () => ({ updateOverflowMenu: vi.fn() }));

let progress: ReturnType<typeof bindLoadingProgress>, frames: FrameRequestCallback[];
const element = (id: string) => document.getElementById(id)!;
const strip = () => element('map-loading-strip');
const widths = () => ['download', 'generation', 'items'].map(p => parseFloat(element(`loading-bar-${p}`).style.width));
const status = () => element('map-loading-status').textContent;
const title = () => element('map-loading-title').textContent;
const frame = () => { for (const callback of frames.splice(0)) callback(performance.now()); };
const complete = () => { frame(); frame(); vi.advanceTimersByTime(400); };

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  document.body.innerHTML = `<div id="map-loading-strip"><div class="loading-strip-bar-track">
    <div id="loading-bar-download" style="width:0%"></div><div id="loading-bar-generation" style="width:0%"></div>
    <div id="loading-bar-items" style="width:0%"></div></div><span id="map-loading-title"></span><span id="map-loading-status"></span></div>`;
  progress = bindLoadingProgress(await import('../src/dynamic_ui'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('does not claim biome generation or a completed download before the map route is known', () => {
  progress.start(); progress.show();
  expect(title()).toBe('loading.maps'); expect(status()).toBe(''); expect(widths()).toEqual([0, 0, 0]);
  expect(strip().classList.contains('visible')).toBe(true);
});

it('keeps earlier live phases filled and weights each segment consistently with the displayed percentage', () => {
  progress.start(); progress.setBaked(false);
  progress.update('download', 30);
  expect(widths()).toEqual([10, 0, 0]); expect(status()).toBe('10%');
  progress.update('download', 100); progress.update('generation', 30);
  expect(widths()[0]).toBeCloseTo(100 / 3); expect(widths()[1]).toBe(10); expect(status()).toBe('43%');
  progress.update('generation', 100);
  expect(title()).toBe('loading.mapData.generating'); expect(status()).toBe('67%');
  progress.update('items', 50);
  expect(title()).toBe('loading.mapData.addingItems'); expect(status()).toBe('83%');
  expect(widths()[0]).toBeCloseTo(100 / 3); expect(widths()[1]).toBeCloseTo(100 / 3);
  expect(widths()[2]).toBeCloseTo(50 / 3);
  progress.update('items', 100);
  expect(status()).toBe('100%'); expect(widths().reduce((a, b) => a + b, 0)).toBeCloseTo(100);
});

it('shows baked metadata preparation over the whole strip, without generation phases', () => {
  progress.start(); progress.setBaked(true);
  progress.update('items', 0); expect(status()).toBe('0%'); expect(widths()).toEqual([0, 0, 0]);
  progress.update('items', 50); expect(status()).toBe('50%'); expect(widths()).toEqual([0, 0, 50]);
  progress.update('download', 100); progress.update('generation', 100);
  expect(status()).toBe('50%'); expect(widths()).toEqual([0, 0, 50]);
  progress.update('items', 100); expect(status()).toBe('100%'); expect(widths()).toEqual([0, 0, 100]);
  complete(); expect(strip().classList.contains('visible')).toBe(false);
});

it('resets baked progress weighting when the following seed is live', () => {
  progress.start(); progress.setBaked(true); progress.update('items', 50);
  progress.start(); progress.setBaked(false); progress.update('generation', 60);
  expect(title()).toBe('loading.mapData.generating'); expect(status()).toBe('53%');
  expect(widths()[0]).toBeCloseTo(100 / 3); expect(widths().slice(1)).toEqual([20, 0]);
});

it.each(['download', 'generation', 'items'] as const)('ignores %s events when no map request owns the strip', phase => {
  progress.update(phase, 50);
  expect(strip().classList.contains('visible')).toBe(false); expect(widths()).toEqual([0, 0, 0]);
});

it.each(['download', 'generation', 'items'] as const)('ignores %s events on a static map', phase => {
  progress.start(); progress.setMap('regular-main-branch'); progress.update(phase, 50);
  expect(strip().classList.contains('visible')).toBe(false);
});

it('keeps late asset and terrain notifications from replacing marker progress', () => {
  progress.start(); progress.setBaked(false); progress.update('items', 50);
  const before = widths();
  progress.update('download', 100); progress.update('generation', 70);
  expect(widths()).toEqual(before); expect(status()).toBe('83%');
  expect(title()).toBe('loading.mapData.addingItems');
});

it('keeps a phase monotonic and rejects non-finite progress', () => {
  progress.start(); progress.setBaked(false); progress.update('generation', 80);
  const before = widths();
  for (const value of [20, -5, NaN, Infinity, undefined, '50']) progress.update('generation', value);
  expect(widths()).toEqual(before); expect(status()).toBe('60%');
});

it('clamps valid numeric progress to the phase bounds', () => {
  progress.start(); progress.setBaked(true); progress.update('items', -20);
  expect(status()).toBe('0%'); expect(widths()).toEqual([0, 0, 0]);
  progress.update('items', 125);
  expect(status()).toBe('100%'); expect(widths()).toEqual([0, 0, 100]);
});

it.each([false, true])('reserves 100% for completed marker preparation (baked: %s)', baked => {
  progress.start(); progress.setBaked(baked); progress.update('items', 99.9);
  expect(status()).toBe('99%');
  progress.update('items', 100); expect(status()).toBe('100%');
});

it('accepts the current OSD marker completion after the pipeline has returned', () => {
  progress.start(); progress.setBaked(false); progress.update('items', 50); progress.settle();
  progress.update('download', 100); expect(status()).toBe('83%');
  progress.update('items', 100); expect(status()).toBe('100%');
  complete(); expect(strip().classList.contains('visible')).toBe(false);
});

it('does not reopen a finished live map for later asset, terrain or duplicate marker events', () => {
  progress.start(); progress.setBaked(false); progress.update('items', 100); progress.settle(); complete();
  for (const phase of ['download', 'generation', 'items'] as const) progress.update(phase, 100);
  expect(strip().classList.contains('visible')).toBe(false); expect(widths()).toEqual([0, 0, 0]);
});

it('ends an unsuccessful request before marker preparation without accepting later background progress', () => {
  progress.start(); progress.show(); progress.update('download', 100); progress.settle();
  vi.advanceTimersByTime(400); progress.update('generation', 100); progress.update('items', 50);
  expect(strip().classList.contains('visible')).toBe(false);
});

it('does not accept pending marker completion after cancellation', () => {
  progress.start(); progress.update('items', 50); progress.cancel();
  vi.advanceTimersByTime(400); progress.update('items', 100);
  expect(strip().classList.contains('visible')).toBe(false);
});

it('keeps a new request visible when an older completed phase still has queued frames', () => {
  progress.start(); progress.setBaked(true); progress.update('items', 100); frame();
  progress.start(); progress.setBaked(false); progress.update('generation', 60);
  frame(); frame(); vi.advanceTimersByTime(1000);
  expect(strip().classList.contains('visible')).toBe(true); expect(status()).toBe('53%');
});
