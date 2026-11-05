import type { LiveRoomGame, LiveRoomView } from './live-room-types.ts';
import { STREAM_MAX_DOCUMENT_BYTES, STREAM_MAX_PLAYERS, STREAM_ROUNDS, type StreamPlayer, type StreamPublishedResult, type StreamRoundOutcome } from './stream-types.ts';
import { rankStreamPlayers } from './stream-ranking.ts';
import type { Point } from './rules.ts';

export const LIVE_ROOM_HOST_TIMEOUT_MS = 150_000;
export const LIVE_ROOM_MAX_VIEWERS = 1_500;
const MAX_LIFETIME_MS = 31 * 24 * 60 * 60 * 1_000;
// Game tickets last at most 20 minutes, with the verifier's 30-second clock skew.
const MAX_PRO_PROOF_FUTURE_MS = 1_230_000;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export const liveRoomChannelPattern = /^[a-z0-9_]{1,25}$/;

/** Private, serializable coordinator state. Never send this object to viewers. */
export interface LiveRoomState {
  schema: 1;
  ownerId: string;
  game: LiveRoomGame;
  revision: number;
  index: number;
  phase: 'guess' | 'reveal' | 'complete' | 'waiting';
  online: boolean;
  paused: boolean;
  lastSeen: number;
  hostProVerifiedUntil?: number;
  resultId?: string;
  outcome?: StreamRoundOutcome;
  result?: StreamPublishedResult;
}
export type LiveRoomAction =
  | { type: 'advance'; roundId: string }
  | { type: 'reveal'; roundId: string; outcome?: StreamRoundOutcome }
  | { type: 'pulse'; hostProVerifiedUntil?: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'quit' }
  | { type: 'publish'; result?: StreamPublishedResult };

