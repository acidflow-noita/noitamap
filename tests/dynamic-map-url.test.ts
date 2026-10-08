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
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: () => null, unlocksChanged: vi.fn(), UNLOCK_KEYS: [], getUrlUnlockKind: vi.fn() }));
vi.mock('../src/pillars-unlocks', () => ({ getPillarFlagsFromURL: vi.fn() }));
vi.mock('../src/unlocks-toggle', () => ({ beginAltSeed: vi.fn(), prewarmAlt: vi.fn(), resetAltCache: vi.fn() }));
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
import { initTelescope, generateDynamicMap, prewarmParallelWorlds } from '../src/telescope/telescope-adapter';
import { prewarmInstantTerrain } from '../src/telescope/instant-terrain-backend';
import { prewarmAlt } from '../src/unlocks-toggle';
import { getUrlUnlockKind } from '../src/unlocks';
import { probeBakedDZIs } from '../src/telescope/baked-dzi-loader';
import { addBakedDZIsToOSD } from '../src/telescope/baked-dzi-loader';
import { fetchBakedGeneration } from '../src/telescope/baked-generation';
import { scheduleDailyAssetWarmup } from '../src/telescope/daily-asset-prewarm';
import { cacheGeneration, getCachedGeneration } from '../src/telescope/tile-cache';
import { renderGenerationResult, prefetchAllSceneBitmaps, hasDynamicOverlays, prepareInstantTerrainResources, getAllPOIsFlat, cancelPendingDynamicTerrain, prewarmMapPresentation } from '../src/telescope/telescope-osd-bridge';

const today = 1216316599, previous = 1344443116;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  history.replaceState(null, '', '/?m=dy');
  vi.mocked(fetchDailySeed).mockResolvedValue(today);
  vi.mocked(fetchPreviousDailySeed).mockResolvedValue(previous);
  vi.mocked(shouldUseBakedTerrain).mockReturnValue(true);
  vi.mocked(isInstantTerrainEnabled).mockReturnValue(false);
  vi.mocked(getUrlUnlockKind).mockReturnValue(null);
});

