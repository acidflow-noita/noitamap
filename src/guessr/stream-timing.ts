import type { StreamGame } from './stream-types';
import { streamsAhead } from './match-settings';

export const STREAM_DEFAULT_SECONDS = 90;
export const STREAM_START_COUNTDOWN_MS = 3000;
// Hidden tolerance for the send queue/API/EventSub notification. The visible
// deadline never moves. Only Twitch's timestamp is used, never a claimed click time.
export const STREAM_SUBMISSION_GRACE_MS = 2000;
export const STREAM_DELIVERY_GRACE_MS = 5000;
export const STREAM_RESULTS_HOLD_MS = 30000;
export const STREAM_EARLY_CLOSE_MS = 5000;

export interface ChatRoundWindow { opensAt: number; closesAt: number | null; closed: boolean }
export interface StreamTiming {
  seconds: number;
  phase: 'lobby' | 'warmup' | 'play';
  startsAt: number;
  deadline: number | null;
  resultsUntil?: number;
  chatRound: number | null;
  windows: (ChatRoundWindow | null)[];
  suspendedAt: number | null;
  lastActiveAt: number;
  revision: number;
  waitingFor?: string[];
  enrolled?: number;
  early?: boolean;
}
export function validStreamSeconds(value: number): boolean {
  return value === 0 || Number.isInteger(value) && value >= 15 && value <= 600;
}
export function startStreamTiming(game: StreamGame, seconds = STREAM_DEFAULT_SECONDS, now = game.session.serverNow, lobby = false): void {
  if (!validStreamSeconds(seconds)) throw Error('Choose a round duration between 15 and 600 seconds.');
  game.timing = { seconds, phase: lobby ? 'lobby' : streamsAhead(game.session) ? 'warmup' : 'play', startsAt: now + STREAM_START_COUNTDOWN_MS,
    deadline: !lobby && seconds ? now + STREAM_START_COUNTDOWN_MS + seconds * 1000 : null,
    chatRound: 0, windows: game.session.rounds.map(() => null), suspendedAt: null, lastActiveAt: now, revision: 1 };
  if (!lobby) { game.openedAt = game.timing.startsAt; openChatWindow(game); }
}
export function beginStreamTiming(game: StreamGame, now: number): void {
  const timing = game.timing!;
  if (timing.phase !== 'lobby' || game.paused) return;
  timing.phase = streamsAhead(game.session) ? 'warmup' : 'play'; timing.startsAt = now + STREAM_START_COUNTDOWN_MS;
  timing.deadline = timing.seconds ? timing.startsAt + timing.seconds * 1000 : null;
  game.openedAt = timing.startsAt;
  timing.lastActiveAt = now; timing.revision++; openChatWindow(game);
}
function openChatWindow(game: StreamGame): void {
  const timing = game.timing!;
  timing.waitingFor = Object.keys(game.joinedPlayers ?? {}).filter(id => id !== game.session.host.id);
  timing.enrolled = timing.waitingFor.length; timing.early = false;
  if (timing.chatRound !== null) timing.windows[timing.chatRound] = {
    opensAt: timing.startsAt, closesAt: timing.deadline, closed: false,
  };
}
/** The roster is fixed when a round opens. The original deadline still handles
 * absent players; late joins participate normally and enroll in the next round. */
export function shortenFinishedWindow(game: StreamGame, now: number): boolean {
  const timing = game.timing;
  if (!timing?.seconds || timing.deadline === null || timing.phase === 'lobby' || timing.early || game.paused
    || game.joinedOverflow || !timing.enrolled || timing.waitingFor?.length || timing.chatRound === null
    || now < timing.startsAt || timing.phase === 'play' && game.stage !== 'reveal'
      && !(game.stage === 'closing' && (!streamsAhead(game.session) || game.session.mode === 'pvp'))) return false;
  const deadline = Math.max(now + (game.session.mode === 'pvp' ? 0 : STREAM_EARLY_CLOSE_MS), timing.resultsUntil ?? now);
  if (deadline >= timing.deadline) return false;
  timing.deadline = deadline; timing.early = true; timing.revision++;
  timing.windows[timing.chatRound]!.closesAt = deadline;
  return true;
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
/** The persisted schedule chooses the same round or chat one round ahead. */
export function startHostWindow(game: StreamGame, now: number): void {
  const timing = game.timing!;
  closeChatWindow(game, now);
  timing.phase = 'play'; timing.startsAt = now + STREAM_START_COUNTDOWN_MS;
  timing.resultsUntil = undefined;
  timing.deadline = timing.seconds ? timing.startsAt + timing.seconds * 1000 : null;
  const chatRound = game.round + (streamsAhead(game.session) ? 1 : 0);
  timing.chatRound = chatRound < game.session.rounds.length ? chatRound : null;
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
  if (window.closesAt !== null && (sentAt > window.closesAt + STREAM_SUBMISSION_GRACE_MS
    || receivedAt > window.closesAt + STREAM_DELIVERY_GRACE_MS)) return false;
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
  if (!game.paused) return;
  // A transport interruption must not grant extra playing time. Keep absolute
  // deadlines across F5/reconnect, and repair saves extended by the old code.
  if (timing.deadline !== null && timing.seconds)
    timing.deadline = Math.min(timing.deadline, timing.startsAt + timing.seconds * 1000);
  if (timing.resultsUntil)
    timing.resultsUntil = Math.min(timing.resultsUntil, now + STREAM_RESULTS_HOLD_MS);
  const window = timing.chatRound === null ? null : timing.windows[timing.chatRound];
  if (window && !window.closed && window.closesAt !== null && timing.seconds)
    window.closesAt = Math.min(window.closesAt, window.opensAt + timing.seconds * 1000, timing.deadline ?? Infinity);
  timing.suspendedAt = null; timing.lastActiveAt = now; timing.revision++;
  game.paused = false;
}
export type StreamTick = 'warmup-finished' | 'submit' | 'advance' | 'finish' | null;
/** A submitted host guess does not release a still-open shared round. */
export function streamRevealAt(game: StreamGame, now: number): number {
  if (game.session.mode === 'pvp' && game.timing) {
    const index = game.timing.chatRound;
    if (index === null || game.participants.length === 2 && game.participants[1].guesses[index]) return now;
    return Math.max(now, (game.timing.deadline ?? now) + STREAM_DELIVERY_GRACE_MS);
  }
  const closesAt = game.timing?.windows[game.round]?.closesAt;
  return closesAt == null ? now : Math.max(now, closesAt + STREAM_DELIVERY_GRACE_MS);
}
export function streamTick(game: StreamGame, now: number): StreamTick {
  const timing = game.timing;
  if (!timing || timing.phase === 'lobby' || game.paused || game.stage === 'complete') return null;
  timing.lastActiveAt = now;
  // Closing chat's window and holding the host's results are separate events.
  if (timing.deadline !== null && now >= timing.deadline) closeChatWindow(game, timing.deadline);
  if (game.stage === 'closing') return null;
  if (game.stage === 'reveal' && timing.resultsUntil && now < timing.resultsUntil) return null;
  if (game.stage === 'reveal' && game.round === game.session.rounds.length - 1) return 'finish';
  if (timing.deadline === null || now < timing.deadline) return null;
  if (timing.phase === 'warmup') return 'warmup-finished';
  if (game.stage === 'guess') return 'submit';
  return game.stage === 'reveal' ? 'advance' : null;
}