export class LiveRoomError extends Error {
  constructor(public status: number, message: string) {
    // RPC reliably preserves the message, but not arbitrary Error properties.
    super(`[room:${status}] ${message}`);
    this.name = 'LiveRoomError';
  }
}
export function liveRoomErrorStatus(error: unknown): number | null {
  return error instanceof Error
    ? Number(error.message.match(/^\[room:(\d{3})\] /)?.[1]) || null
    : null;
}
export function liveRoomErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^\[room:\d{3}\] /, '')
    : 'The live room could not be updated.';
}
function fail(status: number, message: string): never {
  throw new LiveRoomError(status, message);
}
function validProProof(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= now + MAX_PRO_PROOF_FUTURE_MS;
}
function point(value: Point | null | undefined): value is Point {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}
function text(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= length;
}
function difficulty(value: unknown): boolean {
  return value === 'easy' || value === 'normal' || value === 'hard';
}
function identity(value: StreamPlayer): StreamPlayer {
  if (!value || typeof value.id !== 'string' || !/^\d{1,30}$/.test(value.id)
    || typeof value.login !== 'string' || !/^[a-z0-9_]{1,25}$/.test(value.login)
    || !text(value.name, 48)) fail(400, 'Invalid result participant.');
  return { id: value.id, login: value.login, name: value.name };
}
function score(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 5000;
}
/** Copy a strict public projection; caller-owned arrays and extra fields never enter storage. */
function copyOutcome(value: StreamRoundOutcome, roundId: string): StreamRoundOutcome {
  if (!value || value.roundId !== roundId || !point(value.answer) || !text(value.label, 160)
    || !difficulty(value.difficultyTier) || !Array.isArray(value.players)
    || value.players.length > STREAM_MAX_PLAYERS) fail(400, 'Invalid round outcome.');
  const ids = new Set<string>();
  const players = value.players.map((player) => {
    if (!player || typeof player.id !== 'string' || !/^\d{1,30}$/.test(player.id) || ids.has(player.id)
      || !score(player.score) || !score(player.areaScore) || !score(player.positionScore)
      || player.score !== player.areaScore + player.positionScore
      || player.guess !== null && !point(player.guess)
      || (player.guess === null ? player.distance !== null || player.score !== 0
        : typeof player.distance !== 'number' || !Number.isFinite(player.distance) || player.distance < 0
          || Math.abs(player.distance - Math.hypot(player.guess.x - value.answer.x, player.guess.y - value.answer.y)) > 1e-6)) {
      fail(400, 'Invalid round outcome participant.');
    }
    ids.add(player.id);
    return { id: player.id, guess: player.guess === null ? null : { x: player.guess.x, y: player.guess.y },
      score: player.score, areaScore: player.areaScore, positionScore: player.positionScore, distance: player.distance };
  });
  return { roundId, answer: { x: value.answer.x, y: value.answer.y }, label: value.label,
    difficultyTier: value.difficultyTier, players };
}
function copyResult(value: StreamPublishedResult, game: LiveRoomGame): StreamPublishedResult {
  if (!value || value.schema !== 1 || value.format !== 'compact-scores-v1' || value.id !== game.gameId
    || !text(value.version, 200) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.finishedAt)
    || value.finishedAt < value.createdAt || value.finishedAt >= game.expiresAt
    || !Array.isArray(value.rounds) || value.rounds.length !== game.rounds.length
    || !Array.isArray(value.players) || !value.players.length || value.players.length > STREAM_MAX_PLAYERS)
    fail(400, 'Invalid completed result.');
  const host = identity(value.host), ids = new Set<string>();
  const rounds = value.rounds.map((round, index) => {
    if (!round || round.id !== game.rounds[index].id || !point(round.answer)
      || !text(round.name, 160) || !difficulty(round.difficultyTier)) fail(400, 'Invalid result round.');
    return { id: round.id, answer: { x: round.answer.x, y: round.answer.y },
      name: round.name, difficultyTier: round.difficultyTier };
  });
  const players = value.players.map((player) => {
    const person = identity(player);
    if (ids.has(person.id) || !Array.isArray(player.rounds) || player.rounds.length !== rounds.length)
      fail(400, 'Invalid result participant.');
    ids.add(person.id);
    const scores = player.rounds.map((pair): [number, number] => {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(score) || pair[0] + pair[1] > 5000)
        fail(400, 'Invalid result score.');
      return [pair[0], pair[1]];
    });
    const total = scores.reduce((sum, pair) => sum + pair[0] + pair[1], 0);
    if (player.score !== total) fail(400, 'Invalid result total.');
    return { ...person, score: total, rounds: scores };
  });
  if (!ids.has(host.id) || game.hostId && game.hostId !== host.id) fail(400, 'The result host does not match this room.');
  return { schema: 1, format: 'compact-scores-v1', id: game.gameId, version: value.version,
    createdAt: value.createdAt, finishedAt: value.finishedAt, host, rounds, players: rankStreamPlayers(players) };
}
function validateGame(game: LiveRoomGame, now: number): void {
  if (!game || !liveRoomChannelPattern.test(game.channel) || !idPattern.test(game.gameId)
    || game.hostId !== undefined && (typeof game.hostId !== 'string' || !/^\d{1,30}$/.test(game.hostId))
    || game.hostProVerifiedUntil !== undefined && !validProProof(game.hostProVerifiedUntil, now)
    || !Number.isSafeInteger(game.expiresAt) || game.expiresAt <= now
    || game.expiresAt > now + MAX_LIFETIME_MS || !Array.isArray(game.rounds)
    || game.rounds.length !== STREAM_ROUNDS
    || new Set(game.rounds.map((round) => round.id)).size !== game.rounds.length
    || game.rounds.some((round) => !round || !idPattern.test(round.id)
      || round.difficultyTier !== undefined && !difficulty(round.difficultyTier)
      || typeof round.clue !== 'string' || !/^[a-zA-Z0-9_-]{1,2048}$/.test(round.clue))) {
    fail(400, 'Invalid live game.');
  }
}

