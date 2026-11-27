import type { Database, Env } from './index';

import {
  utcStart,
  DAY_MS,
  WORKER_FREE_REQUESTS,
  MINUTE,
  MAX_AGE,
  minimumStart,
  seatRequests,
  gameRequests,
  disposition,
  type Snapshot,
  type GameAvailability,
} from './capacity-policy';
export { DAY_MS, gameRequests, seatRequests } from './capacity-policy';
export class CapacityError extends Error {
  constructor(
    readonly scope: 'starts' | 'game-size' | 'checking',
    readonly resetAt: number
  ) {
    super(
      scope === 'checking'
        ? 'New games are paused while availability is checked.'
        : scope === 'game-size'
          ? 'There is not enough capacity to start this game today.'
          : 'New games are paused to let active games finish.'
    );
  }
}
async function snapshot(db: Database): Promise<Snapshot | null> {
  return db.prepare('SELECT * FROM guessr_capacity WHERE id=1').first<Snapshot>();
}
export async function gameAvailability(env: Env, now: number): Promise<GameAvailability> {
  if (env.GAME_CAPACITY_GUARD !== 'account') return { state: 'open', retryAt: now + MINUTE };
  let s: Snapshot | null;
  try {
    s = await snapshot(env.DB);
  } catch {
    s = null;
  }
  return disposition(s, now);
}
export function capacityResponse(error: CapacityError, now: number): Response {
  return Response.json(
    { error: error.message, quota: error.scope, resetAt: error.resetAt },
    {
      status: error.scope === 'checking' ? 503 : 429,
      headers: {
        'Cache-Control': 'no-store',
        'X-Guessr-Daily-Quota': error.scope,
        'X-Guessr-Reset-At': String(error.resetAt),
        'Retry-After': String(Math.max(1, Math.ceil((error.resetAt - now) / 1000))),
      },
    }
  );
}
/** D1 serializes this INSERT and its accounting trigger. Different isolates cannot both claim the same headroom. */
export async function reserveFinish(
  env: Env,
  game: string,
  seat: string,
  requests: number,
  expires: number,
  now: number
): Promise<void> {
  if (env.GAME_CAPACITY_GUARD !== 'account') return;
  const day = utcStart(now);
  try {
    const added = await env.DB.prepare(
      `INSERT INTO guessr_finish_holds(game,seat,requests,release_after)
      SELECT ?,?,?,? FROM guessr_capacity WHERE id=1 AND day_start=? AND paused_until<=?
      AND NOT EXISTS (SELECT 1 FROM guessr_finish_holds WHERE game=? AND seat='legacy')
      AND checked_at BETWEEN ? AND ? AND measured_through BETWEEN max(?,?) AND checked_at
      AND used_requests+background_requests+held_requests+?+
          peak_per_minute*CAST((max(0,?-measured_through)+?+? - 1)/? AS INTEGER)<=?
      ON CONFLICT(game,seat) DO NOTHING RETURNING game`
    )
      .bind(
        game,
        seat,
        requests,
        expires,
        day,
        now,
        game,
        now - MAX_AGE,
        now + 1000,
        day,
        now - 2 * MAX_AGE,
        requests,
        now,
        MAX_AGE,
        MINUTE,
        MINUTE,
        WORKER_FREE_REQUESTS
      )
      .first();
    if (
      added ||
      (await env.DB.prepare("SELECT game FROM guessr_finish_holds WHERE game=? AND seat IN (?,'legacy')")
        .bind(game, seat)
        .first())
    )
      return;
    const status = await gameAvailability(env, now);
    if (status.state === 'checking') throw new CapacityError('checking', status.retryAt);
    if (status.state === 'paused') {
      // Once the smallest new match cannot fit, all starts share the advertised UTC reopening time.
      await env.DB.prepare(
        `UPDATE guessr_capacity SET paused_until=? WHERE id=1 AND day_start=? AND
        used_requests+background_requests+held_requests+?+peak_per_minute*CAST((max(0,?-measured_through)+?+?-1)/? AS INTEGER)>?`
      )
        .bind(day + DAY_MS, day, minimumStart, now, MAX_AGE, MINUTE, MINUTE, WORKER_FREE_REQUESTS)
        .run();
      throw new CapacityError('starts', day + DAY_MS);
    }
    throw new CapacityError('game-size', day + DAY_MS);
  } catch (error) {
    if (error instanceof CapacityError) throw error;
    throw new CapacityError('checking', now + MINUTE);
  }
}
/** Released work is kept charged until an account observation covers its final requests. */
export async function releaseFinish(env: Env, game: string, now: number): Promise<void> {
  if (env.GAME_CAPACITY_GUARD === 'account')
    await env.DB.prepare('UPDATE guessr_finish_holds SET release_after=min(release_after,?) WHERE game=?')
      .bind(now, game)
      .run();
}
export async function cancelFinish(env: Env, game: string, seat: string): Promise<void> {
  if (env.GAME_CAPACITY_GUARD === 'account')
    await env.DB.prepare('UPDATE guessr_finish_holds SET release_after=0 WHERE game=? AND seat=?')
      .bind(game, seat)
      .run();
}

/** One update per round, independent of audience size. Hold the credit until a usage sample covers this point. */
export async function noteRoundsLeft(
  env: Env,
  game: string,
  mode: 'stream' | 'pvp' | 'demo',
  left: number,
  now: number
): Promise<void> {
  if (env.GAME_CAPACITY_GUARD !== 'account' || left < 1) return;
  const perSeat = seatRequests(left);
  await env.DB.prepare(
    `INSERT INTO guessr_capacity_progress(game,credit,at)
    SELECT game,max(0,sum(requests) - CASE WHEN ?='stream' THEN count(*)*? WHEN ?='pvp' THEN 2*? ELSE ? END),?
    FROM guessr_finish_holds WHERE game=? GROUP BY game HAVING sum(seat='legacy')=0
    ON CONFLICT(game) DO UPDATE SET credit=max(credit,excluded.credit),at=max(at,excluded.at)`
  )
    .bind(mode, perSeat, mode, perSeat, gameRequests('demo', left), now, game)
    .run();
}
