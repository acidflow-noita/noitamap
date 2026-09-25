// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer_settings', () => ({ shouldUseBakedTerrain: () => false, isInstantTerrainEnabled: vi.fn(() => false) }));
vi.mock('../src/data_sources/daily_seed', () => ({ fetchDailySeed: vi.fn(), fetchPreviousDailySeed: vi.fn() }));
vi.mock('../src/data_sources/url', () => ({ parseURL: vi.fn(), updateURLWithSeed: vi.fn(), clearSeedParams: vi.fn() }));
vi.mock('../src/telescope/tile-cache', () => ({ getCachedGeneration: vi.fn(), cacheGeneration: vi.fn() }));
vi.mock('../src/telescope/telescope-cache-version', () => ({ ensureTelescopeCacheVersion: vi.fn(async () => {}) }));
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prewarmInstantTerrain: vi.fn(), releaseInstantTerrainBackend: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: vi.fn(), initTelescope: vi.fn(), prewarmParallelWorlds: vi.fn(), releaseParallelWorlds: vi.fn() }));
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: vi.fn(), unlocksChanged: vi.fn(), UNLOCK_KEYS: [], getUrlUnlockKind: vi.fn() }));
vi.mock('../src/pillars-unlocks', () => ({ getPillarFlagsFromURL: vi.fn() }));
vi.mock('../src/unlocks-toggle', () => ({ prewarmAlt: vi.fn(), resetAltCache: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/telescope/telescope-osd-bridge', () => ({
  renderGenerationResult: vi.fn(), clearDynamicOverlays: vi.fn(), getAllPOIsFlat: vi.fn(),
  hasDynamicOverlays: vi.fn(), ensurePersistentBiomeBackgrounds: vi.fn(),
  resetPersistentBiomeBackgrounds: vi.fn(), prefetchAllSceneBitmaps: vi.fn(), prepareInstantTerrainResources: vi.fn(), prewarmMapPresentation: vi.fn(),
}));
vi.mock('../src/telescope/baked-dzi-loader', () => ({ addBakedDZIsToOSD: vi.fn(), probeBakedDZIs: vi.fn(), isLocalBakeView: () => false }));
vi.mock('../src/telescope/perk-i18n', () => ({ perkNameKey: vi.fn() }));
vi.mock('../src/game-translations/translator', () => ({ gameTranslator: {} }));
import { clearDynamicMap, runDynamicMap } from '../src/dynamic-map';
import { fetchDailySeed, fetchPreviousDailySeed } from '../src/data_sources/daily_seed';
import { updateURLWithSeed } from '../src/data_sources/url';
import { generateDynamicMap, initTelescope } from '../src/telescope/telescope-adapter';
import { isInstantTerrainEnabled } from '../src/renderer_settings';
import { ensureTelescopeCacheVersion } from '../src/telescope/telescope-cache-version';
import { prewarmInstantTerrain } from '../src/telescope/instant-terrain-backend';
import { cacheGeneration, getCachedGeneration } from '../src/telescope/tile-cache';
import { ensurePersistentBiomeBackgrounds, prefetchAllSceneBitmaps, prepareInstantTerrainResources, renderGenerationResult } from '../src/telescope/telescope-osd-bridge';

function pendingSeed() {
  let resolve!: (seed: number) => void;
  const promise = new Promise<number>(done => { resolve = done; });
  return { promise, resolve };
}

