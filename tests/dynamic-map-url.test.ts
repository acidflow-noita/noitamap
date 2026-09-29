// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';

vi.mock('../src/renderer_settings', () => ({ shouldUseBakedTerrain: vi.fn(() => true), isInstantTerrainEnabled: vi.fn(() => false) }));
vi.mock('../src/data_sources/daily_seed', () => ({ fetchDailySeed: vi.fn(), fetchPreviousDailySeed: vi.fn() }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/telescope/tile-cache', () => ({ getCachedGeneration: vi.fn(), cacheGeneration: vi.fn() }));
vi.mock('../src/telescope/telescope-cache-version', () => ({ ensureTelescopeCacheVersion: vi.fn(async () => {}) }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prewarmInstantTerrain: vi.fn(), releaseInstantTerrainBackend: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: vi.fn(), initTelescope: vi.fn(), prewarmParallelWorlds: vi.fn(), releaseParallelWorlds: vi.fn() }));
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: vi.fn(() => null), unlocksChanged: vi.fn(), UNLOCK_KEYS: [], getUrlUnlockKind: vi.fn() }));
vi.mock('../src/pillars-unlocks', () => ({ getPillarFlagsFromURL: vi.fn() }));
vi.mock('../src/unlocks-toggle', () => ({ prewarmAlt: vi.fn(), resetAltCache: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/telescope/telescope-osd-bridge', () => ({
  renderGenerationResult: vi.fn(), clearDynamicOverlays: vi.fn(), cancelPendingDynamicTerrain: vi.fn(), getAllPOIsFlat: vi.fn(),
  hasDynamicOverlays: vi.fn(), ensurePersistentBiomeBackgrounds: vi.fn(),
  resetPersistentBiomeBackgrounds: vi.fn(), prefetchAllSceneBitmaps: vi.fn(), prepareInstantTerrainResources: vi.fn(), prewarmMapPresentation: vi.fn(),
}));
vi.mock('../src/telescope/baked-dzi-loader', () => ({ addBakedDZIsToOSD: vi.fn(), probeBakedDZIs: vi.fn(), isLocalBakeView: () => false }));
vi.mock('../src/telescope/baked-generation', () => ({ fetchBakedGeneration: vi.fn() }));
vi.mock('../src/telescope/daily-asset-prewarm', () => ({ scheduleDailyAssetWarmup: vi.fn() }));
vi.mock('../src/telescope/perk-i18n', () => ({ perkNameKey: vi.fn() }));
vi.mock('../src/game-translations/translator', () => ({ gameTranslator: {} }));

import { fetchDailySeed, fetchPreviousDailySeed } from '../src/data_sources/daily_seed';
import { parseURL, reorderParams, updateURLWithSeed } from '../src/data_sources/url';
import { shouldUseBakedTerrain, isInstantTerrainEnabled } from '../src/renderer_settings';
import { initTelescope, generateDynamicMap } from '../src/telescope/telescope-adapter';
import { getUnlocksFromURL } from '../src/unlocks';
import { probeBakedDZIs } from '../src/telescope/baked-dzi-loader';
import { addBakedDZIsToOSD } from '../src/telescope/baked-dzi-loader';
import { fetchBakedGeneration } from '../src/telescope/baked-generation';
import { scheduleDailyAssetWarmup } from '../src/telescope/daily-asset-prewarm';
import { cacheGeneration, getCachedGeneration } from '../src/telescope/tile-cache';
import { renderGenerationResult, prefetchAllSceneBitmaps, hasDynamicOverlays, prepareInstantTerrainResources } from '../src/telescope/telescope-osd-bridge';

const today = 1216316599, previous = 1344443116;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  history.replaceState(null, '', '/?m=dy');
  vi.mocked(fetchDailySeed).mockResolvedValue(today);
  vi.mocked(fetchPreviousDailySeed).mockResolvedValue(previous);
  vi.mocked(shouldUseBakedTerrain).mockReturnValue(true);
  vi.mocked(isInstantTerrainEnabled).mockReturnValue(false);
  vi.mocked(getUnlocksFromURL).mockReturnValue(null);
});
afterEach(() => { history.replaceState(null, '', '/'); });

