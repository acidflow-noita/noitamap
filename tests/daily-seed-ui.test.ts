// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dynamicMap = vi.hoisted(() => ({
  seed: null as number | null,
  getCurrentSeed: vi.fn<() => number | null>(),
  run: vi.fn(),
}));
vi.mock('i18next', () => ({ default: { t: (key: string) => key, on: vi.fn() } }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/dynamic-map', () => ({ getCurrentDynamicSeed: dynamicMap.getCurrentSeed,
  getCompletedDynamicSeed: dynamicMap.getCurrentSeed, runDynamicMap: dynamicMap.run }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));
vi.mock('../src/overflow-menu', () => ({ updateOverflowMenu: vi.fn() }));

class Popover {
  static instances = new Map<Element, Popover>();
  static getInstance(element: Element) { return this.instances.get(element) ?? null; }
  constructor(element: Element) { Popover.instances.set(element, this); }
}

const TODAY = 239365546;
const PREVIOUS = 1318860803;

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve: (seed: number) => resolve(new Response(String(seed))) };
}

async function createToolbar(viewer: any = {}) {
  const daily = await import('../src/data_sources/daily_seed');
  const ui = await import('../src/dynamic_ui');
  ui.createDynamicUI({ viewer, onSeedResolved: (seed, daily) => ui.setDynamicUISeed(seed, daily, true) });
  const input = document.getElementById('dynamicSeedInput') as HTMLInputElement;
  return { ...daily, ...ui, input };
}

function expectKind(input: HTMLInputElement, kind: 'today' | 'previous' | null) {
  expect(input.classList.contains('seed-daily')).toBe(kind === 'today');
  expect(input.classList.contains('seed-prev-daily')).toBe(kind === 'previous');
}

describe('seed colours follow asynchronously published daily identity', () => {
  beforeEach(() => {
    vi.resetModules();
    dynamicMap.seed = null;
    dynamicMap.getCurrentSeed.mockReset().mockImplementation(() => dynamicMap.seed);
    dynamicMap.run.mockReset();
    Popover.instances.clear();
    vi.stubGlobal('bootstrap', { Popover });
    document.body.innerHTML = '<div class="collapse navbar-collapse"><div class="d-flex flex-wrap"></div></div>';
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('colours the pinned daily when its lookup finishes after the input was populated', async () => {
    const response = pendingResponse(), fetcher = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetcher);
    const { input, setDynamicUISeed, fetchDailySeed } = await createToolbar();
    const pending = fetchDailySeed();
    setDynamicUISeed(TODAY, true);
    expectKind(input, null);
    response.resolve(TODAY);
    await pending;
    expect(input.value).toBe(String(TODAY));
    expectKind(input, 'today');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('colours a previous-daily link after the later previous pointer arrives', async () => {
    const response = pendingResponse();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('previous')
      ? response.promise : Promise.resolve(new Response(String(TODAY)))));
    const { input, setDynamicUISeed, fetchDailySeed, fetchPreviousDailySeed } = await createToolbar();
    setDynamicUISeed(PREVIOUS, true);
    await fetchDailySeed();
    expectKind(input, null);
    const pending = fetchPreviousDailySeed();
    response.resolve(PREVIOUS);
    await pending;
    expect(input.value).toBe(String(PREVIOUS));
    expectKind(input, 'previous');
  });

  it.each([42, TODAY])('does not overwrite or recolour a manually edited input (%s)', async edited => {
    const response = pendingResponse();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const { input, setDynamicUISeed, fetchDailySeed } = await createToolbar();
    setDynamicUISeed(TODAY, true);
    const pending = fetchDailySeed();
    input.value = String(edited);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    response.resolve(TODAY);
    await pending;
    expect(input.value).toBe(String(edited));
    expectKind(input, null);
  });

  it('does not restore the previous selection when its lookup finishes after reseeding', async () => {
    const response = pendingResponse();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const { input, setDynamicUISeed, fetchDailySeed } = await createToolbar();
    setDynamicUISeed(TODAY, true);
    const pending = fetchDailySeed();
    setDynamicUISeed(42, false);
    response.resolve(TODAY);
    await pending;
    expect(input.value).toBe('42');
    expectKind(input, null);
  });

  it('colours the newly selected seed if an already pending lookup identifies it', async () => {
    const response = pendingResponse();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const { input, setDynamicUISeed, fetchDailySeed } = await createToolbar();
    setDynamicUISeed(42, false);
    const pending = fetchDailySeed();
    setDynamicUISeed(TODAY, false);
    response.resolve(TODAY);
    await pending;
    expect(input.value).toBe(String(TODAY));
    expectKind(input, 'today');
  });

  it('keeps historical daily links uncoloured after both current pointers resolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(String(url.includes('previous') ? PREVIOUS : TODAY))));
    const { input, setDynamicUISeed, fetchDailySeed, fetchPreviousDailySeed } = await createToolbar();
    setDynamicUISeed(42, true);
    await Promise.all([fetchDailySeed(), fetchPreviousDailySeed()]);
    expect(input.value).toBe('42');
    expectKind(input, null);
  });

  it('removes stale daily colouring when the identity cache is explicitly cleared', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(String(TODAY))));
    const { input, setDynamicUISeed, fetchDailySeed, clearDailySeedCache } = await createToolbar();
    setDynamicUISeed(TODAY, true);
    await fetchDailySeed();
    expectKind(input, 'today');
    clearDailySeedCache();
    expect(input.value).toBe(String(TODAY));
    expectKind(input, null);
  });
});

