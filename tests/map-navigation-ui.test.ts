// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';

const translations = vi.hoisted(() => ({ language: 'en', t: (key: string) => `${translations.language}:${key}` }));
vi.mock('../src/i18n', () => ({ default: translations }));
import { createMapLinks, createMapSelectorRenderer, refreshBadgePopovers, refreshMapSelectorDate, updateMapLinkTranslations } from '../src/nav';
import { getAllMapDefinitions } from '../src/data_sources/map_definitions';

class Popover {
  static instances = new Map<Element, Popover>();
  static created = 0;
  static getInstance(element: Element) { return this.instances.get(element); }
  constructor(private element: Element) { Popover.created++; Popover.instances.set(element, this); }
  dispose() { Popover.instances.delete(this.element); }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  translations.language = 'en'; Popover.instances.clear(); Popover.created = 0;
  vi.stubGlobal('bootstrap', { Popover });
  document.body.innerHTML = '<button id="selector"></button><ul id="navLinksList"></ul>';
});
afterEach(() => { document.body.replaceChildren(); Popover.instances.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('map navigation UI during camera movement', () => {
  it('retains selector badges and registrations across repeated renders of the same map', () => {
    const root = document.getElementById('selector')!, render = createMapSelectorRenderer(root);
    render('dynamic-main-branch');
    const nodes = [...root.children], registrations = Popover.created;
    for (let frame = 0; frame < 180; frame++) render('dynamic-main-branch');
    expect([...root.children]).toEqual(nodes);
    expect(Popover.created).toBe(registrations);
    expect(Popover.instances.size).toBe(registrations);
  });

  it('disposes old badges when map, language, daily date or metadata actually changes', () => {
    const root = document.getElementById('selector')!, render = createMapSelectorRenderer(root);
    const checkReplacement = (change: () => void) => {
      const old = [...root.querySelectorAll('[data-bs-toggle="popover"]')];
      change();
      expect(old.every(node => !Popover.getInstance(node))).toBe(true);
      expect(Popover.instances.size).toBe(root.querySelectorAll('[data-bs-toggle="popover"]').length);
      expect([...Popover.instances.keys()].every(node => node.isConnected)).toBe(true);
    };
    render('dynamic-main-branch');
    checkReplacement(() => { translations.language = 'ru'; render('dynamic-main-branch'); });
    checkReplacement(() => { vi.setSystemTime(new Date('2026-09-25T12:00:00Z')); render('dynamic-main-branch'); });
    const definition = getAllMapDefinitions().find(([key]) => key === 'dynamic-main-branch')![1];
    const label = definition.badges[0].label;
    try {
      checkReplacement(() => { definition.badges[0].label = `${label} changed`; render('dynamic-main-branch'); });
    } finally { definition.badges[0].label = label; }
    checkReplacement(() => render(getAllMapDefinitions().find(([key]) => key !== 'dynamic-main-branch')![0]));
  });

  it('disposes removed dropdown badges on translation and menu reconstruction', () => {
    const links = createMapLinks(); refreshBadgePopovers(links);
    const count = Popover.instances.size;
    for (const language of ['ru', 'en', 'ru']) {
      translations.language = language; updateMapLinkTranslations();
      expect(Popover.instances.size).toBe(count);
      expect([...Popover.instances.keys()].every(node => node.isConnected)).toBe(true);
    }
    createMapLinks(); expect(Popover.instances.size).toBe(0);
  });

  it('refreshes the date at UTC midnight without any camera or map event', () => {
    vi.setSystemTime(new Date('2026-09-24T23:59:59.950Z'));
    const root = document.getElementById('selector')!, render = createMapSelectorRenderer(root);
    render('dynamic-main-branch');
    const oldBadge = root.lastElementChild!;
    const refresh = vi.fn(() => render('dynamic-main-branch'));
    const dispose = refreshMapSelectorDate(refresh);
    vi.advanceTimersByTime(49);
    expect(root.lastElementChild).toBe(oldBadge);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(root.lastElementChild).not.toBe(oldBadge);
    expect(root.lastElementChild!.getAttribute('data-bs-title')).not.toBe(oldBadge.getAttribute('data-bs-title'));
    expect(Popover.getInstance(oldBadge)).toBeUndefined();
    vi.advanceTimersByTime(86400000);
    expect(refresh).toHaveBeenCalledTimes(2);
    dispose();
    vi.advanceTimersByTime(86400000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('catches up once after a suspended day and removes its visibility listener on cleanup', () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const refresh = vi.fn(), dispose = refreshMapSelectorDate(refresh);
    try {
      // Moving the clock without running timers represents a suspended page.
      vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refresh).toHaveBeenCalledOnce();
      dispose();
      vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { dispose(); visible.mockRestore(); }
  });

  it('runs the actual main state handler without rebuilding map controls for camera or seed updates', () => {
    createMapLinks();
    const source = readFileSync('src/main.ts', 'utf8');
    const start = source.indexOf('  let lastKnownMap:');
    const end = source.indexOf('\n  const loadingIndicator', start);
    // Execute this small registration from main.ts with its host dependencies,
    // avoiding the unrelated application/network boot sequence in that module.
    const script = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    let map = 'dynamic-main-branch', callback: (state: any) => void = () => {};
    const url = vi.fn(), search = vi.fn(), toolbar = vi.fn(), selector = vi.fn(), clear = vi.fn();
    const runPriority = vi.fn(async () => {});
    new Function('app', 'debouncedUpdateURL', 'debouncedViewportNotify', 'updateDynamicUIVisibility',
      'updateMapSelectorText', 'clearDynamicMap', 'unifiedSearch', 'pendingDynamicSeed', 'dynamicOpts',
      'runDynamicMap', 'runDynamicMapWithPriority', script)(
      { getMap: () => map, on: (_name: string, fn: typeof callback) => { callback = fn; }, osd: {} },
      url, search, toolbar, selector, clear, { setDynamicPOIs: vi.fn(), setIndexingState: vi.fn() }, null, {}, vi.fn(), runPriority);
    for (let frame = 0; frame < 180; frame++) callback({ map, pos: { x: frame, y: 0, zoom: 0.001 }, seed: frame < 90 ? 1 : 2 });
    expect(url).toHaveBeenCalledTimes(180); expect(search).toHaveBeenCalledTimes(180);
    expect(toolbar).toHaveBeenCalledExactlyOnceWith(map); expect(selector).toHaveBeenCalledExactlyOnceWith(map);
    expect(clear).not.toHaveBeenCalled();
    map = getAllMapDefinitions().find(([key]) => key !== 'dynamic-main-branch')![0];
    callback({ map, pos: { x: 0, y: 0, zoom: 1 } });
    expect(clear).toHaveBeenCalledOnce(); expect(toolbar).toHaveBeenCalledTimes(2); expect(selector).toHaveBeenLastCalledWith(map);
    map = 'dynamic-main-branch';
    callback({ map }); callback({ map, pos: { x: 1, y: 0, zoom: 1 } });
    expect(runPriority).toHaveBeenCalledOnce(); expect(toolbar).toHaveBeenCalledTimes(3);
  });
});
