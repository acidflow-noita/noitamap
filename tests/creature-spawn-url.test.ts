// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';

vi.mock('../src/data_sources/overlays', () => ({ isValidOverlayKey: () => false }));

import {
  clearSeedParams,
  clearTargetPoiId,
  normalizeSpawnCreatureId,
  parseURL,
  reorderParams,
  updateURL,
  updateURLWithCanvas,
  updateURLWithCreatureSpawn,
  updateURLWithOverlays,
  updateURLWithSearch,
  updateURLWithSeed,
  updateURLWithSeedReport,
  updateURLWithSidebar,
  updateURLWithUnlocks,
} from '../src/data_sources/url';

const original = '/?x=10&y=-20&z=300&m=dy&se=123&ds=1&o=bb,bo&s=1&c=b&poi=creature-42&q=wand&f=w,s&sr=1&u=none&custom=keep#location';

beforeEach(() => history.replaceState(null, '', original));
afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('shared creature spawn selection', () => {
  it.each(['thundermage', 'boss_dragon', 'synthetic.Creature-2', 'a'.repeat(256)])(
    'roundtrips a local creature ID %s', id => {
      updateURLWithCreatureSpawn(id);
      expect(new URL(location.href).searchParams.get('spawn')).toBe(id);
      expect(parseURL().spawnCreatureId).toBe(id);
    },
  );

  it.each([
    null, undefined, '', ' ', ' thundermage', 'thundermage ', '.', '..',
    '../thundermage', 'data/entities/animals/thundermage.xml', 'a\\b',
    'https://example.test/enemy', '//example.test/enemy', 'a?seed=1', 'a#b',
    'a%2Fb', 'a\nb', '雷', 'a'.repeat(257),
  ])('rejects malformed or nonlocal creature IDs: %s', id => {
    expect(normalizeSpawnCreatureId(id)).toBeUndefined();
    const url = new URL(location.href);
    if (id !== null && id !== undefined) url.searchParams.set('spawn', id);
    history.replaceState(null, '', url);
    expect(parseURL().spawnCreatureId).toBeUndefined();
  });

  it('sets and clears only the spawn selection, preserving all other link state', () => {
    const before = new URL(location.href);
    updateURLWithCreatureSpawn('thundermage');
    const selected = new URL(location.href);
    for (const [key, value] of before.searchParams) {
      expect(selected.searchParams.get(key), key).toBe(value);
    }
    expect(selected.hash).toBe(before.hash);
    expect([...selected.searchParams.keys()].indexOf('spawn')).toBe(
      [...selected.searchParams.keys()].indexOf('poi') + 1,
    );

    updateURLWithCreatureSpawn();
    const cleared = new URL(location.href);
    expect(cleared.searchParams.has('spawn')).toBe(false);
    expect(Object.fromEntries(cleared.searchParams)).toEqual(Object.fromEntries(before.searchParams));
    expect(cleared.hash).toBe(before.hash);
  });

  it('removes a stale valid selection when the replacement ID is invalid', () => {
    updateURLWithCreatureSpawn('thundermage');
    updateURLWithCreatureSpawn('../unknown');
    expect(new URL(location.href).searchParams.has('spawn')).toBe(false);
    expect(parseURL().targetPoiId).toBe('creature-42');
  });

  it('preserves the selection across viewport, seed, overlay and other URL rewrites', () => {
    updateURLWithCreatureSpawn('thundermage');
    const rewrites = [
      () => updateURL({ pos: { x: 25, y: 30, zoom: 2 }, map: 'dynamic-main-branch' }),
      () => updateURLWithSeed(456, false),
      () => updateURLWithOverlays(['biomeBoundaries']),
      () => updateURLWithSearch('spark', new Set(['spells'])),
      () => updateURLWithSidebar(false),
      () => updateURLWithCanvas('white'),
      () => updateURLWithSeedReport(false),
      () => updateURLWithUnlocks('all'),
      clearTargetPoiId,
      clearSeedParams,
    ];
    for (const rewrite of rewrites) {
      rewrite();
      expect(parseURL().spawnCreatureId).toBe('thundermage');
    }
    expect(parseURL()).toMatchObject({
      pos: { x: 25, y: 30, zoom: 2 },
      map: 'dynamic-main-branch',
      overlays: ['biomeBoundaries'],
      query: 'spark', filters: ['spells'], sidebarOpen: false, canvas: 'white',
      seedReportOpen: false, seed: undefined, dailySeed: undefined, targetPoiId: undefined,
    });
  });

  it('keeps spawn selection in the actual share snapshot alongside a creature card and pinned seed', () => {
    updateURLWithCreatureSpawn('thundermage');
    // Exercise the real share builder without starting the application or OSD.
    const source = readFileSync('src/main.ts', 'utf8');
    const start = source.indexOf('  const getShareUrl =');
    const end = source.indexOf('  (window as any).getShareUrl', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const js = transpileModule(source.slice(start, end), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const dependencies = {
      app: { getMap: () => 'dynamic-main-branch' },
      getCurrentDynamicSeed: () => 789,
      getCurrentIsDaily: () => true,
      getEnabledOverlays: () => ['biomeBoundaries'],
      overlayToShort: () => 'bb',
      getActiveDescriptor: () => 'all',
      reorderParams,
    };
    const share = new Function(...Object.keys(dependencies), `${js}\nreturn getShareUrl;`)(...Object.values(dependencies));
    history.replaceState(null, '', share('shared-creature'));
    expect(parseURL()).toMatchObject({
      spawnCreatureId: 'thundermage', targetPoiId: 'shared-creature',
      seed: 789, dailySeed: true, overlays: ['biomeBoundaries'],
      pos: { x: 10, y: -20, zoom: 0.125 },
    });
  });
});
