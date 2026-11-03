import { prepareAreaScorer } from "./area-rules";
import { isEncodedGuessCommand, parseGuessCommand } from "./guess-command";
import { rankStreamPlayers } from "./stream-ranking";
import { maximumScore, newClueProgress, within, type Point } from "./rules";
import { chatRoundAccepts, closeChatWindow, startHostWindow, STREAM_RESULTS_HOLD_MS } from './stream-timing';
import { twitchColor } from './player-color';
import type { LiveRoomView } from "./live-room-types";
import {
  type StreamGame,
  type StreamParticipant,
  type StreamPlayer,
  type StreamPlayerResult,
  type StreamResult,
  type StreamReveal,
  type StreamSession,
} from "./stream-types";

export function newStreamGame(
  session: StreamSession,
  now = Date.now(),
): StreamGame {
  return {
    schema: 1,
    session,
    clockOffset: session.serverNow - now,
    round: 0,
    stage: "guess",
    openedAt: session.serverNow,
    closedAt: null,
    finishedAt: null,
    clue: newClueProgress(),
    guess: null,
    paused: false,
    reveals: [],
    participants: [
      { ...session.host, guesses: session.rounds.map(() => null) },
    ],
  };
}
export function streamTime(game: StreamGame): number {
  return Date.now() + game.clockOffset;
}
export type GuessAdmission =
  "accepted" | "invalid" | "old" | "future" | "closed" | "duplicate" | "host";
export interface StreamChatMessage {
  player: StreamPlayer;
  id: string;
  text: string;
  sentAt: number;
}

/** Last valid message by Twitch timestamp wins, if received while this round is
 * open. Ties retain the first accepted message; there is no speed score/tiebreak.
 * A later replacement takes the allowance then available, never an earlier one. */
export function acceptStreamGuess(
  game: StreamGame,
  message: StreamChatMessage,
  receivedAt = streamTime(game),
): GuessAdmission {
  const command = parseGuessCommand(message.text, {
    rounds: game.session.rounds.length,
    bounds: game.session.config.bounds,
  });
  if (
    !command ||
    !/^\d{1,30}$/.test(message.player.id) ||
    !/^[a-z0-9_]{1,25}$/.test(message.player.login) ||
    !message.player.name ||
    message.player.name.length > 48 ||
    !message.id ||
    message.id.length > 100 ||
    !Number.isFinite(message.sentAt)
  )
    return "invalid";
  const index = command.round - 1;
  const current = game.timing?.chatRound ?? game.round;
  if (!game.timing && (command.round < game.round + 1 || message.sentAt < game.openedAt))
    return "old";
  if (index > current) return "future";
  // Twitch supplies the sender separately from the message text. This blocks
  // verbatim copying, not a deliberately re-encoded/forged point allowance.
  if (command.userId !== undefined && command.userId !== message.player.id) return 'invalid';
  if (game.session.live && command.roundId !== game.session.rounds[index]?.id)
    return "old";
  if (game.session.live && (!isEncodedGuessCommand(message.text) || !command.userId)) return 'invalid';
  if (game.timing ? !chatRoundAccepts(game, index, message.sentAt, receivedAt) : game.stage !== "guess" || game.paused) return "closed";
  if (message.player.id === game.session.host.id) return "host";
  let player = game.participants.find((p) => p.id === message.player.id);
  const previous = player?.guesses[index];
  const nonceKey = game.timing ? `${index}/${message.player.id}` : message.player.id;
  const savedNonces = game.recentNonces?.[nonceKey];
  const nonces = Array.isArray(savedNonces) ? savedNonces.filter(value => /^[a-f0-9]{16}$/.test(value)).slice(-64) : [];
  if (command.nonce && nonces.includes(command.nonce)) return 'duplicate';
  if (
    previous &&
    (previous.messageId === message.id || previous.sentAt >= message.sentAt || command.nonce && previous.nonce === command.nonce)
  )
    return "duplicate";
  if (!player) {
    player = {
      ...message.player,
      guesses: game.session.rounds.map(() => null),
    };
    game.participants.push(player);
  }
  player.name = message.player.name;
  player.login = message.player.login;
  if (twitchColor(message.player.color)) player.color = twitchColor(message.player.color);
  player.guesses[index] = {
    point: { x: command.x, y: command.y },
    maximum: game.timing ? command.maximum ?? 5000 : Math.min(maximumScore(game.clue), command.maximum ?? 5000),
    messageId: message.id,
    sentAt: message.sentAt,
    nonce: command.nonce,
  };
  if (game.timing?.chatRound === index && game.timing.waitingFor)
    game.timing.waitingFor = game.timing.waitingFor.filter(id => id !== message.player.id);
  if (command.nonce) {
    if (!game.recentNonces || typeof game.recentNonces !== 'object' || Array.isArray(game.recentNonces)) game.recentNonces = {};
    game.recentNonces[nonceKey] = [...nonces.slice(-63), command.nonce];
  }
  return "accepted";
}