describe('URL seed request ownership', () => {
  it('requires a fresh published Daily for a floating drawing and does not invent a fallback seed', async () => {
    history.replaceState(null, '', '/?m=dy&ds=1');
    const { resolveSeed } = await import('../src/dynamic-map');
    expect(await resolveSeed(() => true, true)).toEqual({ seed: today, isDaily: true });
    expect(fetchDailySeed).toHaveBeenLastCalledWith(true);
    history.replaceState(null, '', '/?m=dy&ds=1');
    vi.mocked(fetchDailySeed).mockRejectedValueOnce(new Error('offline'));
    await expect(resolveSeed(() => true, true)).rejects.toThrow('offline');
    expect(new URL(location.href).searchParams.has('se')).toBe(false);
  });
  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function livePipeline() {
    vi.mocked(shouldUseBakedTerrain).mockReturnValue(false);
    vi.mocked(initTelescope).mockResolvedValue();
    vi.mocked(getCachedGeneration).mockResolvedValue(null);
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(generateDynamicMap).mockImplementation(async ({ seed }) => ({ seed, ngPlus: 0,
      isNGP: false, worldSize: 70, worldCenter: 35, tileLayers: [{}], biomeData: {},
      poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any));
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    vi.mocked(getAllPOIsFlat).mockReturnValue([]);
    vi.mocked(hasDynamicOverlays).mockReturnValue(false);
    return vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  }

  it.each(['success', 'failure'])('discards an obsolete URL seed lookup after leaving for a static map (%s)', async outcome => {
    const frame = livePipeline(), lookup = deferred<number>();
    vi.mocked(fetchDailySeed).mockReturnValueOnce(lookup.promise);
    const pipeline = await import('../src/dynamic-map');
    const options = { viewer: {}, onLoadingChange: vi.fn(), onSeedResolved: vi.fn(), onPOIsReady: vi.fn() };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = pipeline.runDynamicMapFromURL(options);
      expect(fetchDailySeed).toHaveBeenCalledOnce();
      pipeline.clearDynamicMap(options.viewer);
      history.replaceState(null, '', '/?x=300&y=400&z=10');
      const staticURL = location.href;
      if (outcome === 'success') lookup.resolve(today);
      else lookup.reject(new Error('offline'));
      expect(await pending).toBeNull();
      expect(location.href).toBe(staticURL);
      expect(pipeline.getCurrentDynamicSeed()).toBeNull();
      expect(initTelescope).not.toHaveBeenCalled();
      expect(generateDynamicMap).not.toHaveBeenCalled();
      expect(renderGenerationResult).not.toHaveBeenCalled();
      expect(options.onSeedResolved).not.toHaveBeenCalled();
      expect(options.onPOIsReady).not.toHaveBeenCalled();
      expect(options.onLoadingChange).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally { pipeline.clearDynamicMap(options.viewer); warning.mockRestore(); frame.mockRestore(); }
  });

  it.each(['success', 'failure'])('keeps the newer custom seed when an earlier Daily lookup finishes (%s)', async outcome => {
    const frame = livePipeline(), lookup = deferred<number>();
    vi.mocked(fetchDailySeed).mockReturnValueOnce(lookup.promise);
    const pipeline = await import('../src/dynamic-map');
    const old = { viewer: {}, onSeedResolved: vi.fn(), onPOIsReady: vi.fn() };
    const current = { viewer: {}, onSeedResolved: vi.fn(), onPOIsReady: vi.fn() };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = pipeline.runDynamicMapFromURL(old);
      updateURLWithSeed(77, false);
      expect(await pipeline.runDynamicMap(77, false, current)).toMatchObject({ seed: 77 });
      const currentURL = location.href;
      if (outcome === 'success') lookup.resolve(today);
      else lookup.reject(new Error('offline'));
      expect(await pending).toBeNull();
      expect(location.href).toBe(currentURL);
      expect(pipeline.getCurrentDynamicSeed()).toBe(77);
      expect(pipeline.getLastGenerationResult()).toMatchObject({ seed: 77 });
      expect(generateDynamicMap).toHaveBeenCalledOnce();
      expect(renderGenerationResult).toHaveBeenCalledOnce();
      expect(old.onSeedResolved).not.toHaveBeenCalled();
      expect(old.onPOIsReady).not.toHaveBeenCalled();
      expect(current.onSeedResolved).toHaveBeenCalledExactlyOnceWith(77, false);
      expect(warning).not.toHaveBeenCalled();
    } finally { pipeline.clearDynamicMap(current.viewer); warning.mockRestore(); frame.mockRestore(); }
  });

  it('lets only the latest URL request start a map when both await the shared Daily lookup', async () => {
    const frame = livePipeline(), lookup = deferred<number>();
    vi.mocked(fetchDailySeed).mockReturnValue(lookup.promise);
    const pipeline = await import('../src/dynamic-map');
    const first = { viewer: {}, onSeedResolved: vi.fn() }, second = { viewer: {}, onSeedResolved: vi.fn() };
    try {
      const a = pipeline.runDynamicMapFromURL(first), b = pipeline.runDynamicMapFromURL(second);
      lookup.resolve(today);
      expect(await a).toBeNull();
      expect(await b).toMatchObject({ seed: today });
      expect(first.onSeedResolved).not.toHaveBeenCalled();
      expect(second.onSeedResolved).toHaveBeenCalledExactlyOnceWith(today, true);
      expect(generateDynamicMap).toHaveBeenCalledOnce();
      expect(parseURL()).toMatchObject({ seed: today, dailySeed: true });
    } finally { pipeline.clearDynamicMap(second.viewer); frame.mockRestore(); }
  });

  it('retains the deterministic fallback when the current Daily lookup fails', async () => {
    const frame = livePipeline();
    vi.mocked(fetchDailySeed).mockRejectedValue(new Error('offline'));
    const pipeline = await import('../src/dynamic-map');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await pipeline.runDynamicMapFromURL({ viewer: {} });
      expect(result!.seed).toBeGreaterThan(0);
      expect(parseURL()).toMatchObject({ seed: result!.seed, dailySeed: true });
      expect(generateDynamicMap).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
    } finally { pipeline.clearDynamicMap({}); warning.mockRestore(); frame.mockRestore(); }
  });
});
afterEach(() => { history.replaceState(null, '', '/'); });