describe('daily buttons return diagnostic live URLs to baked routing', () => {
  let renderURLs: URL[];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    dynamicMap.seed = null;
    dynamicMap.getCurrentSeed.mockReset().mockImplementation(() => dynamicMap.seed);
    renderURLs = [];
    dynamicMap.run.mockReset().mockImplementation(async () => {
      renderURLs.push(new URL(window.location.href));
      return null;
    });
    Popover.instances.clear();
    vi.stubGlobal('bootstrap', { Popover });
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(String(url.includes('previous') ? PREVIOUS : TODAY))));
    document.body.innerHTML = '<div class="collapse navbar-collapse"><div class="d-flex flex-wrap"></div></div>';
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    history.replaceState(null, '', '/');
  });

  const buttons = [
    { name: 'Daily', id: 'dynamicDailySeedButton', seed: TODAY },
    { name: 'Previous Daily', id: 'dynamicPrevDailySeedButton', seed: PREVIOUS },
  ];

  it.each(buttons.flatMap(button => [
    { ...button, sameSeed: false }, { ...button, sameSeed: true },
  ]))('$name removes nb before requesting the map (same seed: $sameSeed)', async ({ id, seed, sameSeed }) => {
    dynamicMap.seed = sameSeed ? seed : 42;
    history.replaceState(null, '', `/?x=17&y=5120&z=1728&m=dy&se=${dynamicMap.seed}&terrain=gpu&nb=1&u=all&q=wand&sr=1#map`);
    await createToolbar();
    (document.getElementById(id) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dynamicMap.run).toHaveBeenCalledOnce());
    expect(dynamicMap.run).toHaveBeenCalledWith(seed, true, expect.objectContaining({ viewer: {} }));
    expect(renderURLs).toHaveLength(1);
    const requestedURL = renderURLs[0];
    expect(requestedURL.searchParams.has('nb')).toBe(false);
    expect(Object.fromEntries(requestedURL.searchParams)).toMatchObject({
      x: '17', y: '5120', z: '1728', m: 'dy', se: String(seed), ds: '1',
      terrain: 'gpu', u: 'all', q: 'wand', sr: '1',
    });
    expect(requestedURL.hash).toBe('#map');
    expect(window.location.href).toBe(requestedURL.href);
  });

  it.each(buttons)('$name remains a no-op for an already selected seed without nb', async ({ id, seed }) => {
    dynamicMap.seed = seed;
    history.replaceState(null, '', `/?m=dy&se=${seed}&ds=1&terrain=gpu`);
    await createToolbar();
    dynamicMap.getCurrentSeed.mockClear();
    const originalURL = window.location.href;
    (document.getElementById(id) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dynamicMap.getCurrentSeed).toHaveBeenCalled());
    expect(dynamicMap.run).not.toHaveBeenCalled();
    expect(window.location.href).toBe(originalURL);
  });
});

