// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer_settings', () => ({ shouldUseBakedTerrain: () => false }));
vi.mock('../src/data_sources/daily_seed', () => ({ fetchDailySeed: vi.fn(), fetchPreviousDailySeed: vi.fn() }));
vi.mock('../src/data_sources/url', () => ({ parseURL: vi.fn(), updateURLWithSeed: vi.fn(), clearSeedParams: vi.fn() }));
vi.mock('../src/telescope/tile-cache', () => ({ getCachedGeneration: vi.fn(), cacheGeneration: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: vi.fn(), initTelescope: vi.fn() }));
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: vi.fn(), unlocksChanged: vi.fn(), UNLOCK_KEYS: [], getUrlUnlockKind: vi.fn() }));
vi.mock('../src/pillars-unlocks', () => ({ getPillarFlagsFromURL: vi.fn() }));
vi.mock('../src/unlocks-toggle', () => ({ prewarmAlt: vi.fn(), resetAltCache: vi.fn() }));
vi.mock('../src/light-mode', () => ({ isLightMode: () => false }));
vi.mock('../src/telescope/telescope-osd-bridge', () => ({
  renderGenerationResult: vi.fn(), clearDynamicOverlays: vi.fn(), getAllPOIsFlat: vi.fn(),
  hasDynamicOverlays: vi.fn(), ensurePersistentBiomeBackgrounds: vi.fn(),
  resetPersistentBiomeBackgrounds: vi.fn(), prefetchAllSceneBitmaps: vi.fn(),
}));
vi.mock('../src/telescope/baked-dzi-loader', () => ({ addBakedDZIsToOSD: vi.fn(), probeBakedDZIs: vi.fn(), isLocalBakeView: () => false }));
vi.mock('../src/telescope/perk-i18n', () => ({ perkNameKey: vi.fn() }));
vi.mock('../src/game-translations/translator', () => ({ gameTranslator: {} }));
import { clearDynamicMap, runDynamicMap } from '../src/dynamic-map';
import { fetchDailySeed, fetchPreviousDailySeed } from '../src/data_sources/daily_seed';
import { updateURLWithSeed } from '../src/data_sources/url';
import { getCachedGeneration } from '../src/telescope/tile-cache';
import { prewarmAlt } from '../src/unlocks-toggle';
import { renderGenerationResult, prefetchAllSceneBitmaps } from '../src/telescope/telescope-osd-bridge';
import { initTelescope } from '../src/telescope/telescope-adapter';

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


it.each([false, true])('defers background generation until terrain is presented (replaced=%s)', async replaced => {
  vi.useFakeTimers();
  try {
    clearDynamicMap({}); vi.clearAllMocks();
    vi.mocked(fetchDailySeed).mockResolvedValue(1);
    vi.mocked(fetchPreviousDailySeed).mockResolvedValue(2);
    vi.mocked(getCachedGeneration).mockResolvedValue({ seed: 92, tileLayers: [{}], poisByPW: {}, parallelWorlds: [-1, 0, 1] });
    vi.mocked(prewarmAlt).mockResolvedValue();
    vi.mocked(prefetchAllSceneBitmaps).mockResolvedValue();
    const loading = vi.fn();
    const pending = runDynamicMap(92, false, { viewer: {}, onLoadingChange: loading });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).not.toBeNull();
    expect(renderGenerationResult).toHaveBeenCalledOnce();
    expect(loading.mock.calls).toEqual([[true]]);
    expect(prewarmAlt).not.toHaveBeenCalled();
    expect(prefetchAllSceneBitmaps).not.toHaveBeenCalled();
    if (replaced) clearDynamicMap({});
    const paint = vi.mocked(renderGenerationResult).mock.calls[0][4]!;
    paint(); paint();
    if (!replaced) expect(loading).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(prewarmAlt).toHaveBeenCalledTimes(replaced ? 0 : 1);
    expect(prefetchAllSceneBitmaps).toHaveBeenCalledTimes(replaced ? 0 : 1);
  } finally { vi.useRealTimers(); }
});
