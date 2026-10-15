import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStartingLoadout } from '../src/telescope/starting-equipment/loadout.js';
import { hydrateBakedGeneration, serializeGenerationForBake, type BakedGenerationFile } from '../src/telescope/baked-generation';

const seed = 304782898, october = { month: 10, day: 15 };
function fixture(value = seed): BakedGenerationFile {
  return { version: 1, seed: value, ngPlus: 0, isNGP: false, worldSize: 70, worldCenter: 35,
    parallelWorlds: [0], biomeDataW: 70, biomeDataH: 48,
    biomeDataPixels: Buffer.alloc(70 * 48 * 4).toString('base64'),
    poisByPW: { '0,0': [getStartingLoadout(value, false, 'normal', october),
      { type: 'item', item: 'potion', material: 'water', x: 100, y: 100 }] },
    pixelScenesByPW: { '0,0': [] } };
}
const loadout = (value: { poisByPW: Record<string, any[]> }) => value.poisByPW['0,0'].find(p => p.type === 'starting_loadout');
afterEach(() => { vi.useRealTimers(); });

describe('daily starting equipment', () => {
  it('reproduces the reported water/chaotic-polymorphine mismatch and distinct daily wands', () => {
    const normal = getStartingLoadout(seed, false, 'normal', october);
    const daily = getStartingLoadout(seed, true, 'normal', october);
    expect(normal.items[2]).toMatchObject({ material: 'water' });
    expect(daily.items[2]).toMatchObject({ material: 'magic_liquid_random_polymorph' });
    expect(daily.items[0]).toMatchObject({ cards: ['BOUNCY_ORB', 'BOUNCY_ORB', 'BOUNCY_ORB'] });
    expect(normal.items[0]).toMatchObject({ cards: ['LIGHT_BULLET', 'LIGHT_BULLET'] });
  });

  it('repairs only legacy daily loadouts without mutating the artifact or loading generation assets', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 15, 12));
    const file = fixture(), before = structuredClone(file);
    const normal = hydrateBakedGeneration([file]);
    const daily = hydrateBakedGeneration([file], true);
    expect(loadout(normal).items[2].material).toBe('water');
    expect(loadout(daily).items).toEqual(getStartingLoadout(seed, true, 'normal', october).items);
    expect(daily.poisByPW['0,0'].find(p => p.x === 100)?.material).toBe('water');
    expect(file).toEqual(before);
    expect(daily.startingLoadoutVersion).toBe(1);
    expect(daily.reportInventory).toBeDefined();
  });

  it('uses an explicit bake calendar, and documents legacy date fallback as current live semantics', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 4, 1, 12));
    const legacy = fixture(1);
    expect(loadout(hydrateBakedGeneration([legacy], true)).items[2].material).toBe('sima');
    legacy.calendar = october;
    expect(loadout(hydrateBakedGeneration([legacy], true)).items[2].material).toBe('water');
  });

  it('retains corrected historical equipment and mode/calendar in new bake metadata', () => {
    const file = fixture(1);
    file.dailySeed = true; file.calendar = { month: 5, day: 1 }; file.startingLoadoutVersion = 1;
    file.poisByPW['0,0'][0] = getStartingLoadout(1, true, 'normal', file.calendar);
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 15, 12));
    const result = hydrateBakedGeneration([file], true);
    expect(loadout(result).items[2].material).toBe('sima');
    expect(serializeGenerationForBake(result)).toMatchObject({ dailySeed: true,
      calendar: { month: 5, day: 1 }, startingLoadoutVersion: 1 });
  });
});