describe('seed entry and map focus', () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    dynamicMap.seed = 41;
    dynamicMap.getCurrentSeed.mockReset().mockImplementation(() => dynamicMap.seed);
    dynamicMap.run.mockReset().mockImplementation(async (seed, daily, opts) => { opts.onSeedResolved?.(seed, daily); return null; });
    vi.stubGlobal('bootstrap', { Popover }); Popover.instances.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(String(TODAY))));
    document.body.innerHTML = '<div class="collapse navbar-collapse"><div class="d-flex flex-wrap"></div></div><div id="map-canvas" tabindex="0"></div>';
  });
  afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    document.body.replaceChildren(); history.replaceState(null, '', '/');
  });
  const enter = (input: HTMLInputElement, isComposing = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true });
    input.dispatchEvent(event); return event;
  };
  const edit = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

  it('returns focus before a valid Enter submission without scrolling the page', async () => {
    const canvas = document.getElementById('map-canvas')!, focus = vi.spyOn(canvas, 'focus');
    const { input } = await createToolbar({ canvas });
    edit(input, '42'); input.focus();
    const event = enter(input);
    expect(event.defaultPrevented).toBe(true); expect(document.activeElement).toBe(canvas);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await vi.waitFor(() => expect(dynamicMap.run).toHaveBeenCalledOnce());
  });

  it('ends editing an already displayed valid seed without regenerating it', async () => {
    const canvas = document.getElementById('map-canvas')!;
    const { input } = await createToolbar({ canvas }); edit(input, '41'); input.focus(); enter(input);
    expect(document.activeElement).toBe(canvas); expect(dynamicMap.run).not.toHaveBeenCalled();
  });

  it('returns focus when blank Enter requests Daily', async () => {
    const canvas = document.getElementById('map-canvas')!, response = pendingResponse();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const { input } = await createToolbar({ canvas }); input.focus(); enter(input);
    expect(document.activeElement).toBe(canvas);
    response.resolve(TODAY); await vi.waitFor(() => expect(dynamicMap.run).toHaveBeenCalledOnce());
  });

  it('keeps invalid entry focused for correction', async () => {
    const canvas = document.getElementById('map-canvas')!;
    const { input } = await createToolbar({ canvas }); edit(input, '0'); input.focus(); enter(input);
    expect(document.activeElement).toBe(input); expect(input.classList.contains('is-invalid')).toBe(true);
    expect(dynamicMap.run).not.toHaveBeenCalled();
  });

  it('does not treat IME confirmation as a seed submission', async () => {
    const { input } = await createToolbar({ canvas: document.getElementById('map-canvas') });
    edit(input, '42'); input.focus(); const event = enter(input, true);
    expect(event.defaultPrevented).toBe(false); expect(document.activeElement).toBe(input);
    expect(dynamicMap.run).not.toHaveBeenCalled();
  });

  it('does not steal focus when an external map request becomes busy', async () => {
    const { input, setDynamicUIBusy } = await createToolbar({ canvas: document.getElementById('map-canvas') });
    edit(input, '42'); input.focus(); setDynamicUIBusy(true); enter(input);
    expect(document.activeElement).toBe(input); expect(dynamicMap.run).not.toHaveBeenCalled();
  });

  it('preserves selection and focus when the same resolved seed is repeated', async () => {
    const { input, setDynamicUISeed } = await createToolbar();
    setDynamicUISeed(12345, false); input.focus(); input.setSelectionRange(1, 4, 'backward');
    setDynamicUISeed(12345, false);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([1, 4, 'backward']);
  });

  it('keeps a newer draft through resolution but accepts explicit seed selections', async () => {
    const { input, setDynamicUISeed } = await createToolbar();
    setDynamicUISeed(42, false); edit(input, '777'); input.focus(); input.setSelectionRange(1, 1);
    setDynamicUISeed(42, false, true);
    expect(input.value).toBe('777'); expect(input.selectionStart).toBe(1);
    setDynamicUISeed(84, false); expect(input.value).toBe('84');
  });

  it.each(['dynamicDailySeedButton', 'dynamicPrevDailySeedButton'])('keeps edits made while %s resolves', async id => {
    const response = pendingResponse(); vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const { input, setDynamicUISeed } = await createToolbar();
    setDynamicUISeed(42, false); (document.getElementById(id) as HTMLButtonElement).click();
    edit(input, '777'); input.focus();
    response.resolve(TODAY); await vi.waitFor(() => expect(dynamicMap.run).toHaveBeenCalledOnce());
    expect(input.value).toBe('777'); expect(document.activeElement).toBe(input);
    expect(input.classList.contains('seed-daily')).toBe(false);
  });
});
