import { describe, expect, it } from 'vitest';
import { DAILY_ANSWERS_PREFIX, hasViewedDailyAnswers, rememberDailyAnswers } from '../src/guessr/daily-answer-view';
import { DAILY_RESUME_KEY, readDailyResume, rememberDailyResume } from '../src/guessr/resume-progress';
import type { RankedState } from '../src/guessr/api';

function savedStorage(values = new Map<string, string>()) {
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('browser-local Daily answer viewing', () => {
  it('survives a new storage wrapper and only restricts the viewed date', () => {
    const storage = savedStorage();
    expect(hasViewedDailyAnswers('2026-11-11', storage)).toBe(false);
    rememberDailyAnswers('2026-11-11', storage);
    const refreshed = savedStorage(storage.values);
    expect(hasViewedDailyAnswers('2026-11-11', refreshed)).toBe(true);
    expect(hasViewedDailyAnswers('2026-11-12', refreshed)).toBe(false);
    expect(storage.values).toEqual(new Map([[DAILY_ANSWERS_PREFIX + '2026-11-11', '1']]));
  });
  it('keeps the current tab restricted if persistence fails', () => {
    const storage = { getItem: () => { throw Error('Storage blocked'); }, setItem: () => { throw Error('Storage blocked'); } };
    expect(() => rememberDailyAnswers('2026-11-11', storage)).toThrow();
    expect(hasViewedDailyAnswers('2026-11-11', storage)).toBe(true);
  });
  it('restores a ten-round bookmark and removes it on completion, rejecting obsolete five-round bookmarks', () => {
    const storage = savedStorage();
    const active = { id: 'ten-rounds', day: '2026-11-11', status: 'active', round: 7, totalRounds: 10, submitted: [0, 1, 2, 3, 4, 5, 6] } as RankedState;
    rememberDailyResume(active, storage);
    expect(readDailyResume(storage)).toMatchObject({ id: active.id, round: 7, totalRounds: 10 });
    rememberDailyResume({ ...active, status: 'complete' }, storage);
    expect(storage.values.has(DAILY_RESUME_KEY)).toBe(false);
    storage.setItem(DAILY_RESUME_KEY, JSON.stringify({ id: active.id, day: active.day, totalRounds: 5, round: 0, completedRounds: 0 }));
    expect(readDailyResume(storage)).toBeNull();
  });
});