describe('dynamic map request invalidation before daily lookup', () => {
  beforeEach(() => { vi.clearAllMocks(); clearDynamicMap({}); });

  it('invalidates old POI interactions synchronously and cannot resume after the map was replaced', async () => {
    const daily = pendingSeed(), onMapReplacementStart = vi.fn(), onLoadingChange = vi.fn();
    vi.mocked(fetchDailySeed).mockReturnValueOnce(daily.promise);
    const pending = runDynamicMap(42, false, { viewer: {}, onMapReplacementStart, onLoadingChange });
    expect(onMapReplacementStart).toHaveBeenCalledOnce();
    expect(onLoadingChange).not.toHaveBeenCalled();
    clearDynamicMap({});
    daily.resolve(42);
    expect(await pending).toBeNull();
    expect(updateURLWithSeed).not.toHaveBeenCalled();
    expect(initTelescope).not.toHaveBeenCalled();
  });

  it('does not let a slower earlier seed lookup take over a newer seed request', async () => {
    const firstDaily = pendingSeed(), secondDaily = pendingSeed(), firstLoading = vi.fn();
    vi.mocked(fetchDailySeed).mockReturnValueOnce(firstDaily.promise).mockReturnValueOnce(secondDaily.promise);
    const first = runDynamicMap(42, false, { viewer: {}, onLoadingChange: firstLoading });
    const second = runDynamicMap(99, false, { viewer: {} });
    firstDaily.resolve(42);
    expect(await first).toBeNull();
    expect(firstLoading).not.toHaveBeenCalled();
    expect(updateURLWithSeed).not.toHaveBeenCalled();
    clearDynamicMap({});
    secondDaily.resolve(99);
    expect(await second).toBeNull();
  });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('independent live-map startup work', () => {
  const generated = { seed: 42, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
    tileLayers: [{}], biomeData: {}, poisByPW: {}, pixelScenesByPW: {}, eyes: [], parallelWorlds: [0] } as any;

  beforeEach(() => {
    vi.resetAllMocks();
    clearDynamicMap({});
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.mocked(ensureTelescopeCacheVersion).mockResolvedValue();
    vi.mocked(initTelescope).mockResolvedValue();
    vi.mocked(getCachedGeneration).mockResolvedValue(null);
    vi.mocked(cacheGeneration).mockResolvedValue();
    vi.mocked(generateDynamicMap).mockResolvedValue(generated);
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    vi.mocked(ensurePersistentBiomeBackgrounds).mockResolvedValue();
    vi.mocked(renderGenerationResult).mockResolvedValue();
    vi.mocked(prepareInstantTerrainResources).mockResolvedValue();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts cache reads and generation without waiting for background artwork or previous daily', async () => {
    const assets = barrier(), background = barrier();
    vi.mocked(initTelescope).mockReturnValue(assets.promise);
    vi.mocked(ensurePersistentBiomeBackgrounds).mockReturnValue(background.promise);
    const pending = runDynamicMap(42, true, { viewer: {} });
    await vi.waitFor(() => expect(getCachedGeneration).toHaveBeenCalledOnce());
    expect(ensurePersistentBiomeBackgrounds).toHaveBeenCalledOnce();
    expect(generateDynamicMap).not.toHaveBeenCalled();
    expect(fetchDailySeed).not.toHaveBeenCalled();
    expect(fetchPreviousDailySeed).not.toHaveBeenCalled();
    assets.resolve();
    await vi.waitFor(() => expect(generateDynamicMap).toHaveBeenCalledOnce());
    expect(renderGenerationResult).not.toHaveBeenCalled();
    background.resolve();
    expect(await pending).toBe(generated);
    expect(renderGenerationResult).toHaveBeenCalledOnce();
  });

  it('validates cache revision before reading while asset initialization proceeds', async () => {
    const revision = barrier();
    vi.mocked(ensureTelescopeCacheVersion).mockReturnValue(revision.promise);
    const pending = runDynamicMap(42, true, { viewer: {} });
    await vi.waitFor(() => expect(initTelescope).toHaveBeenCalledOnce());
    expect(getCachedGeneration).not.toHaveBeenCalled();
    revision.resolve();
    expect(await pending).toBe(generated);
    expect(getCachedGeneration).toHaveBeenCalledOnce();
  });

  it('overlaps explicit GPU asset/shader startup with daily detection and discards obsolete requests', async () => {
    vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
    const daily = pendingSeed();
    vi.mocked(fetchDailySeed).mockReturnValue(daily.promise);
    const pending = runDynamicMap(42, false, { viewer: {} });
    expect(initTelescope).toHaveBeenCalledOnce();
    expect(prewarmInstantTerrain).toHaveBeenCalledOnce();
    clearDynamicMap({});
    daily.resolve(99);
    expect(await pending).toBeNull();
    expect(generateDynamicMap).not.toHaveBeenCalled();
  });

  it('does not attach late background artwork or render an obsolete seed', async () => {
    const background = barrier();
    vi.mocked(ensurePersistentBiomeBackgrounds).mockReturnValue(background.promise);
    const pending = runDynamicMap(42, true, { viewer: {} });
    await vi.waitFor(() => expect(generateDynamicMap).toHaveBeenCalledOnce());
    const isCurrent = vi.mocked(ensurePersistentBiomeBackgrounds).mock.calls[0][1]!;
    expect(isCurrent()).toBe(true);
    clearDynamicMap({});
    expect(isCurrent()).toBe(false);
    background.resolve();
    expect(await pending).toBeNull();
    expect(renderGenerationResult).not.toHaveBeenCalled();
  });

  it('prepares cached GPU resources while background artwork is still loading', async () => {
    vi.mocked(isInstantTerrainEnabled).mockReturnValue(true);
    vi.mocked(getCachedGeneration).mockResolvedValue(generated);
    const background = barrier();
    vi.mocked(ensurePersistentBiomeBackgrounds).mockReturnValue(background.promise);
    const pending = runDynamicMap(42, true, { viewer: {} });
    await vi.waitFor(() => expect(prepareInstantTerrainResources).toHaveBeenCalledOnce());
    expect(prepareInstantTerrainResources).toHaveBeenCalledWith(generated, expect.any(Function));
    expect(generateDynamicMap).not.toHaveBeenCalled();
    expect(renderGenerationResult).not.toHaveBeenCalled();
    background.resolve();
    expect(await pending).toBe(generated);
  });

  it('does not let a superseded request change the newer map loading state', async () => {
    const background = barrier(), loading = vi.fn();
    vi.mocked(ensurePersistentBiomeBackgrounds).mockReturnValueOnce(background.promise);
    vi.mocked(generateDynamicMap).mockImplementation(async opts => ({ ...generated, seed: opts.seed }));
    const first = runDynamicMap(42, true, { viewer: {}, onLoadingChange: loading });
    await vi.waitFor(() => expect(generateDynamicMap).toHaveBeenCalledOnce());
    expect(await runDynamicMap(43, true, { viewer: {}, onLoadingChange: loading })).toMatchObject({ seed: 43 });
    expect(loading.mock.calls).toEqual([[true], [true], [false]]);
    background.resolve();
    expect(await first).toBeNull();
    expect(loading.mock.calls).toEqual([[true], [true], [false]]);
  });
});
