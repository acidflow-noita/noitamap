import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { gameDatabase } from './helpers/guessr-database';
import {
  gameAvailability,
  gameRequests,
  noteRoundsLeft,
  releaseFinish,
  reserveFinish,
  seatRequests,
} from '../workers/noitamap-guessr/src/capacity';
import { utcStart, DAY_MS, WORKER_FREE_REQUESTS } from '../workers/noitamap-guessr/src/capacity-policy';
import type { Env } from '../workers/noitamap-guessr/src/index';

const now = Date.UTC(2026, 10, 26, 15, 0),
  cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const f = gameDatabase();
  cleanup.push(f.close);
  for (const file of ['0002_stream_results', '0010_stream_game_admission', '0013_game_capacity'])
    f.sqlite.exec(readFileSync('workers/noitamap-guessr/migrations/' + file + '.sql', 'utf8'));
  const env = { DB: f.db, GAME_CAPACITY_GUARD: 'account' } as Env;
  function sample(at: number, through: number, used: number, background = 0, peak = 0) {
    f.sqlite
      .prepare(
        'UPDATE guessr_capacity SET day_start=?,measured_through=?,checked_at=?,used_requests=?,background_requests=?,peak_per_minute=? WHERE id=1'
      )
      .run(utcStart(at), through, at, used, background, peak);
  }
  const held = () => f.sqlite.prepare('SELECT held_requests AS n FROM guessr_capacity').get()!.n;
  return { ...f, env, sample, held };
}
it('counts remaining requests, including activity on the account, and admits only one competing room into the final space', async () => {
  const f = fixture(),
    cost = gameRequests('pvp', 3);
  // A minute of reporting delay and three minutes to the next check at five requests/minute.
  f.sample(now, now - 60000, WORKER_FREE_REQUESTS - cost - 20 - 350, 350, 5);
  const attempts = await Promise.allSettled(
    ['first', 'second'].map(id => reserveFinish(f.env, id, '', cost, now + DAY_MS, now))
  );
  expect(attempts.map(a => a.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(f.held()).toBe(cost);
  expect(await gameAvailability(f.env, now)).toEqual({ state: 'paused', retryAt: utcStart(now) + DAY_MS });
  const existing = attempts[0].status === 'fulfilled' ? 'first' : 'second';
  await expect(reserveFinish(f.env, existing, '', cost, now + DAY_MS, now)).resolves.toBeUndefined();
  await releaseFinish(f.env, existing, now + 1);
  expect(f.held()).toBe(cost);
  f.sample(now + 120000, now, 1000);
  expect(f.held()).toBe(cost);
  f.sample(now + 180000, now + 1, 1000);
  expect(f.held()).toBe(0);
});
it('accounts for late chatters individually and gives back completed rounds only after measured usage covers them', async () => {
  const f = fixture();
  f.sample(now, now, 500);
  await reserveFinish(f.env, 'match', '', gameRequests('stream', 10), now + DAY_MS, now);
  for (let i = 0; i < 69; i++)
    await reserveFinish(f.env, 'match', String(100 + i), seatRequests(10), now + DAY_MS, now);
  expect(f.held()).toBe(2 + 70 * seatRequests(10));
  await noteRoundsLeft(f.env, 'match', 'stream', 2, now + 7000);
  await reserveFinish(f.env, 'match', 'later', seatRequests(2), now + DAY_MS, now + 8000);
  f.sample(now + 15000, now + 5000, 580);
  expect(f.held()).toBe(2 + 70 * seatRequests(10) + seatRequests(2));
  f.sample(now + 20000, now + 10000, 620);
  expect(f.held()).toBe(71 * seatRequests(2));
});
it('fails closed for new starts without a recent account reading, carries active games across midnight and has no global game count', async () => {
  const f = fixture(),
    day = utcStart(now);
  await expect(reserveFinish(f.env, 'early', '', 10, now + DAY_MS, now)).rejects.toMatchObject({ scope: 'checking' });
  f.sample(now, now, 500);
  for (let i = 0; i < 125; i++) await reserveFinish(f.env, String(i), '', gameRequests('demo', 3), now + DAY_MS, now);
  expect(f.held()).toBe(125 * gameRequests('demo', 3));
  await expect(reserveFinish(f.env, 'stale', '', 10, now + DAY_MS, now + 10 * 60000)).rejects.toMatchObject({
    scope: 'checking',
  });
  await expect(reserveFinish(f.env, '0', '', 10, now + DAY_MS, now + 10 * 60000)).resolves.toBeUndefined();
  f.sample(day + DAY_MS + 5000, day + DAY_MS, 0);
  expect(f.held()).toBe(125 * gameRequests('demo', 3));
  expect((await gameAvailability(f.env, day + DAY_MS + 5000)).state).toBe('open');
});
