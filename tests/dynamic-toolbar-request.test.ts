// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({ default: { t: (key: string) => key, on: vi.fn() } }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/data_sources/daily_seed', () => ({
  fetchDailySeed: vi.fn(), fetchPreviousDailySeed: vi.fn(),
  getCachedDailySeedIdentity: () => null, subscribeDailySeedIdentity: () => () => {},
}));
vi.mock('../src/renderer_settings', () => ({ shouldUseBakedTerrain: () => false, isInstantTerrainEnabled: () => false }));
vi.mock('../src/telescope/tile-cache', () => ({ getCachedGeneration: vi.fn(), cacheGeneration: vi.fn(async () => {}) }));
vi.mock('../src/telescope/telescope-cache-version', () => ({ ensureTelescopeCacheVersion: vi.fn(async () => {}) }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prewarmInstantTerrain: vi.fn(), releaseInstantTerrainBackend: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: vi.fn(), initTelescope: vi.fn(), prewarmParallelWorlds: vi.fn(), releaseParallelWorlds: vi.fn() }));
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: () => null, unlocksChanged: vi.fn(), getUrlUnlockKind: () => 'all' }));
vi.mock('../src/pillars-unlocks', () => ({ getPillarFlagsFromURL: () => null }));
vi.mock('../src/unlocks-toggle', () => ({ beginAltSeed: vi.fn(), prewarmAlt: vi.fn(), resetAltCache: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/spoiler-free', () => ({ isSpoilerFree: () => false }));
vi.mock('../src/overflow-menu', () => ({ updateOverflowMenu: vi.fn() }));
vi.mock('../src/telescope/telescope-osd-bridge', () => ({
  renderGenerationResult: vi.fn(), clearDynamicOverlays: vi.fn(), cancelPendingDynamicTerrain: vi.fn(), getAllPOIsFlat: () => [],
  hasDynamicOverlays: () => true, ensurePersistentBiomeBackgrounds: vi.fn(async () => {}),
  resetPersistentBiomeBackgrounds: vi.fn(), prefetchAllSceneBitmaps: vi.fn(async () => {}),
  prepareInstantTerrainResources: vi.fn(), prewarmMapPresentation: vi.fn(),
}));
vi.mock('../src/telescope/baked-dzi-loader', () => ({ addBakedDZIsToOSD: vi.fn(), probeBakedDZIs: vi.fn(), isLocalBakeView: () => false }));
vi.mock('../src/telescope/perk-i18n', () => ({ perkNameKey: vi.fn() }));
vi.mock('../src/game-translations/translator', () => ({ gameTranslator: {} }));

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Popover {
  static getInstance() { return null; }
}
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const controls = ['dynamicGenerateButton', 'dynamicDailySeedButton', 'dynamicPrevDailySeedButton'];
let ui: typeof import('../src/dynamic_ui'), map: typeof import('../src/dynamic-map');
let daily: typeof import('../src/data_sources/daily_seed');
let engine: typeof import('../src/telescope/telescope-adapter');
let bridge: typeof import('../src/telescope/telescope-osd-bridge');
let input: HTMLInputElement, opts: import('../src/dynamic-map').DynamicMapOptions;
const requests = vi.fn(), loading = vi.fn();

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubGlobal('bootstrap', { Popover });
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  document.body.innerHTML = '<div class="collapse navbar-collapse"><div class="d-flex flex-wrap"></div></div>';
  history.replaceState(null, '', '/?m=dy&se=41');
  ui = await import('../src/dynamic_ui'); map = await import('../src/dynamic-map');
  daily = await import('../src/data_sources/daily_seed');
  engine = await import('../src/telescope/telescope-adapter');
  bridge = await import('../src/telescope/telescope-osd-bridge');
  vi.mocked(daily.fetchDailySeed).mockResolvedValue(100);
  vi.mocked(daily.fetchPreviousDailySeed).mockResolvedValue(99);
  vi.mocked(engine.initTelescope).mockResolvedValue();
  vi.mocked(engine.generateDynamicMap).mockImplementation(async ({ seed }) => ({ seed, ngPlus: 0,
    isNGP: false, worldSize: 70, worldCenter: 35, tileLayers: [{}], biomeData: {},
    poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any));
  vi.mocked(bridge.renderGenerationResult).mockResolvedValue();
  opts = { viewer: {}, onLoadingChange: loading, onSeedResolved: ui.setDynamicUISeed,
    onRequestStateChange: (busy: boolean) => { requests(busy); ui.setDynamicUIBusy(busy); },
  };
  ui.createDynamicUI(opts); ui.updateDynamicUIVisibility('dynamic-main-branch');
  input = document.getElementById('dynamicSeedInput') as HTMLInputElement;
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren(); history.replaceState(null, '', '/');
});

function edit(seed: string) {
  input.value = seed; input.dispatchEvent(new Event('input', { bubbles: true }));
}
function expectBusy(busy: boolean) {
  for (const id of controls) expect(button(id).disabled, id).toBe(busy);
  expect(!!button('dynamicGenerateButton').querySelector('.spinner-border')).toBe(busy);
}

describe('toolbar state follows the current map request', () => {
  it('covers the initial URL Daily lookup and its pipeline with one busy interval', async () => {
    const lookup = deferred<number>();
    history.replaceState(null, '', '/?m=dy');
    vi.mocked(daily.fetchDailySeed).mockReturnValueOnce(lookup.promise);
    const pending = map.runDynamicMapFromURL(opts);
    edit('77'); expectBusy(true);
    expect(engine.generateDynamicMap).not.toHaveBeenCalled();
    lookup.resolve(100);
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(map.getLastGenerationResult()?.seed).toBe(100);
    expect(requests.mock.calls).toEqual([[true], [false]]);
    edit('77'); expectBusy(false);
  });

  it('does not let an obsolete URL lookup reset a newer request', async () => {
    const lookup = deferred<number>(), ready = deferred();
    history.replaceState(null, '', '/?m=dy');
    vi.mocked(daily.fetchDailySeed).mockReturnValueOnce(lookup.promise);
    const previous = map.runDynamicMapFromURL(opts);
    vi.mocked(bridge.renderGenerationResult).mockImplementationOnce(async () => { await ready.promise; });
    const current = map.runDynamicMap(43, true, opts);
    lookup.resolve(100); await previous;
    edit('77'); expectBusy(true);
    expect(requests.mock.calls).toEqual([[true], [true]]);
    ready.resolve(); await vi.advanceTimersByTimeAsync(0); await current;
    expect(requests.mock.calls).toEqual([[true], [true], [false]]);
    edit('77'); expectBusy(false);
  });

  it('stays busy through the first paint until externally requested metadata is ready', async () => {
    const ready = deferred();
    vi.mocked(bridge.renderGenerationResult).mockImplementationOnce(async (_viewer, _result, _unlocks, _daily, paint) => {
      paint?.(); await ready.promise;
    });
    const pending = map.runDynamicMap(42, false, opts);
    edit('77'); expectBusy(true);
    await vi.waitFor(() => expect(loading).toHaveBeenCalledWith(false));
    edit('77'); expectBusy(true);
    expect(requests.mock.calls).toEqual([[true]]);
    ready.resolve(); await pending;
    expectBusy(false);
    expect(requests.mock.calls).toEqual([[true], [false]]);
  });

  it.each(['pending', 'finished'])('does not let an older toolbar request (%s) reset a newer external request', async state => {
    const first = deferred(), second = deferred();
    vi.mocked(bridge.renderGenerationResult).mockImplementation(async (_viewer, result) => {
      await (result.seed === 42 ? first.promise : second.promise);
    });
    edit('42'); button('dynamicGenerateButton').click();
    await vi.waitFor(() => expect(bridge.renderGenerationResult).toHaveBeenCalledOnce());
    if (state === 'finished') { first.resolve(); await vi.advanceTimersByTimeAsync(0); }
    const pending = map.runDynamicMap(43, false, opts);
    await vi.waitFor(() => expect(bridge.renderGenerationResult).toHaveBeenCalledTimes(2));
    edit('77');
    if (state === 'pending') first.resolve();
    // Exercise the old 300ms completion deadline while the replacement waits.
    await vi.advanceTimersByTimeAsync(500);
    expectBusy(true);
    second.resolve(); await pending;
    expectBusy(false);
  });

  it.each(['generate', 'daily', 'previous'])('releases the completed %s toolbar action without an extra delay', async action => {
    edit('42');
    button(action === 'generate' ? controls[0] : action === 'daily' ? controls[1] : controls[2]).click();
    expectBusy(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(map.getLastGenerationResult()).not.toBeNull());
    edit('77'); expectBusy(false);
    expect(requests.mock.calls).toEqual([[true], [false]]);
  });

  it('releases the current controls on a pipeline error and permits a retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(engine.initTelescope).mockRejectedValueOnce(new Error('controlled asset failure'));
    const pending = map.runDynamicMap(42, false, opts);
    edit('77'); expectBusy(true);
    await vi.advanceTimersByTimeAsync(0); await pending;
    // The failed seed remains in the input; it must be retryable as-is.
    expect(input.value).toBe('42'); expectBusy(false); expect(error).toHaveBeenCalledOnce();
    button(controls[0]).click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(map.getLastGenerationResult()?.seed).toBe(42));
    expect(map.getLastGenerationResult()?.seed).toBe(42);
    edit('77'); expectBusy(false); error.mockRestore();
  });

  it('settles a completed-map reuse request without rebuilding or waiting for a timer', async () => {
    const first = map.runDynamicMap(42, true, opts);
    await vi.advanceTimersByTimeAsync(0); await first;
    requests.mockClear(); vi.mocked(bridge.renderGenerationResult).mockClear();
    await map.runDynamicMap(42, true, opts);
    expect(bridge.renderGenerationResult).not.toHaveBeenCalled();
    expect(requests.mock.calls).toEqual([[true], [false]]);
    edit('77'); expectBusy(false);
  });

  it('releases controls even if request setup throws before terrain preparation', async () => {
    const error = new Error('controlled setup failure');
    opts.onMapReplacementStart = () => { throw error; };
    await expect(map.runDynamicMap(42, true, opts)).rejects.toBe(error);
    expect(requests.mock.calls).toEqual([[true], [false]]);
    edit('77'); expectBusy(false);
    expect(engine.generateDynamicMap).not.toHaveBeenCalled();
  });

  it('lets a request started from the busy callback supersede the original request', async () => {
    let replacement: Promise<unknown> | undefined;
    const state = opts.onRequestStateChange!;
    opts.onRequestStateChange = busy => {
      state(busy);
      if (busy && requests.mock.calls.length === 1) replacement = map.runDynamicMap(43, true, opts);
    };
    const obsolete = map.runDynamicMap(42, true, opts);
    await vi.advanceTimersByTimeAsync(0);
    expect(await obsolete).toBeNull(); await replacement;
    expect(requests.mock.calls).toEqual([[true], [true], [false]]);
    expect(engine.generateDynamicMap).toHaveBeenCalledOnce();
    expect(map.getLastGenerationResult()?.seed).toBe(43);
    edit('77'); expectBusy(false);
  });
});

