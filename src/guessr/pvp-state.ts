import type { LiveRoomView } from './live-room-types';
import type { StreamGame } from './stream-types';
import { streamsAhead } from './match-settings';
import { streamClue } from './stream-snapshot';
import { streamResult } from './stream-state';

/** Both players receive the same permission boundary. Creating the match never
 * grants access to the opponent's point, allowance or future clue. */
export function pvpSnapshot(game: StreamGame, playerId: string, imageRoot: string, ended = false): LiveRoomView {
  const timing = game.timing!, creator = playerId === game.session.host.id;
  const own = game.participants.find(p => p.id === playerId);
  const other = game.participants.find(p => p.id !== playerId);
  const round = creator ? game.round : timing.chatRound ?? game.session.rounds.length - 1;
  const active = timing.phase === 'play' ? creator || timing.chatRound !== null : timing.phase === 'warmup' && !creator;
  const otherRound = creator ? timing.chatRound : timing.phase === 'play' ? game.round : null;
  const phase = game.stage === 'complete' ? 'complete' : game.stage === 'reveal' ? 'reveal'
    : ended || timing.phase === 'lobby' || !active ? 'waiting' : 'guess';
  return { schema: 1, mode: 'pvp', streaming: streamsAhead(game.session), channel: game.session.host.login,
    hostId: game.session.host.id, hostPro: 'active', gameId: game.session.id, revision: timing.revision,
    phase, round: round + 1, roundId: game.session.rounds[round].id, totalRounds: game.session.rounds.length,
    clue: phase === 'guess' ? streamClue(game, round, imageRoot) : null,
    difficultyTier: game.session.rounds[round].difficultyTier, online: !ended, paused: false,
    ...(ended ? { ended: true } : {}), expiresAt: game.session.expiresAt,
    ...(game.published ? { resultId: game.session.id } : {}),
    ...(game.stage === 'complete' ? { result: streamResult(game) } : {}),
    pvp: { creator, active, locked: !!own?.guesses[round], opponentLocked: otherRound !== null && !!other?.guesses[otherRound],
      players: game.participants.map(p => ({ id: p.id, login: p.login, name: p.name, color: p.color })),
      ready: [...game.pvp!.ready], ...(game.pvp?.concededBy ? { concededBy: game.pvp.concededBy } : {}) },
    timing: { phase: timing.phase, startsAt: timing.startsAt, deadline: timing.deadline, seconds: timing.seconds,
      hostRound: game.round + 1, chatRound: timing.chatRound === null ? null : timing.chatRound + 1,
      ...(timing.resultsUntil ? { resultsUntil: timing.resultsUntil } : {}),
      revealed: game.reveals.reduce((mask, _, i) => mask | 1 << i, 0) } };
}
