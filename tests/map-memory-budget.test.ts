import { afterEach, expect, it, vi } from 'vitest';
import { getMapMemoryBudget, mapMemoryBudgetFor } from '../src/map-memory-budget';

afterEach(() => vi.unstubAllGlobals());

it('uses a bounded working set on touch devices without a memory API', () => {
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' })));
  const budget = getMapMemoryBudget();
  expect(budget.profile).toBe('compact');
  expect(budget.imageLoaderLimit).toBeGreaterThan(0);
  expect(budget.osdCacheTiles).toBeLessThan(200);
  expect(budget.retainedTerrainBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(budget.viewportMaxPixels * 4).toBeLessThanOrEqual(budget.terrainCacheBytes);
});

it('also reduces decoded caches on low-memory desktops', () => {
  const limited = mapMemoryBudgetFor({ deviceMemory: 4 });
  const desktop = mapMemoryBudgetFor({ deviceMemory: 8 });
  expect(limited.profile).toBe('compact');
  expect(desktop.profile).toBe('desktop');
  for (const key of ['terrainCacheBytes', 'retainedTerrainBytes', 'maskCacheBytes',
    'sceneCacheBytes', 'biomeBackgroundCacheBytes', 'staticBackgroundBytes',
    'retainedFramePixels', 'continuityTiles'] as const) {
    expect(limited[key]).toBeGreaterThan(0);
    expect(limited[key]).toBeLessThan(desktop[key]);
  }
});

it('does not treat missing or invalid memory hints as zero available memory', () => {
  for (const memory of [undefined, 0, -1, NaN, Infinity])
    expect(mapMemoryBudgetFor({ deviceMemory: memory }).profile).toBe('desktop');
  vi.stubGlobal('navigator', { maxTouchPoints: 10 });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  expect(getMapMemoryBudget().profile).toBe('desktop');
});

it('tolerates unavailable media queries and keeps the low-memory hint', () => {
  vi.stubGlobal('navigator', { deviceMemory: 2 });
  vi.stubGlobal('matchMedia', () => { throw new Error('unavailable'); });
  expect(getMapMemoryBudget().profile).toBe('compact');
});
