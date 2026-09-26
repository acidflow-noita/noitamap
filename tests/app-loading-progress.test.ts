// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  baked: false, initialized: true,
  listeners: new Map<string, Set<() => void>>(),
  show: vi.fn(), hide: vi.fn(),
}));
vi.mock('../src/i18n', () => ({ default: {
  get isInitialized() { return state.initialized; },
  t: (key: string) => key,
  on: (event: string, callback: () => void) => {
    if (!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event)!.add(callback);
  },
  off: (event: string, callback: () => void) => state.listeners.get(event)?.delete(callback),
} }));
vi.mock('../src/dynamic_ui', () => ({ showLoadingStrip: state.show, hideLoadingStrip: state.hide }));
vi.mock('../src/spoiler-free', () => ({ isBakedSeedView: () => state.baked }));
import { installLoadingProgress } from '../src/app/loading-progress';

let frames: FrameRequestCallback[];
const controllers: ReturnType<typeof installLoadingProgress>[] = [];
const install = (map = 'dynamic-main-branch') => {
  const controller = installLoadingProgress(() => map);
  controllers.push(controller);
  return controller;
};
const event = (name: string, percentage: number) => window.dispatchEvent(new CustomEvent(name, { detail: { percentage } }));
const element = (id: string) => document.getElementById(id)!;
const bar = (name: string) => element(`loading-bar-${name}`);
const track = () => document.querySelector('.loading-strip-bar-track')!;
const frame = () => { const pending = frames.splice(0); pending.forEach(callback => callback(0)); };

beforeEach(() => {
  state.baked = false; state.initialized = true; state.listeners.clear();
  state.show.mockClear(); state.hide.mockClear(); frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  document.body.innerHTML = `
    <div class="loading-strip-bar-track">
      <div id="loading-bar-download" style="width:0%"></div>
      <div id="loading-bar-generation" style="width:0%"></div>
      <div id="loading-bar-items" style="width:0%"></div>
    </div>
    <span id="map-loading-title"></span><span id="map-loading-status"></span>`;
});
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe('map loading progress', () => {
  it.each([
    { map: 'regular-main-branch', baked: false },
    { map: 'dynamic-main-branch', baked: true },
  ])('ignores background archive downloads on $map (baked=$baked)', ({ map, baked }) => {
    state.baked = baked;
    install(map);
    event('dataZipProgress', 25); event('dataZipProgress', 100);
    expect(state.show).not.toHaveBeenCalled();
    expect(bar('download').style.width).toBe('0%');
    expect(track().classList.contains('indeterminate')).toBe(false);
    expect(element('map-loading-status').textContent).toBe('');
  });

  it('shows the download, generation, and item phases for a generated map', () => {
    install();
    event('dataZipProgress', 60);
    expect(bar('download').style.width).toBe('60%');
    expect(element('map-loading-status').textContent).toBe('20%');
    event('dataZipProgress', 100);
    expect(element('map-loading-status').textContent).toBe('33%');
    expect(track().classList.contains('indeterminate')).toBe(true);
    event('biomeGenerationProgress', 60);
    expect(bar('generation').style.width).toBe('60%');
    expect(element('map-loading-status').textContent).toBe('53%');
    expect(track().classList.contains('indeterminate')).toBe(false);
    event('biomeGenerationProgress', 100);
    expect(element('map-loading-title').textContent).toBe('loading.mapData.addingItems');
    event('itemsGenerationProgress', 30);
    expect(element('map-loading-status').textContent).toBe('76%');
    event('itemsGenerationProgress', 100);
    frame(); frame();
    expect(state.hide).toHaveBeenCalledTimes(1);
  });

  it('uses the full percentage range for baked items and resets after the completed frame paints', () => {
    state.baked = true;
    install();
    event('itemsGenerationProgress', 30);
    expect(element('map-loading-status').textContent).toBe('30%');
    expect(element('map-loading-title').textContent).toBe('loading.mapData.addingItems');
    event('itemsGenerationProgress', 100);
    expect(bar('items').style.width).toBe('100%');
    expect(element('map-loading-status').textContent).toBe('100%');
    expect(state.hide).not.toHaveBeenCalled();
    frame();
    expect(state.hide).not.toHaveBeenCalled();
    frame();
    expect(state.hide).toHaveBeenCalledTimes(1);
    for (const name of ['download', 'generation', 'items']) expect(bar(name).style.width).toBe('0%');
    event('dataZipProgress', 100);
    expect(track().classList.contains('indeterminate')).toBe(false);
  });

  it('clears an in-flight download when the baked probe resolves and accepts the next generated map', () => {
    const controller = install();
    event('biomeGenerationProgress', 60);
    event('itemsGenerationProgress', 45);
    event('dataZipProgress', 100);
    expect(track().classList.contains('indeterminate')).toBe(true);
    controller.setBaked(true);
    expect(state.hide).toHaveBeenCalledTimes(1);
    expect(track().classList.contains('indeterminate')).toBe(false);
    for (const name of ['download', 'generation', 'items']) expect(bar(name).style.width).toBe('0%');
    state.show.mockClear();
    event('dataZipProgress', 100);
    expect(state.show).not.toHaveBeenCalled();
    controller.setBaked(false);
    event('dataZipProgress', 30);
    expect(state.show).toHaveBeenCalledTimes(1);
    expect(element('map-loading-status').textContent).toBe('10%');
  });

  it('unsubscribes all window and translation listeners on disposal', () => {
    state.initialized = false;
    const controller = install();
    expect(state.listeners.get('initialized')?.size).toBe(1);
    expect(state.listeners.get('languageChanged')?.size).toBe(1);
    controller.dispose();
    for (const name of ['initialized', 'languageChanged']) expect(state.listeners.get(name)?.size).toBe(0);
    event('dataZipProgress', 100);
    event('biomeGenerationProgress', 100);
    event('itemsGenerationProgress', 100);
    frame(); frame();
    expect(state.show).not.toHaveBeenCalled();
    expect(state.hide).not.toHaveBeenCalled();
    for (const name of ['download', 'generation', 'items']) expect(bar(name).style.width).toBe('0%');
  });

  it.each([0, 1])('does not hide a replacement strip when disposed after %i completion frames', count => {
    const controller = install();
    event('itemsGenerationProgress', 100);
    for (let i = 0; i < count; i++) frame();
    controller.dispose();
    bar('items').style.width = '25%';
    frame(); frame();
    expect(state.hide).not.toHaveBeenCalled();
    expect(bar('items').style.width).toBe('25%');
  });
});