export function liveRoomView(state: LiveRoomState | null, channel: string, now: number): LiveRoomView {
  if (!state || state.game.expiresAt <= now || state.phase === 'waiting') {
    return {
      schema: 1, channel, gameId: null, revision: state?.revision ?? 0,
      hostPro: 'unknown',
      phase: 'waiting', online: false, paused: false, round: 0, roundId: null,
      clue: null, expiresAt: null,
    };
  }
  const current = state.game.rounds[state.index];
  const proof = state.hostProVerifiedUntil;
  return {
    schema: 1, channel: state.game.channel, gameId: state.game.gameId,
    ...(state.game.hostId ? { hostId: state.game.hostId } : {}),
    hostPro: validProProof(proof, now) && proof > now ? 'active' : 'unknown',
    ...(proof === undefined ? {} : { hostProVerifiedUntil: proof }),
    revision: state.revision, phase: state.phase,
    online: state.online && now < state.lastSeen + LIVE_ROOM_HOST_TIMEOUT_MS,
    paused: state.paused, round: state.index + 1,
    roundId: current.id, clue: current.clue, expiresAt: state.game.expiresAt,
    ...(current.difficultyTier ? { difficultyTier: current.difficultyTier } : {}),
    ...(state.resultId ? { resultId: state.resultId } : {}),
    ...(state.phase !== 'guess' && state.outcome ? { outcome: state.outcome } : {}),
    ...(state.phase === 'complete' && state.result ? { result: state.result } : {}),
  };
}

export function startLiveRoom(state: LiveRoomState | null, ownerId: string, game: LiveRoomGame, now: number): LiveRoomState {
  if (!ownerId || ownerId.length > 200) fail(400, 'Invalid room owner.');
  validateGame(game, now);
  if (state && state.game.channel !== game.channel) fail(409, 'This room belongs to another channel.');
  if (state?.game.gameId === game.gameId) {
    if (state.ownerId !== ownerId) fail(403, 'This game belongs to another host.');
    if (state.game.expiresAt <= now || state.phase === 'waiting') fail(410, 'This game has expired.');
    if (JSON.stringify(state.game) !== JSON.stringify(game)) fail(409, 'This game already exists.');
    return state;
  }
  if (state && state.game.expiresAt > now && state.ownerId !== ownerId) {
    fail(403, 'This room belongs to another host.');
  }
  return {
    schema: 1, ownerId,
    // Copy caller-owned arrays to keep the pure core safe for the local adapter.
    game: { ...game, rounds: game.rounds.map(({ id, clue, difficultyTier }) => ({ id, clue, ...(difficultyTier ? { difficultyTier } : {}) })) },
    revision: (state?.revision ?? 0) + 1,
    index: 0, phase: 'guess', online: true, paused: false, lastSeen: now,
    ...(game.hostProVerifiedUntil === undefined ? {} : { hostProVerifiedUntil: game.hostProVerifiedUntil }),
  };
}