/** Exercise main's actual wiring with a small host, without booting OSD. */
function mainFunction(start: string, end: string, dependencies: Record<string, unknown>, name: string) {
  const source = readFileSync('src/main.ts', 'utf8');
  const offset = source.indexOf(start), stop = source.indexOf(end, offset);
  expect(offset).toBeGreaterThanOrEqual(0); expect(stop).toBeGreaterThan(offset);
  const js = transpileModule(source.slice(offset, stop), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}\nreturn ${name};`)(...Object.values(dependencies));
}

describe('dynamic seed URL identity', () => {
  it('does not describe an ordinary map download as biome generation', () => {
    const source = readFileSync('src/main.ts', 'utf8');
    const start = source.indexOf('    onLoadingChange:');
    const end = source.indexOf('    onSeedResolved:', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const js = transpileModule(`const options = {${source.slice(start, end)}};`,
      { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const show = vi.fn(), hide = vi.fn(), loadingIndicator = document.createElement('div');
    const dependencies = { reportMapLoading: false, poiContextReady: true, reportHighlights: null,
      app: { osd: {} }, resetPOICardContext: vi.fn(), loadingIndicator,
      showLoadingStrip: show, hideLoadingStrip: hide, unifiedSearch: { setIndexingState: vi.fn() } };
    const update = new Function(...Object.keys(dependencies), `${js}\nreturn options.onLoadingChange;`)(...Object.values(dependencies));
    update(true);
    expect(loadingIndicator.style.display).toBe('block');
    expect(show).not.toHaveBeenCalled();
    update(false);
    expect(loadingIndicator.style.display).toBe('none');
    expect(hide).toHaveBeenCalled();
  });

  it('opens the parameterless baked daily without generating for a saved mod unlock list', async () => {
    history.replaceState(null, '', '/');
    const actualUnlocks = await vi.importActual<typeof import('../src/unlocks')>('../src/unlocks');
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value) });
    localStorage.setItem('noitamap-unlocks', actualUnlocks.encodeUnlocks(['nuke']));
    vi.mocked(getUnlocksFromURL).mockImplementationOnce(actualUnlocks.getUnlocksFromURL);
    vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
    const generated = { seed: today, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
      tileLayers: [], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any;
    vi.mocked(fetchBakedGeneration).mockResolvedValue(generated);
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(scheduleDailyAssetWarmup).mockReturnValue(vi.fn());
    vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix: 'daily',
      placements: [{ pw: 0, x: 0, y: 0, width: 100, bust: 'today', dziUrl: '/daily.dzi' }],
      decorationsBaked: true, fullPixelsBaked: true });
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    try {
      const pipeline = await import('../src/dynamic-map');
      expect(await pipeline.runDynamicMapFromURL({ viewer: {} })).toBe(generated);
      expect(fetchBakedGeneration).toHaveBeenCalledWith('daily', ['left', 'middle', 'right'], today);
      expect(initTelescope).not.toHaveBeenCalled();
      expect(generateDynamicMap).not.toHaveBeenCalled();
      expect(prepareInstantTerrainResources).not.toHaveBeenCalled();
      expect(vi.mocked(renderGenerationResult).mock.calls[0][2]).toBeNull();
      expect(parseURL()).toMatchObject({ seed: today, dailySeed: true });
      expect(localStorage.getItem('noitamap-unlocks')).toBe(actualUnlocks.encodeUnlocks(['nuke']));
      pipeline.clearDynamicMap({});
    } finally {
      vi.unstubAllGlobals();
      frame.mockRestore();
    }
  });

  it('reveals painted decorated daily tiles while metadata is still downloading, keeping warmup gated', async () => {
    history.replaceState(null, '', '/');
    let metadata!: (result: any) => void;
    vi.mocked(fetchBakedGeneration).mockReturnValue(new Promise(resolve => { metadata = resolve; }));
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(scheduleDailyAssetWarmup).mockReturnValue(vi.fn());
    vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix: 'daily',
      placements: [{ pw: 0, x: 0, y: 0, width: 100, bust: 'today', dziUrl: '/daily.dzi' }],
      decorationsBaked: true, fullPixelsBaked: true });
    const handlers = new Map<string, Set<() => void>>();
    let painted = false, attached = false;
    vi.mocked(addBakedDZIsToOSD).mockImplementationOnce(() => { attached = true; });
    const item = { source: { __bakedDzi: true }, getOpacity: () => 1,
      getDrawArea: () => ({}), getFullyLoaded: () => painted, needsDraw: () => !painted,
      addHandler() {}, removeHandler() {} };
    const viewer = { addHandler(name: string, callback: () => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(callback);
    }, removeHandler(name: string, callback: () => void) { handlers.get(name)?.delete(callback); },
    world: { getItemCount: () => attached ? 1 : 0, getItemAt: () => item, addHandler() {}, removeHandler() {} } };
    const loading = vi.fn();
    const pipeline = await import('../src/dynamic-map');
    const pending = pipeline.runDynamicMapFromURL({ viewer, onLoadingChange: loading });
    await vi.waitFor(() => expect(addBakedDZIsToOSD).toHaveBeenCalledOnce());
    expect(loading.mock.calls).toEqual([[true]]);
    painted = true;
    for (const callback of handlers.get('update-viewport') ?? []) callback();
    await vi.waitFor(() => expect(loading.mock.calls).toEqual([[true], [false]]));
    expect(renderGenerationResult).not.toHaveBeenCalled();
    expect(initTelescope).not.toHaveBeenCalled();
    let warmed = false;
    void vi.mocked(scheduleDailyAssetWarmup).mock.calls[0][0].metadataReady!.then(() => { warmed = true; });
    await Promise.resolve();
    expect(warmed).toBe(false);
    const generated = { seed: today, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
      tileLayers: [], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any;
    metadata(generated);
    expect(await pending).toBe(generated);
    expect(warmed).toBe(true);
    expect(loading.mock.calls).toEqual([[true], [false]]);
    expect(prefetchAllSceneBitmaps).not.toHaveBeenCalled();
    pipeline.clearDynamicMap(viewer);
  });

  it.each([['daily', today], ['previous-daily', previous]] as const)(
    'switches the same seed from forced live GPU to baked %s without generating again', async (prefix, seed) => {
      history.replaceState(null, '', `/?m=dy&se=${seed}&ds=1&terrain=gpu&nb=1`);
      vi.mocked(shouldUseBakedTerrain).mockImplementation(search => !new URLSearchParams(search).has('nb'));
      vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
      const live = { seed, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
        tileLayers: [{}], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any;
      const baked = { ...live, tileLayers: [] };
      vi.mocked(initTelescope).mockResolvedValue();
      vi.mocked(generateDynamicMap).mockResolvedValue(live);
      vi.mocked(getCachedGeneration).mockResolvedValue(null);
      vi.mocked(cacheGeneration).mockResolvedValue();
      vi.mocked(renderGenerationResult).mockResolvedValue();
      vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
      vi.mocked(prepareInstantTerrainResources).mockResolvedValue();
      vi.mocked(hasDynamicOverlays).mockReturnValue(true);
      vi.mocked(fetchBakedGeneration).mockResolvedValue(baked);
      const placements = [{ pw: 0, x: 0, y: 0, width: 100, bust: 'published', dziUrl: `/${prefix}.dzi` }];
      vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix, placements,
        decorationsBaked: true, fullPixelsBaked: false });
      vi.mocked(scheduleDailyAssetWarmup).mockReturnValue(vi.fn());
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
      const pipeline = await import('../src/dynamic-map');
      try {
        expect(await pipeline.runDynamicMapFromURL({ viewer: {} })).toBe(live);
        expect(generateDynamicMap).toHaveBeenCalledOnce();
        expect(probeBakedDZIs).not.toHaveBeenCalled();
        vi.mocked(initTelescope).mockClear();
        vi.mocked(generateDynamicMap).mockClear();
        vi.mocked(prepareInstantTerrainResources).mockClear();
        vi.mocked(renderGenerationResult).mockClear();

        // The real Daily/Previous button removes this override before calling
        // the same pipeline. Same-seed deduplication must include that change.
        const url = new URL(location.href); url.searchParams.delete('nb');
        history.replaceState(null, '', url);
        expect(await pipeline.runDynamicMapFromURL({ viewer: {} })).toBe(baked);
        expect(probeBakedDZIs).toHaveBeenCalledExactlyOnceWith(prefix, seed);
        expect(addBakedDZIsToOSD).toHaveBeenCalledOnce();
        expect(fetchBakedGeneration).toHaveBeenCalledWith(prefix, ['left', 'middle', 'right'], seed);
        expect(initTelescope).not.toHaveBeenCalled();
        expect(generateDynamicMap).not.toHaveBeenCalled();
        expect(prepareInstantTerrainResources).not.toHaveBeenCalled();
        expect(vi.mocked(renderGenerationResult).mock.calls[0].slice(6, 9)).toEqual([placements, true, true]);
        expect(location.search).toContain('terrain=gpu');
        // With the baked route already active, repeated selection is harmless.
        expect(await pipeline.runDynamicMapFromURL({ viewer: {} })).toBe(baked);
        expect(probeBakedDZIs).toHaveBeenCalledOnce();
        expect(renderGenerationResult).toHaveBeenCalledOnce();
      } finally { pipeline.clearDynamicMap({}); frame.mockRestore(); }
    },
  );

  it.each([false, true])('arms baked daily assets and retains their intent across redundant selection: %s', async (reselect) => {
    history.replaceState(null, '', '/');
    const order: string[] = [], cancel = vi.fn(), viewer = {};
    const generated = { seed: today, ngPlus: 0, isNGP: false, tileLayers: [], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any;
    vi.mocked(fetchBakedGeneration).mockResolvedValue(generated);
    vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix: 'daily', placements: [{ pw: 0, x: 0, y: 0, width: 100, bust: '1', dziUrl: '/daily.dzi' }], decorationsBaked: true, fullPixelsBaked: true });
    vi.mocked(scheduleDailyAssetWarmup).mockImplementation(() => { order.push('warmup'); return cancel; });
    vi.mocked(addBakedDZIsToOSD).mockImplementation(() => { order.push('baked'); });
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(renderGenerationResult).mockImplementation(async () => {
      let ready = false;
      vi.mocked(scheduleDailyAssetWarmup).mock.calls[0][0].metadataReady?.then(() => { ready = true; });
      await Promise.resolve();
      expect(ready).toBe(false);
    });
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    try {
      const pipeline = await import('../src/dynamic-map');
      expect(await pipeline.runDynamicMapFromURL({ viewer })).toBe(generated);
      expect(order).toEqual(['warmup', 'baked']);
      expect(initTelescope).not.toHaveBeenCalled();
      const intent = vi.mocked(scheduleDailyAssetWarmup).mock.calls[0][0];
      expect(intent.viewer).toBe(viewer);
      expect(intent.isCurrent()).toBe(true);
      expect(intent.expectedBakedImages).toBe(1);
      await expect(intent.metadataReady).resolves.toBeUndefined();
      if (reselect) {
        vi.mocked(hasDynamicOverlays).mockReturnValue(true);
        expect(await pipeline.runDynamicMapFromURL({ viewer })).toBe(generated);
        expect(cancel).not.toHaveBeenCalled();
        expect(intent.isCurrent()).toBe(true);
        expect(scheduleDailyAssetWarmup).toHaveBeenCalledOnce();
        expect(renderGenerationResult).toHaveBeenCalledOnce();
      }
      pipeline.clearDynamicMap(viewer);
      expect(cancel).toHaveBeenCalledOnce();
      expect(intent.isCurrent()).toBe(false);
    } finally { frame.mockRestore(); }
  });

  it.each(['1', 'true', undefined])('honours an explicit seed with daily flag %s without consulting today', async daily => {
    history.replaceState(null, '', `/?m=dy&se=${previous}${daily ? `&ds=${daily}` : ''}&poi=previous-wand&sr=1`);
    const url = location.href;
    vi.mocked(fetchDailySeed).mockRejectedValue(new Error('offline'));
    const { resolveSeed } = await import('../src/dynamic-map');
    expect(await resolveSeed()).toEqual({ seed: previous, isDaily: !!daily });
    expect(fetchDailySeed).not.toHaveBeenCalled();
    expect(location.href).toBe(url);
  });

  it.each(['?m=dy&ds=1', '?m=dy&ds=true', '?m=dy'])('resolves today for unpinned URL %s', async query => {
    history.replaceState(null, '', `/${query}`);
    const { resolveSeed } = await import('../src/dynamic-map');
    expect(await resolveSeed()).toEqual({ seed: today, isDaily: true });
    expect(fetchDailySeed).toHaveBeenCalledOnce();
    expect(parseURL()).toMatchObject({ seed: today, dailySeed: true });
  });

  it('preserves a previous-daily seed through the URL writer, actual share builder and later reload', async () => {
    history.replaceState(null, '', '/?m=dy&x=7711&y=6847&z=1013&sr=1');
    updateURLWithSeed(previous, true); // The previous-daily button's URL path.
    const share = mainFunction('  const getShareUrl =', '  (window as any).getShareUrl', {
      app: { getMap: () => 'dynamic-main-branch' }, getCurrentDynamicSeed: () => previous,
      getCurrentIsDaily: () => true, getEnabledOverlays: () => [], overlayToShort: (value: string) => value,
      getActiveDescriptor: () => 'all', reorderParams,
    }, 'getShareUrl');
    history.replaceState(null, '', share('previous-wand'));
    const { resolveSeed } = await import('../src/dynamic-map');
    expect(await resolveSeed()).toEqual({ seed: previous, isDaily: true });
    expect(parseURL()).toMatchObject({ seed: previous, dailySeed: true, targetPoiId: 'previous-wand', seedReportOpen: true });
    vi.mocked(fetchDailySeed).mockResolvedValue(42); // A later published daily.
    expect(await resolveSeed()).toEqual({ seed: previous, isDaily: true });
    expect(fetchDailySeed).not.toHaveBeenCalled();
  });

  it('passes the pinned previous-daily identity into the initial map pipeline', async () => {
    history.replaceState(null, '', `/?m=dy&se=${previous}&ds=1`);
    vi.mocked(shouldUseBakedTerrain).mockReturnValue(false);
    const pipeline = await import('../src/dynamic-map');
    // Stop at the generator boundary; the real resolver and pipeline have
    // already committed and reported the selected identity by this point.
    vi.mocked(initTelescope).mockImplementationOnce(async () => { pipeline.clearDynamicMap({}); });
    const onSeedResolved = vi.fn();
    expect(await pipeline.runDynamicMapFromURL({ viewer: {}, onSeedResolved })).toBeNull();
    expect(onSeedResolved).toHaveBeenCalledExactlyOnceWith(previous, true);
  });

  it.each([
    { query: `?se=${previous}&ds=1`, expected: [previous, true] },
    { query: `?se=${previous}`, expected: [previous, false] },
    { query: '?ds=1', expected: null },
    { query: '', expected: [99, true] },
  ])('uses explicit URL identity before saved session for $query', async ({ query, expected }) => {
    history.replaceState(null, '', `/${query}`);
    const run = vi.fn(async () => {}), resolve = vi.fn(async () => {}), options = {};
    const restore = mainFunction('  async function runDynamicMapWithPriority', '\n\n  createDynamicUI', {
      parseURL, lastSessionSeed: 99, lastSessionIsDaily: true, dynamicOpts: options,
      updateURLWithSeed, runDynamicMap: run, runDynamicMapFromURL: resolve,
    }, 'runDynamicMapWithPriority');
    await restore();
    if (expected) {
      expect(run).toHaveBeenCalledExactlyOnceWith(...expected, options);
      expect(resolve).not.toHaveBeenCalled();
    } else {
      expect(run).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledExactlyOnceWith(options);
    }
  });

  it.each([previous, today])('only prefetches today when it matches the pinned daily seed %s', async seed => {
    history.replaceState(null, '', `/?m=dy&se=${seed}&ds=1`);
    const { startDailyFastPath } = await import('../src/dynamic-map');
    startDailyFastPath();
    await vi.waitFor(() => expect(fetchDailySeed).toHaveBeenCalledOnce());
    await Promise.resolve(); await Promise.resolve();
    if (seed === today) expect(probeBakedDZIs).toHaveBeenCalledExactlyOnceWith('daily', today);
    else expect(probeBakedDZIs).not.toHaveBeenCalled();
    expect(parseURL().seed).toBe(seed);
  });
});
