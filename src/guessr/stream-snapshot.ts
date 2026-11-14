import { encodeViewerClue } from './viewer-clue';
import type { StreamGame } from './stream-types';
import type { LiveRoomView } from './live-room-types';
import { streamsAhead } from './match-settings';

const clueCache = new WeakMap<StreamGame['session'], Map<number, string>>();
export function streamClue(game: StreamGame, round: number, imageRoot: string): string {
  let clues = clueCache.get(game.session);
  if (!clues) { clues = new Map(); clueCache.set(game.session, clues); }
  if (!clues.has(round)) clues.set(round, encodeViewerClue({ source: game.session.rounds[round].clue, round: round + 1,
    camera: { dx: 0, dy: 0, level: 0 }, assistance: { widest: 0, travelSpent: 0 }, version: game.session.version },
    { imageRoot, version: game.session.version }));
  return clues.get(round)!;
}
/** Shared public projection. It never includes host tokens or future answers. */
export function streamSnapshot(game: StreamGame, imageRoot: string, ended = false): LiveRoomView {
  const timing = game.timing!;
  const round = timing.chatRound ?? game.session.rounds.length - 1;
  const window = timing.windows[round];
  return { schema: 1, streaming: streamsAhead(game.session), channel: game.session.host.login, hostId: game.session.host.id, hostPro: 'active',
    gameId: game.session.id, revision: timing.revision,
    phase: ended || timing.phase === 'lobby' ? 'waiting' : game.stage === 'complete' ? 'complete' : window?.closed ? 'reveal' : 'guess',
    online: !ended && !game.paused, paused: ended || game.paused, ...(ended ? { ended: true } : {}),
    round: round + 1, totalRounds: game.session.rounds.length, roundId: game.session.rounds[round].id,
    clue: timing.phase === 'lobby' || ended ? null : streamClue(game, round, imageRoot), expiresAt: game.session.expiresAt,
    ...(game.session.rounds[round].difficultyTier ? { difficultyTier: game.session.rounds[round].difficultyTier } : {}),
    ...(game.published ? { resultId: game.session.id } : {}),
    timing: { phase: timing.phase, startsAt: window?.opensAt ?? timing.startsAt,
      deadline: timing.chatRound === null ? null : window?.closesAt ?? timing.deadline,
      chatRound: timing.chatRound === null ? null : timing.chatRound + 1,
      hostRound: game.round + 1, seconds: timing.seconds, recovery: 1,
      ...(timing.resultsUntil ? { resultsUntil: timing.resultsUntil } : {}), ...(timing.early ? { early: true } : {}),
      revealed: game.reveals.reduce((mask, reveal, i) => reveal ? mask | 1 << i : mask, 0) } };
}
