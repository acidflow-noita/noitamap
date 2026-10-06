// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/telescope/instant-terrain-backend', () => ({ prepareInstantTerrain: vi.fn() }));
vi.mock('../src/telescope/terrain-elevator', () => ({ prepareElevatorShafts: vi.fn(), includeElevatorOwnership: vi.fn() }));
vi.mock('../src/telescope/instant-terrain-coverage', () => ({ createInstantCoverage: () => ({ start() {} }) }));
vi.mock('../src/telescope/instant-terrain-cooker', () => ({ createInstantTerrainCooker: () => ({ stats: {}, start() {} }) }));
import { addInstantTerrain, clearInstantTerrain } from '../src/telescope/instant-terrain';
import { prepareInstantTerrain } from '../src/telescope/instant-terrain-backend';

afterEach(() => { clearInstantTerrain(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('registers lifetime before hashing so a seed change cancels before renderer setup', async () => {
  let clock = 0, resume!: () => void;
  vi.spyOn(performance, 'now').mockImplementation(() => clock += 8);
  const task = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
  vi.stubGlobal('scheduler', { yield: task });
  const handlers = new Set<() => void>();
  const viewer = { addHandler: (_name: string, handler: () => void) => handlers.add(handler),
    removeHandler: (_name: string, handler: () => void) => handlers.delete(handler) };
  const disposed = vi.fn(), item = vi.fn(), paint = vi.fn(), fallback = vi.fn();
  const gen = { seed: 42, isNGP: false, tileLayers: [], biomeData: { pixels: new Uint32Array(70 * 48) } };
  const pending = addInstantTerrain(viewer, gen, { getWorldSize: () => 70 } as any,
    [], () => true, item, paint, fallback, 0, Promise.resolve(), disposed);
  expect(task).toHaveBeenCalledOnce();
  expect(handlers.size).toBe(1);
  clearInstantTerrain(); resume();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(prepareInstantTerrain).not.toHaveBeenCalled();
  expect(item).not.toHaveBeenCalled(); expect(paint).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled(); expect(disposed).toHaveBeenCalledOnce();
  expect(handlers.size).toBe(0);
});
