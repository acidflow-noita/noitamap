import type { StreamGame } from './stream-types';

export const STREAM_LIVE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const GAME_UNAVAILABLE_MESSAGE = 'This game is no longer active.';

/** Completed results remain recoverable. A live server-owned session does not
 * survive the coordinator's retention deadline merely because it was cached. */
export function hostSessionExpired(game: StreamGame, now = Date.now()): boolean {
  if (game.stage === 'complete' || game.session.transport !== 'parallel') return false;
  const created = game.session.createdAt;
  const offset = Number.isFinite(game.clockOffset) ? game.clockOffset : 0;
  return !Number.isFinite(created) || now + offset >= created + STREAM_LIVE_RETENTION_MS;
}