/** Close locally before the reveal request; retries preserve the original guess. */
export function closeStreamRound(
  game: StreamGame,
  guess: Point | null,
  now = streamTime(game),
): void {
  if (game.stage === "closing") return;
  if (game.stage !== "guess" || game.paused)
    throw new Error("This round is not accepting guesses.");
  if (game.timing?.phase === 'warmup' || game.timing && now < game.timing.startsAt)
    throw new Error('Your round has not started yet.');
  if (game.timing && !game.timing.seconds) closeChatWindow(game, now);
  if (guess !== null && !within(guess, game.session.config.bounds))
    throw new Error("Place a pin inside the map.");
  game.participants[0].guesses[game.round] = {
    point: guess,
    maximum: maximumScore(game.clue),
    messageId: "host",
    sentAt: now,
  };
  game.closedAt = now;
  game.stage = "closing";
}
export function revealStreamRound(
  game: StreamGame,
  reveal: StreamReveal,
  now = streamTime(game),
): void {
  if (
    game.stage !== "closing" ||
    reveal.roundId !== game.session.rounds[game.round].id
  )
    throw new Error("This reveal belongs to another round.");
  game.reveals[game.round] = reveal;
  game.stage = "reveal";
  if (game.timing?.seconds) game.timing.resultsUntil = now + STREAM_RESULTS_HOLD_MS;
}
export function advanceStreamRound(
  game: StreamGame,
  now = streamTime(game),
): void {
  if (game.stage !== "reveal") throw new Error("Reveal this round first.");
  if (game.round + 1 === game.session.rounds.length) {
    game.stage = "complete";
    game.finishedAt = now;
  } else {
    game.round++;
    if (!game.timing) game.recentNonces = {};
    game.stage = "guess";
    game.openedAt = now;
    game.closedAt = null;
    game.clue = newClueProgress();
    game.guess = null;
    game.paused = false;
    if (game.timing) startHostWindow(game, now);
  }
}
/** Recover an acknowledged server advance whose HTTP response/browser save was
 * lost. Only advance from a locally revealed round; never skip an unseen answer. */
export function reconcileLiveRound(game: StreamGame, room: LiveRoomView): boolean {
  if (room.gameId !== game.session.id)
    throw new Error("This channel has another active game. Use its host tab to continue.");
  const next = game.session.rounds[game.round + 1];
  const advanced = game.stage === "reveal" && (
    next && room.phase === "guess" && room.roundId === next.id && room.round === game.round + 2
    || !next && room.phase === "complete" && room.roundId === game.session.rounds[game.round].id
  );
  if (advanced) advanceStreamRound(game);
  if (room.roundId !== game.session.rounds[game.round].id
    || game.stage === "guess" && room.phase !== "guess")
    throw new Error("This game was changed in another tab. Use that host tab to continue.");
  return !!advanced;
}
export function streamStandings(
  participants: StreamParticipant[],
  reveals: StreamReveal[],
): StreamPlayerResult[] {
  const scorers = reveals.map((reveal) =>
    prepareAreaScorer(reveal.area, reveal.answer),
  );
  const players = participants.map((player) => {
    const rounds = reveals.map((reveal, index) => {
      const guess = player.guesses[index];
      return {
        ...scorers[index](guess?.point ?? null, guess?.maximum ?? 5000),
        guess: guess?.point ?? null,
      };
    });
    return {
      id: player.id,
      name: player.name,
      login: player.login,
      ...(twitchColor(player.color) ? { color: twitchColor(player.color) } : {}),
      rounds,
      score: rounds.reduce((sum, round) => sum + round.score, 0),
    };
  });
  return rankStreamPlayers(players);
}
export function streamResult(game: StreamGame): StreamResult {
  if (
    game.stage !== "complete" ||
    !game.finishedAt ||
    game.reveals.length !== game.session.rounds.length
  )
    throw new Error("Finish every round before publishing results.");
  return {
    schema: 1,
    id: game.session.id,
    version: game.session.version,
    createdAt: game.session.createdAt,
    finishedAt: game.finishedAt,
    host: game.session.host,
    rounds: game.reveals.map((r) => ({
      id: r.roundId,
      answer: r.answer,
      name: r.area.label,
      difficultyTier: r.area.difficultyTier!,
    })),
    players: streamStandings(game.participants, game.reveals).map((player) => ({
      ...player,
      rounds: player.rounds.map(({ score, areaScore, positionScore }) => ({
        score,
        areaScore,
        positionScore,
      })),
    })),
  };
}
export function ordinal(value: number): string {
  const remainder = value % 100;
  return (
    value.toLocaleString() +
    (remainder >= 11 && remainder <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th"))
  );
}
