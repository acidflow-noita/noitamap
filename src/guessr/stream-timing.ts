import type { StreamGame } from './stream-types';

export const STREAM_DEFAULT_SECONDS = 90;
export const STREAM_START_COUNTDOWN_MS = 3000;
export const STREAM_DELIVERY_GRACE_MS = 5000;
export const STREAM_RESULTS_HOLD_MS = 8000;

export interface ChatRoundWindow { opensAt: number; closesAt: number | null; closed: boolean }
export interface StreamTiming {
  seconds: number;
  phase: 'warmup' | 'play';
  startsAt: number;
  deadline: number | null;
  resultsUntil?: number;
  chatRound: number | null;
  windows: (ChatRoundWindow | null)[];
  suspendedAt: number | null;
  lastActiveAt: number;
  revision: number;
}
export function validStreamSeconds(value: number): boolean {
  return value === 0 || Number.isInteger(value) && value >= 15 && value <= 600;
}
export function startStreamTiming(game: StreamGame, seconds = STREAM_DEFAULT_SECONDS, now = game.session.serverNow): void {
  if (!validStreamSeconds(seconds)) throw Error('Choose a round duration between 15 and 600 seconds.');
  game.timing = { seconds, phase: 'warmup', startsAt: now + STREAM_START_COUNTDOWN_MS,
    deadline: seconds ? now + STREAM_START_COUNTDOWN_MS + seconds * 1000 : null,
    chatRound: 0, windows: game.session.rounds.map(() => null), suspendedAt: null, lastActiveAt: now, revision: 1 };
  openChatWindow(game);
}
function openChatWindow(game: StreamGame): void {
  const timing = game.timing!;
  if (timing.chatRound !== null) timing.windows[timing.chatRound] = {
    opensAt: timing.startsAt, closesAt: timing.deadline, closed: false,
  };
}
/** Close the chatter's current round without revealing its solution. */
export function closeChatWindow(game: StreamGame, now: number): void {
  const timing = game.timing;
  if (!timing || timing.chatRound === null) return;
  const window = timing.windows[timing.chatRound];
  if (!window || window.closed) return;
  window.closesAt = Math.max(window.opensAt, Math.min(window.closesAt ?? now, now));
  window.closed = true; timing.revision++;
}
/** The host's current round and the chatter's next round always start together. */
export function startHostWindow(game: StreamGame, now: number): void {
  const timing = game.timing!;
  closeChatWindow(game, now);
  timing.phase = 'play'; timing.startsAt = now + STREAM_START_COUNTDOWN_MS;
  timing.resultsUntil = undefined;
  timing.deadline = timing.seconds ? timing.startsAt + timing.seconds * 1000 : null;
  timing.chatRound = game.round + 1 < game.session.rounds.length ? game.round + 1 : null;
  timing.suspendedAt = null; timing.lastActiveAt = now; timing.revision++;
  game.openedAt = timing.startsAt; game.paused = false;
  openChatWindow(game);
}
export function hostMayGuess(game: StreamGame, now: number): boolean {
  const timing = game.timing;
  return !game.paused && game.stage === 'guess' && (!timing || timing.phase === 'play'
    && now >= timing.startsAt && (timing.deadline === null || now < timing.deadline));
}
export function chatRoundAccepts(game: StreamGame, round: number, sentAt: number, receivedAt: number): boolean {
  const timing = game.timing, window = timing?.windows[round];
  if (!timing || !window || game.paused || game.reveals[round] || game.stage === 'complete') return false;
  if (sentAt < window.opensAt || sentAt > receivedAt + STREAM_DELIVERY_GRACE_MS) return false;
  if (window.closesAt !== null && (sentAt > window.closesAt || receivedAt > window.closesAt + STREAM_DELIVERY_GRACE_MS)) return false;
  return true;
}
export function suspendStreamTiming(game: StreamGame, now: number): void {
  const timing = game.timing;
  if (timing && timing.suspendedAt === null) { timing.suspendedAt = now; timing.revision++; }
  game.paused = true;
}
export function resumeStreamTiming(game: StreamGame, now: number): void {
  const timing = game.timing;
  if (!timing) { game.paused = false; return; }
  const stopped = timing.suspendedAt ?? timing.lastActiveAt;
  const gap = Math.max(0, now - stopped);
  if (timing.startsAt > stopped) timing.startsAt += gap;
  if (timing.deadline !== null) timing.deadline += gap;
  if (timing.resultsUntil && timing.resultsUntil > stopped) timing.resultsUntil += gap;
  const window = timing.chatRound === null ? null : timing.windows[timing.chatRound];
  if (window && !window.closed) {
    if (window.opensAt > stopped) window.opensAt += gap;
    if (window.closesAt !== null) window.closesAt += gap;
  }
  timing.suspendedAt = null; timing.lastActiveAt = now; timing.revision++;
  game.paused = false;
}
export type StreamTick = 'warmup-finished' | 'submit' | 'advance' | 'finish' | null;
export function streamTick(game: StreamGame, now: number): StreamTick {
  const timing = game.timing;
  if (!timing || game.paused || game.stage === 'complete') return null;
  timing.lastActiveAt = now;
  if (game.stage === 'reveal' && timing.resultsUntil && now < timing.resultsUntil) return null;
  if (game.stage === 'reveal' && game.round === game.session.rounds.length - 1) return 'finish';
  if (timing.deadline === null || now < timing.deadline) return null;
  closeChatWindow(game, timing.deadline);
  if (timing.phase === 'warmup') return 'warmup-finished';
  if (game.stage === 'guess') return 'submit';
  return game.stage === 'reveal' ? 'advance' : null;
}
