// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';

vi.mock('../src/renderer_settings', () => ({ shouldUseBakedTerrain: vi.fn(() => true) }));
vi.mock('../src/data_sources/daily_seed', () => ({ fetchDailySeed: vi.fn(), fetchPreviousDailySeed: vi.fn() }));
vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));
vi.mock('../src/telescope/tile-cache', () => ({ getCachedGeneration: vi.fn(), cacheGeneration: vi.fn() }));
vi.mock('../src/telescope/telescope-adapter', () => ({ generateDynamicMap: vi.fn(), initTelescope: vi.fn() }));
vi.mock('../src/unlocks', () => ({ getUnlocksFromURL: () => null, unlocksChanged: vi.fn(), UNLOCK_KEYS: [], getUrlUnlockKind: vi.fn() }));
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

import { fetchDailySeed, fetchPreviousDailySeed } from '../src/data_sources/daily_seed';
import { parseURL, reorderParams, updateURLWithSeed } from '../src/data_sources/url';
import { shouldUseBakedTerrain } from '../src/renderer_settings';
import { initTelescope } from '../src/telescope/telescope-adapter';
import { probeBakedDZIs } from '../src/telescope/baked-dzi-loader';

const today = 1216316599, previous = 1344443116;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  history.replaceState(null, '', '/?m=dy');
  vi.mocked(fetchDailySeed).mockResolvedValue(today);
  vi.mocked(fetchPreviousDailySeed).mockResolvedValue(previous);
  vi.mocked(shouldUseBakedTerrain).mockReturnValue(true);
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