describe('Daily toolbar lookup ownership', () => {
  it.each(['daily', 'previous'])('ignores a pending %s lookup after an external seed replaces it', async kind => {
    const lookup = deferred<number>();
    vi.mocked(kind === 'daily' ? daily.fetchDailySeed : daily.fetchPreviousDailySeed).mockReturnValueOnce(lookup.promise);
    button(kind === 'daily' ? controls[1] : controls[2]).click();
    expectBusy(true);
    history.replaceState(null, '', '/?m=dy&se=43');
    const pending = map.runDynamicMap(43, true, opts);
    await vi.advanceTimersByTimeAsync(0); await pending;
    lookup.resolve(kind === 'daily' ? 100 : 99);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe('43');
    expect(new URL(location.href).searchParams.get('se')).toBe('43');
    expect(map.getLastGenerationResult()?.seed).toBe(43);
    expect(engine.generateDynamicMap).toHaveBeenCalledOnce();
    edit('77'); expectBusy(false);
  });

  it.each(['daily', 'previous'])('does not start generation when a pending %s lookup completes on a static map', async kind => {
    const lookup = deferred<number>();
    vi.mocked(kind === 'daily' ? daily.fetchDailySeed : daily.fetchPreviousDailySeed).mockReturnValueOnce(lookup.promise);
    button(kind === 'daily' ? controls[1] : controls[2]).click();
    map.clearDynamicMap({}); ui.updateDynamicUIVisibility('regular-main-branch');
    history.replaceState(null, '', '/?m=r');
    lookup.resolve(kind === 'daily' ? 100 : 99);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.generateDynamicMap).not.toHaveBeenCalled();
    expect(location.search).toBe('?m=r');
    edit('77'); expectBusy(false);
  });

  it('releases controls immediately if the previous Daily is unavailable', async () => {
    vi.mocked(daily.fetchPreviousDailySeed).mockResolvedValueOnce(null);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    button(controls[2]).click(); await vi.advanceTimersByTimeAsync(0);
    edit('77'); expectBusy(false);
    expect(requests).not.toHaveBeenCalled(); warning.mockRestore();
  });

  it.each(['daily', 'previous'])('releases controls immediately if the %s lookup fails', async kind => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(kind === 'daily' ? daily.fetchDailySeed : daily.fetchPreviousDailySeed)
      .mockRejectedValueOnce(new Error('controlled lookup failure'));
    button(kind === 'daily' ? controls[1] : controls[2]).click();
    await vi.advanceTimersByTimeAsync(0);
    edit('77'); expectBusy(false);
    expect(requests).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
  });
});
