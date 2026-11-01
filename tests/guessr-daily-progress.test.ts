import { expect, it } from 'vitest';
import { restoreDailyView, saveDailyView } from '../src/guessr/daily-progress';
import { newClueProgress, maximumScore } from '../src/guessr/rules';

it('retains exploration costs and the pin across reloads without carrying them into another round or dataset', () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const daily = { id: 'daily-attempt', round: 0, version: 'image-version', bounds: { x: -2000, y: -2000, width: 4000, height: 4000 },
    clue: { frames: [{ image: '/fixture.webp', x: -1200, y: -600, width: 2400, height: 1200 }] } };
  const progress = { ...newClueProgress(), level: 2, widest: 3, travelSpent: 100 };
  saveDailyView(store, daily, progress, { x: 12, y: 34 });
  const restored = restoreDailyView(store, daily);
  expect(restored.guess).toEqual({ x: 12, y: 34 });
  expect(maximumScore(restored.progress)).toBe(maximumScore(progress));
  expect(restoreDailyView(store, { ...daily, round: 1 })).toEqual({ progress: newClueProgress(), guess: null });
  expect(restoreDailyView(store, { ...daily, version: 'other' }).guess).toBeNull();
});