describe('pending map replacement ownership', () => {
  function barrier() {
    let resolve!: () => void;
    return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
  }
  function fixture() {
    const cache = new Map<string, any>();
    vi.mocked(shouldUseBakedTerrain).mockReturnValue(false);
    vi.mocked(initTelescope).mockResolvedValue();
    vi.mocked(getCachedGeneration).mockImplementation(async key => cache.get(key) ?? null);
    vi.mocked(cacheGeneration).mockImplementation(async (key, _seed, result) => { cache.set(key, result); });
    vi.mocked(generateDynamicMap).mockImplementation(async ({ seed, unlocks }) => ({ seed, ngPlus: 0,
      isNGP: false, worldSize: 70, worldCenter: 35, tileLayers: [{}], biomeData: {},
      poisByPW: { '0,0': [{ type: 'item', item: 'heart', id: `${seed}-${unlocks ? 'restricted' : 'all'}` }] },
      pixelScenesByPW: {}, parallelWorlds: [0] } as any));
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    vi.mocked(getAllPOIsFlat).mockImplementation(result => Object.values(result.poisByPW).flat() as any);
    vi.mocked(hasDynamicOverlays).mockReturnValue(true);
    vi.mocked(prepareInstantTerrainResources).mockResolvedValue();
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    return { frame, viewer: {} };
  }

  it('retires outgoing terrain before Daily lookup and early GPU preparation, exactly once', async () => {
    const f = fixture(), lookup = barrier();
    const pipeline = await import('../src/dynamic-map');
    try {
      await pipeline.runDynamicMap(71, false, f);
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
      vi.mocked(prewarmInstantTerrain).mockClear();
      vi.mocked(prewarmMapPresentation).mockClear();
      vi.mocked(fetchDailySeed).mockImplementationOnce(() => lookup.promise.then(() => today));
      const pending = pipeline.runDynamicMap(72, false, f);
      expect(cancelPendingDynamicTerrain).toHaveBeenCalledOnce();
      expect(vi.mocked(cancelPendingDynamicTerrain).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(prewarmInstantTerrain).mock.invocationCallOrder[0]);
      expect(vi.mocked(cancelPendingDynamicTerrain).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(prewarmMapPresentation).mock.invocationCallOrder[0]);
      lookup.resolve();
      expect(await pending).toMatchObject({ seed: 72 });
      expect(cancelPendingDynamicTerrain).toHaveBeenCalledOnce();
    } finally { lookup.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it('keeps the completed renderer alive while confirming the same seed is redundant', async () => {
    const f = fixture(), lookup = barrier();
    const pipeline = await import('../src/dynamic-map');
    try {
      const current = await pipeline.runDynamicMap(71, false, f);
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      vi.mocked(fetchDailySeed).mockImplementationOnce(() => lookup.promise.then(() => today));
      const pending = pipeline.runDynamicMap(71, false, f);
      expect(cancelPendingDynamicTerrain).not.toHaveBeenCalled();
      lookup.resolve();
      expect(await pending).toBe(current);
      expect(cancelPendingDynamicTerrain).not.toHaveBeenCalled();
      expect(generateDynamicMap).toHaveBeenCalledOnce();
      expect(renderGenerationResult).toHaveBeenCalledOnce();
    } finally { lookup.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it.each(['daily', 'previous-daily'] as const)('retires same-seed live terrain before confirming a baked %s replacement', async prefix => {
    const f = fixture(), lookup = barrier(), seed = prefix === 'daily' ? today : previous;
    const pipeline = await import('../src/dynamic-map');
    try {
      const live = await pipeline.runDynamicMap(seed, true, f);
      const baked = { ...live!, tileLayers: [] };
      vi.mocked(shouldUseBakedTerrain).mockReturnValue(true);
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      vi.mocked(initTelescope).mockClear();
      vi.mocked(fetchDailySeed).mockImplementationOnce(() => lookup.promise.then(() => today));
      vi.mocked(fetchBakedGeneration).mockResolvedValue(baked);
      vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix, decorationsBaked: true,
        fullPixelsBaked: true, placements: [{ pw: 0, x: 0, y: 0, width: 100, bust: 'published', dziUrl: `/${prefix}.dzi` }] });
      const pending = pipeline.runDynamicMap(seed, false, f);
      expect(cancelPendingDynamicTerrain).toHaveBeenCalledOnce();
      lookup.resolve();
      expect(await pending).toBe(baked);
      expect(cancelPendingDynamicTerrain).toHaveBeenCalledOnce();
      expect(initTelescope).not.toHaveBeenCalled();
      expect(generateDynamicMap).toHaveBeenCalledOnce(); // only the original live map
    } finally { lookup.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it('restarts the cached outgoing map when selected again after its renderer was retired', async () => {
    const f = fixture(), lookup = barrier();
    const pipeline = await import('../src/dynamic-map');
    try {
      const original = await pipeline.runDynamicMap(71, false, f);
      vi.mocked(fetchDailySeed).mockImplementationOnce(() => lookup.promise.then(() => today));
      const pending = pipeline.runDynamicMap(72, false, f);
      expect(await pipeline.runDynamicMap(71, false, f)).toBe(original);
      expect(renderGenerationResult).toHaveBeenCalledTimes(2); // restore the stopped renderer
      expect(generateDynamicMap).toHaveBeenCalledOnce(); // reuse saved geometry
      lookup.resolve();
      expect(await pending).toBeNull();
      expect(pipeline.getCurrentDynamicSeed()).toBe(71);
    } finally { lookup.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it.each([false, true])('does not retire the winner when an obsolete Daily lookup settles (failure=%s)', async fails => {
    const f = fixture(), lookup = barrier();
    const pipeline = await import('../src/dynamic-map');
    try {
      await pipeline.runDynamicMap(71, false, f);
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      vi.mocked(fetchDailySeed).mockImplementationOnce(async () => {
        await lookup.promise; if (fails) throw new Error('offline'); return today;
      });
      const pending = pipeline.runDynamicMap(72, false, f);
      expect(cancelPendingDynamicTerrain).toHaveBeenCalledOnce();
      expect(await pipeline.runDynamicMap(73, false, f)).toMatchObject({ seed: 73 });
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      lookup.resolve();
      expect(await pending).toBeNull();
      expect(cancelPendingDynamicTerrain).not.toHaveBeenCalled();
      expect(pipeline.getLastGenerationResult()).toMatchObject({ seed: 73 });
    } finally { lookup.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it('does not let a reentrant replacement callback retire the completed map it reselected', async () => {
    const f = fixture();
    const pipeline = await import('../src/dynamic-map');
    try {
      const current = await pipeline.runDynamicMap(today, true, f);
      vi.mocked(cancelPendingDynamicTerrain).mockClear();
      let replay: Promise<unknown> | undefined;
      expect(await pipeline.runDynamicMap(72, false, { ...f, onMapReplacementStart: () => {
        replay = pipeline.runDynamicMap(today, true, f);
      } })).toBeNull();
      expect(await replay).toBe(current);
      expect(cancelPendingDynamicTerrain).not.toHaveBeenCalled();
      expect(renderGenerationResult).toHaveBeenCalledOnce();
    } finally { pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it.each(['assets', 'generation', 'presentation'])(
    'does not mistake the incoming seed for the completed outgoing map while waiting for %s', async stage => {
      const f = fixture(), started = barrier(), resume = barrier();
      const pipeline = await import('../src/dynamic-map');
      try {
        const old = await pipeline.runDynamicMap(71, false, f);
        expect(old).toMatchObject({ seed: 71 });
        if (stage === 'assets') vi.mocked(initTelescope).mockImplementationOnce(async () => {
          started.resolve(); await resume.promise;
        });
        else if (stage === 'generation') {
          const generate = vi.mocked(generateDynamicMap).getMockImplementation()!;
          vi.mocked(generateDynamicMap).mockImplementationOnce(async options => {
            started.resolve(); await resume.promise; return generate(options);
          });
        } else vi.mocked(renderGenerationResult).mockImplementationOnce(async () => {
          started.resolve(); await resume.promise;
        });
        const obsoletePOIs = vi.fn(), currentPOIs = vi.fn();
        const outgoing = pipeline.runDynamicMap(72, false, { ...f, onPOIsReady: obsoletePOIs });
        await started.promise;
        expect(pipeline.getCurrentDynamicSeed()).toBe(72);
        expect(pipeline.getLastGenerationResult()).toBe(old);
        const incoming = await pipeline.runDynamicMap(72, false, { ...f, onPOIsReady: currentPOIs });
        expect(incoming).toMatchObject({ seed: 72 });
        expect(currentPOIs).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: '72-all' })]);
        expect(obsoletePOIs).not.toHaveBeenCalled();
        resume.resolve();
        expect(await outgoing).toBeNull();
        expect(pipeline.getLastGenerationResult()).toBe(incoming);

        // A genuinely completed map still takes the original cheap reuse path.
        const generated = vi.mocked(generateDynamicMap).mock.calls.length;
        const rendered = vi.mocked(renderGenerationResult).mock.calls.length;
        expect(await pipeline.runDynamicMap(72, false, { ...f, onPOIsReady: currentPOIs })).toBe(incoming);
        expect(generateDynamicMap).toHaveBeenCalledTimes(generated);
        expect(renderGenerationResult).toHaveBeenCalledTimes(rendered);
        if (stage === 'presentation') expect(generated).toBe(2); // A and B; the repeat reuses B's cache.
      } finally { resume.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
    },
  );

  it('publishes the requested unlock variant when that same-seed replacement is requested again', async () => {
    const f = fixture(), started = barrier(), resume = barrier();
    const pipeline = await import('../src/dynamic-map');
    try {
      const all = await pipeline.runDynamicMap(71, false, f);
      expect(all!.poisByPW['0,0'][0].id).toBe('71-all');
      vi.mocked(getUrlUnlockKind).mockReturnValue('none');
      vi.mocked(renderGenerationResult).mockImplementationOnce(async () => { started.resolve(); await resume.promise; });
      const obsoletePOIs = vi.fn(), currentPOIs = vi.fn();
      const pending = pipeline.runDynamicMap(71, false, { ...f, onPOIsReady: obsoletePOIs });
      await started.promise;
      const restricted = await pipeline.runDynamicMap(71, false, { ...f, onPOIsReady: currentPOIs });
      expect(restricted!.poisByPW['0,0'][0].id).toBe('71-restricted');
      expect(currentPOIs).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: '71-restricted' })]);
      resume.resolve(); expect(await pending).toBeNull();
      expect(obsoletePOIs).not.toHaveBeenCalled();
      expect(pipeline.getLastGenerationResult()).toBe(restricted);
    } finally { resume.resolve(); pipeline.clearDynamicMap(f.viewer); f.frame.mockRestore(); }
  });

  it('retries a failed incoming seed instead of returning the previous seed as a successful result', async () => {
    const f = fixture(), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pipeline = await import('../src/dynamic-map');
    try {
      const old = await pipeline.runDynamicMap(71, false, f);
      vi.mocked(generateDynamicMap).mockRejectedValueOnce(new Error('generation failed'));
      expect(await pipeline.runDynamicMap(72, false, f)).toBeNull();
      expect(pipeline.getLastGenerationResult()).toBe(old);
      expect(error).toHaveBeenCalledOnce();
      const pois = vi.fn();
      expect(await pipeline.runDynamicMap(72, false, { ...f, onPOIsReady: pois })).toMatchObject({ seed: 72 });
      expect(pois).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: '72-all' })]);
      expect(generateDynamicMap).toHaveBeenCalledTimes(3);
    } finally { pipeline.clearDynamicMap(f.viewer); error.mockRestore(); f.frame.mockRestore(); }
  });
});

/** Exercise main's actual wiring with a small host, without booting OSD. */
function mainFunction(start: string, end: string, dependencies: Record<string, unknown>, name: string) {
  const source = readFileSync('src/main.ts', 'utf8');
  const offset = source.indexOf(start), stop = source.indexOf(end, offset);
  expect(offset).toBeGreaterThanOrEqual(0); expect(stop).toBeGreaterThan(offset);
  const js = transpileModule(source.slice(offset, stop), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}\nreturn ${name};`)(...Object.values(dependencies));
}

describe('dynamic seed URL identity', () => {
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
        expect(vi.mocked(renderGenerationResult).mock.calls[0][11]).toBe(false);
        expect(location.search).toContain('terrain=gpu');
        // With the baked route already active, repeated selection is harmless.
        expect(await pipeline.runDynamicMapFromURL({ viewer: {} })).toBe(baked);
        expect(probeBakedDZIs).toHaveBeenCalledOnce();
        expect(renderGenerationResult).toHaveBeenCalledOnce();
      } finally { pipeline.clearDynamicMap({}); frame.mockRestore(); }
    },
  );

  it.each((['daily', 'previous-daily'] as const).flatMap(prefix =>
    [true, false].flatMap(metadata => [true, false].map(dailyFlag => ({
      prefix, seed: prefix === 'daily' ? today : previous, metadata, dailyFlag,
    }))),
  ))('keeps $prefix pixels baked with metadata=$metadata, dailyFlag=$dailyFlag, then prepares live rendering on demand', async ({ prefix, seed, metadata, dailyFlag }) => {
    history.replaceState(null, '', `/?m=dy&se=${seed}${dailyFlag ? '&ds=1' : ''}`);
    vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
    const viewer = {}, placements = [{ pw: 0, x: 0, y: 0, width: 100, bust: '1', dziUrl: `/${prefix}.dzi` }];
    const generated = { seed, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
      tileLayers: metadata ? [] : [{}], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, parallelWorlds: [0] } as any;
    vi.mocked(fetchBakedGeneration).mockResolvedValue(metadata ? generated : null);
    vi.mocked(probeBakedDZIs).mockResolvedValue({ baked: true, prefix, placements, decorationsBaked: true, fullPixelsBaked: true });
    vi.mocked(scheduleDailyAssetWarmup).mockReturnValue(vi.fn());
    vi.mocked(initTelescope).mockResolvedValue();
    vi.mocked(getCachedGeneration).mockResolvedValue(null);
    vi.mocked(generateDynamicMap).mockImplementation(async options => {
      const result = { ...generated, seed: options.seed, tileLayers: [{}] };
      options.onTerrainReady?.(result);
      return result;
    });
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    vi.mocked(prepareInstantTerrainResources).mockResolvedValue();
    vi.mocked(prewarmAlt).mockResolvedValue();
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
    const flushFrames = async () => {
      for (const callback of frames.splice(0)) callback(0);
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    const pipeline = await import('../src/dynamic-map');
    try {
      const result = await pipeline.runDynamicMapFromURL({ viewer });
      expect(result).toMatchObject({ seed });
      await flushFrames();
      expect(addBakedDZIsToOSD).toHaveBeenCalledOnce();
      expect(vi.mocked(renderGenerationResult).mock.calls[0].slice(6, 9)).toEqual([placements, true, true]);
      expect(scheduleDailyAssetWarmup).not.toHaveBeenCalled();
      expect(prewarmInstantTerrain).not.toHaveBeenCalled();
      expect(prepareInstantTerrainResources).not.toHaveBeenCalled();
      expect(prefetchAllSceneBitmaps).not.toHaveBeenCalled();
      expect(prewarmAlt).toHaveBeenCalledExactlyOnceWith(seed, prefix === 'daily' || dailyFlag, false);
      if (metadata) {
        expect(initTelescope).not.toHaveBeenCalled();
        expect(generateDynamicMap).not.toHaveBeenCalled();
        expect(prewarmParallelWorlds).not.toHaveBeenCalled();
      } else {
        expect(generateDynamicMap).toHaveBeenCalledOnce(); // retain the POI fallback
        expect(vi.mocked(generateDynamicMap).mock.calls[0][0].onTerrainReady).toBeUndefined();
      }
      vi.mocked(hasDynamicOverlays).mockReturnValue(true);
      expect(await pipeline.runDynamicMapFromURL({ viewer })).toBe(result);
      expect(renderGenerationResult).toHaveBeenCalledOnce();
      expect(scheduleDailyAssetWarmup).not.toHaveBeenCalled();

      // Removing baked-map preparation must not disable it for a custom seed.
      const live = await pipeline.runDynamicMap(77, false, { viewer });
      expect(live).toMatchObject({ seed: 77, tileLayers: [{}] });
      await flushFrames();
      expect(prepareInstantTerrainResources).toHaveBeenCalledWith(live, expect.any(Function));
      expect(prefetchAllSceneBitmaps).toHaveBeenCalledOnce();
      expect(prewarmAlt).toHaveBeenLastCalledWith(77, false, true);
    } finally { pipeline.clearDynamicMap(viewer); frame.mockRestore(); }
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