export function transitionLiveRoom(
  state: LiveRoomState | null, ownerId: string, gameId: string,
  action: LiveRoomAction, now: number,
): LiveRoomState {
  if (!state || state.game.gameId !== gameId) fail(409, 'This game is no longer active.');
  if (state.ownerId !== ownerId) fail(403, 'This game belongs to another host.');
  if (action.type === 'quit') {
    if (state.phase === 'complete') fail(409, 'Completed games cannot be quit.');
    // Keep the owner/game identity as a tombstone for lost-response retries.
    // The waiting state cannot be resumed by old pulses, starts, or advances.
    if (state.phase === 'waiting') return state;
    return {
      ...state, game: { ...state.game, rounds: [] }, phase: 'waiting',
      outcome: undefined, result: undefined, resultId: undefined,
      hostProVerifiedUntil: undefined,
      online: false, paused: false, revision: state.revision + 1,
    };
  }
  if (state.game.expiresAt <= now || state.phase === 'waiting') fail(410, 'This game has expired.');
  const change = (fields: Partial<LiveRoomState>): LiveRoomState => ({
    ...state, ...fields, revision: state.revision + 1,
  });
  const publicChange = (fields: Partial<LiveRoomState>): LiveRoomState => {
    const next = change(fields);
    if (new TextEncoder().encode(JSON.stringify(liveRoomView(next, state.game.channel, now))).byteLength > STREAM_MAX_DOCUMENT_BYTES)
      fail(413, 'The live result is too large. Download the complete result instead.');
    return next;
  };
  switch (action.type) {
    case 'pulse': {
      if (action.hostProVerifiedUntil !== undefined && !validProProof(action.hostProVerifiedUntil, now))
        fail(400, 'Invalid host Pro proof expiry.');
      const proof = action.hostProVerifiedUntil === undefined ? state.hostProVerifiedUntil
        : Math.max(state.hostProVerifiedUntil ?? 0, action.hostProVerifiedUntil);
      const proofChanged = proof !== state.hostProVerifiedUntil;
      if (state.phase === 'complete') return proofChanged ? change({ hostProVerifiedUntil: proof }) : state;
      return {
        ...state, online: true, lastSeen: now,
        hostProVerifiedUntil: proof,
        revision: state.revision + (proofChanged || !state.online || now >= state.lastSeen + LIVE_ROOM_HOST_TIMEOUT_MS ? 1 : 0),
      };
    }
    case 'pause':
      if (state.phase !== 'guess') fail(409, 'This round is already closed.');
      return state.paused === action.paused ? state : change({ paused: action.paused });
    case 'reveal':
      if (state.game.rounds[state.index].id !== action.roundId) fail(409, 'This round is no longer active.');
      if (state.phase === 'reveal' || state.phase === 'complete') return state;
      if (state.phase !== 'guess') fail(409, 'This round is already closed.');
      return publicChange({ phase: 'reveal', paused: false,
        outcome: action.outcome ? copyOutcome(action.outcome, action.roundId) : undefined });
    case 'advance': {
      const from = state.game.rounds.findIndex((round) => round.id === action.roundId);
      if ((from === state.index - 1 && from >= 0)
        || (from === state.index && state.phase === 'complete')) return state;
      if (from !== state.index || state.phase !== 'reveal') fail(409, 'Reveal the current round before advancing.');
      if (state.index === state.game.rounds.length - 1) return change({ phase: 'complete', paused: false });
      return change({ index: state.index + 1, phase: 'guess', paused: false, outcome: undefined });
    }
    case 'publish':
      if (state.phase !== 'complete') fail(409, 'Finish the game before publishing its result.');
      if (state.result || state.resultId && !action.result) return state;
      return publicChange({ resultId: gameId, result: action.result ? copyResult(action.result, state.game) : undefined });
  }
}

/** Alarm-driven transitions: no periodic timers or viewer pings are needed. */
export function expireLiveRoom(state: LiveRoomState | null, now: number): LiveRoomState | null {
  if (!state || state.phase === 'waiting') return state;
  if (state.game.expiresAt <= now) {
    return {
      ...state, game: { ...state.game, rounds: [] }, phase: 'waiting',
      outcome: undefined, result: undefined,
      hostProVerifiedUntil: undefined,
      online: false, paused: false, revision: state.revision + 1,
    };
  }
  if (state.online && now >= state.lastSeen + LIVE_ROOM_HOST_TIMEOUT_MS) {
    return { ...state, online: false, revision: state.revision + 1 };
  }
  return state;
}

export function nextLiveRoomAlarm(state: LiveRoomState | null, now: number): number | null {
  if (!state || state.phase === 'waiting') return null;
  return Math.max(now + 1, Math.min(
    state.game.expiresAt,
    state.online ? state.lastSeen + LIVE_ROOM_HOST_TIMEOUT_MS : Infinity,
  ));
}
