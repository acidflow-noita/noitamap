import { newStreamGame, acceptStreamGuess, closeStreamRound, revealStreamRound, advanceStreamRound, streamResult, type StreamChatMessage } from './stream-state';
import { beginStreamTiming, startHostWindow, startStreamTiming, streamTick, shortenFinishedWindow,
  STREAM_DELIVERY_GRACE_MS, STREAM_SUBMISSION_GRACE_MS } from './stream-timing';
import { emptyParallelMetrics, type ParallelInitialization, type ParallelMetrics, type ParallelSubmission } from './parallel-types';
import type { StreamGame, StreamParticipant, StreamPlayer, StreamPublishedResult, StreamReveal } from './stream-types';
import { STREAM_MAX_PLAYERS } from './stream-types';
import { streamPlayerName } from './stream-display-name';
import { formatGuessCommand, parseGuessCommand } from './guess-command';
import { within } from './rules';

export interface ParallelRecord {
  schema: 1;
  owner: string;
  game: StreamGame;
  privateReveals: StreamReveal[];
  metrics: ParallelMetrics;
  hostCommands: string[];
  ended?: boolean;
  pendingRevealAt?: number;
  publicationError?: string;
  publicationRetryAt?: number;
  publishedAt?: number;
  finalResult?: StreamPublishedResult;
}
export function createParallelRecord(input: ParallelInitialization, now: number): ParallelRecord {
  // The coordinator already holds the private solutions. Browser continuation
  // tokens are redundant here and must not inflate every durable write/snapshot.
  const session = { ...input.session, token: '', rounds: input.session.rounds.map(round => ({ ...round, token: '' })) };
  const game = newStreamGame(session, input.session.serverNow);
  game.clockOffset = 0;
  startStreamTiming(game, input.seconds, now, true);
  return { schema: 1, owner: input.owner, game, privateReveals: input.reveals,
    metrics: emptyParallelMetrics(), hostCommands: [] };
}
export function joinParallelPlayer(record: ParallelRecord, player: StreamPlayer): StreamParticipant {
  const game = record.game;
  let found = game.participants.find(p => p.id === player.id);
  const safe = { ...player, name: streamPlayerName(player.name, player.login) };
  if (found) { Object.assign(found, safe); return found; }
  if (game.participants.length >= STREAM_MAX_PLAYERS) throw Error('This game has reached its player limit.');
  found = { ...safe, guesses: game.session.rounds.map(() => null) };
  game.participants.push(found);
  if (player.id !== game.session.host.id) {
    game.joinedPlayers ??= {};
    game.joinedPlayers[player.id] = { login: safe.login, name: safe.name, color: safe.color };
  }
  return found;
}
export function directGuessMessage(record: ParallelRecord, player: StreamPlayer, input: ParallelSubmission, now: number): StreamChatMessage | null {
  const round = record.game.session.rounds.findIndex(round => round.id === input?.roundId);
  if (round < 0 || !input.point || !within(input.point, record.game.session.config.bounds)
    || !Number.isInteger(input.maximum) || input.maximum < 0 || input.maximum > 5000
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 0xffffffff
    || !/^[a-f0-9]{16}$/.test(input.nonce)) return null;
  const nonce = Uint8Array.from(input.nonce.match(/../g)!, byte => parseInt(byte, 16));
  return { player, id: input.nonce, sentAt: now,
    text: formatGuessCommand(round + 1, input.point, input.maximum, input.roundId,
      { userId: player.id, nonce, revision: input.revision, label: 'NoitaGuessr guess' }) };
}
export function acceptParallelGuess(record: ParallelRecord, message: StreamChatMessage, now: number) {
  const game = record.game;
  const command = parseGuessCommand(message.text, { rounds: game.session.rounds.length, bounds: game.session.config.bounds });
  if (!command?.nonce || !command.revision || command.userId !== message.player.id || record.ended) return { status: 'invalid' as const, command };
  const round = command.round - 1;
  const previous = game.participants.find(p => p.id === message.player.id)?.guesses[round];
  // A replay must receive its durable acknowledgement after closure too.
  if (previous?.nonce === command.nonce && previous.revision === command.revision) {
    const same = previous.point?.x === command.x && previous.point?.y === command.y && previous.maximum === command.maximum;
    return { status: same ? 'duplicate' as const : 'invalid' as const, command };
  }
  if (previous?.revision !== undefined && previous.revision >= command.revision) return { status: 'old' as const, command };
  if (!game.participants.some(p => p.id === message.player.id) && game.participants.length >= STREAM_MAX_PLAYERS) return { status: 'invalid' as const, command };
  const status = acceptStreamGuess(game, message, now);
  // Only the exact committed revision above is an accepted duplicate. A reused
  // nonce/message ID with different data must never receive a success receipt.
  if (status === 'duplicate') { record.metrics.rejected++; return { status: 'invalid' as const, command }; }
  if (status === 'accepted') {
    record.metrics.accepted++;
    if (previous) record.metrics.replacements++;
    shortenFinishedWindow(game, now);
  } else record.metrics.rejected++;
  return { status, command };
}
export function submitParallelHost(record: ParallelRecord, id: string, roundId: string, point: { x: number; y: number } | null, maximum: number, now: number, expired = false): boolean {
  const game = record.game, timing = game.timing!;
  if (record.hostCommands.includes(id)) return false;
  if (record.ended || game.stage !== 'guess' || game.session.rounds[game.round].id !== roundId || timing.phase !== 'play'
    || now < timing.startsAt || !expired && timing.deadline !== null && now > timing.deadline + STREAM_SUBMISSION_GRACE_MS
    || !Number.isInteger(maximum) || maximum < 0 || maximum > 5000 || point !== null && !within(point, game.session.config.bounds)) throw Error('This round is closed');
  closeStreamRound(game, point, now);
  game.participants[0].guesses[game.round]!.maximum = maximum;
  game.participants[0].guesses[game.round]!.messageId = id;
  record.hostCommands = [...record.hostCommands.slice(-31), id];
  record.pendingRevealAt = Math.max(now, (timing.windows[game.round]?.closesAt ?? now) + STREAM_DELIVERY_GRACE_MS);
  return true;
}
/** Shared time progression runs on object alarms, independent of browser tabs. */
export function tickParallel(record: ParallelRecord, now: number): boolean {
  const game = record.game, timing = game.timing!;
  if (record.ended || game.stage === 'complete' || timing.phase === 'lobby') return false;
  let changed = false;
  if (game.stage === 'closing' && record.pendingRevealAt !== undefined && now >= record.pendingRevealAt) {
    revealStreamRound(game, record.privateReveals[game.round], now);
    record.pendingRevealAt = undefined; shortenFinishedWindow(game, now); changed = true;
  }
  // Let browser automatic submissions arrive during the existing grace window.
  if (timing.phase === 'play' && game.stage === 'guess' && timing.deadline !== null
    && now >= timing.deadline && now < timing.deadline + STREAM_DELIVERY_GRACE_MS) return changed;
  const oldRevision = timing.revision;
  const next = streamTick(game, now);
  if (next === 'warmup-finished') { startHostWindow(game, now); changed = true; }
  else if (next === 'submit') {
    submitParallelHost(record, `timeout-${game.round}`, game.session.rounds[game.round].id, null, 5000, now, true);
    if (record.pendingRevealAt! <= now) {
      revealStreamRound(game, record.privateReveals[game.round], now); record.pendingRevealAt = undefined;
    }
    changed = true;
  } else if (next === 'advance' || next === 'finish') { advanceStreamRound(game, now); changed = true; }
  return changed || oldRevision !== timing.revision;
}
export function beginParallel(record: ParallelRecord, id: string, now: number): void {
  if (record.hostCommands.includes(id)) return;
  if (record.ended) throw Error('The streamer ended this game.');
  beginStreamTiming(record.game, now);
  record.hostCommands = [...record.hostCommands.slice(-31), id];
}
export function nextParallelAlarm(record: ParallelRecord, now: number): number | null {
  if (record.publishedAt) return record.publishedAt + 86400000;
  if (record.ended) return Math.min(record.game.session.expiresAt, now + 3600000);
  if (record.game.stage === 'complete') return record.publicationRetryAt ?? now + 1;
  if (record.pendingRevealAt !== undefined) return Math.max(now + 1, record.pendingRevealAt);
  const { game } = record, timing = game.timing!;
  if (timing.phase === 'lobby' || timing.deadline === null) return game.session.expiresAt;
  if (game.stage === 'reveal') return Math.max(now + 1, timing.resultsUntil ?? now,
    game.round === game.session.rounds.length - 1 ? now : timing.deadline);
  return Math.max(now + 1, timing.deadline + (timing.phase === 'play' ? STREAM_DELIVERY_GRACE_MS : 0));
}
export function parallelResult(record: ParallelRecord): StreamPublishedResult {
  if (record.finalResult) return record.finalResult;
  const result = streamResult(record.game);
  return record.finalResult = { ...result, format: 'compact-scores-v1', transportStats: { ...record.metrics },
    players: result.players.map(player => ({ ...player, rounds: player.rounds.map(r => [r.areaScore, r.positionScore] as [number, number]) })) };
}
