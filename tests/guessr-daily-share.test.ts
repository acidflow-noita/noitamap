import { describe, expect, it } from 'vitest';
import type { RankedState } from '../src/guessr/api';
import { dailyShareData, dailyShareFilename } from '../src/guessr/daily-share-data';
import { dailyShareLabels } from '../src/guessr/daily-share-image';

function result(): RankedState {
  return { day: '2026-11-08', status: 'complete', totalRounds: 10, score: 40404,
    results: Array.from({ length: 10 }, (_, ordinal) => ({ ordinal,
      guess: { score: ordinal === 0 ? 0 : ordinal === 1 ? 404 : 5000 },
    })) } as RankedState;
}
const tr = (source: string, values: Record<string, string | number> = {}) => source.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name]));

it('exports only the challenge date and ten ordered scores, detached from the original result', () => {
  const state = result();
  for (const key of ['id', 'challengeId', 'title', 'image', 'clue', 'config', 'bounds'])
    Object.defineProperty(state, key, { get: () => { throw Error('Private field accessed'); } });
  for (const row of state.results!) {
    for (const key of ['answer', 'name', 'biome', 'seed', 'image', 'clue'])
      Object.defineProperty(row, key, { get: () => { throw Error('Location accessed'); } });
    Object.defineProperty(row.guess, 'x', { get: () => { throw Error('Coordinates accessed'); } });
  }
  state.results!.reverse();
  const data = dailyShareData(state)!;
  expect(data).toEqual({ day: '2026-11-08', total: 40404, scores: [0, 404, ...Array(8).fill(5000)] });
  state.results![0].guess!.score = 1;
  expect(data.scores[9]).toBe(5000);
  expect(Object.isFrozen(data.scores)).toBe(true);
  expect(dailyShareFilename(data)).toBe('noitaguessr-daily-2026-11-08.png');
});

it('preserves a missed round as zero, without treating partial data as a finished result', () => {
  const state = result(); state.results![0].guess = null;
  expect(dailyShareData(state)!.scores[0]).toBe(0);
  state.results!.pop(); expect(dailyShareData(state)).toBeNull();
});

describe('refuses invalid share data', () => {
  it.each(['active', 'expired'] as const)('%s game', status => {
    expect(dailyShareData({ ...result(), status })).toBeNull();
  });
  it.each(['2026-02-30', '2026-11-08T00:00:00Z', '../secret', 'invalid'])('date %s', day => {
    expect(dailyShareData({ ...result(), day })).toBeNull();
  });
  it.each([-1, 5001, 1.5, NaN, Infinity])('score %s', score => {
    const state = result(); state.results![0].guess!.score = score;
    expect(dailyShareData(state)).toBeNull();
  });
  it('rejects duplicate ordinals, unknown rounds and a mismatching total', () => {
    const duplicate = result(); duplicate.results![9].ordinal = 0;
    expect(dailyShareData(duplicate)).toBeNull();
    const wrongRound = result(); wrongRound.results![9].ordinal = 10;
    expect(dailyShareData(wrongRound)).toBeNull();
    expect(dailyShareData({ ...result(), score: 50000 })).toBeNull();
    expect(dailyShareData({ ...result(), totalRounds: 5 })).toBeNull();
  });
});

it('uses the UTC challenge date and localized score formatting with a 50,000 maximum', () => {
  const data = dailyShareData(result())!;
  const en = dailyShareLabels(data, 'en-US', tr), de = dailyShareLabels(data, 'de', tr);
  expect(en.date).toBe('November 8, 2026'); expect(de.date).toBe('8. November 2026');
  expect(en.total).toBe('40,404'); expect(de.total).toBe('40.404');
  expect(en.maximum).toBe('out of 50,000');
  expect(en.rounds.map(row => row.label)).toEqual(Array.from({ length: 10 }, (_, i) => `Round ${i + 1}`));
});
