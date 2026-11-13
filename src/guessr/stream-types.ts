import type { AreaDefinition, AreaDifficulty, AreaGuessResult } from "./area-rules.ts";
import type { ClueSource } from "./clue-camera.ts";
import type { ImageGameConfig } from "./image-game.ts";
import type { ClueProgress, Point } from "./rules.ts";
import { ROUND_COUNT } from './rules.ts';

export const STREAM_ROUNDS = ROUND_COUNT;
export const STREAM_ROUND_OPTIONS = [3, 5, 10] as const;
export const STREAM_DEFAULT_ROUNDS = 5;
export function validStreamRoundCount(value: unknown): value is typeof STREAM_ROUND_OPTIONS[number] {
  return STREAM_ROUND_OPTIONS.some(rounds => rounds === value);
}
/** Cloud roster/result bound. Local chat collection and downloads retain everyone. */
export const STREAM_MAX_PLAYERS = 1500;
export const STREAM_MAX_DOCUMENT_BYTES = 1536 * 1024;
export const STREAM_SESSION_KEY = "noitamap-guessr-stream-v1";
export interface StreamPlayer {
  id: string;
  login: string;
  name: string;
  color?: string;
}
export interface StreamRound {
  id: string;
  clue: ClueSource;
  difficultyTier?: AreaDifficulty;
  token: string;
}
export interface StreamSession {
  transport?: 'twitch' | 'parallel';
  /** Current rounds are coordinated through the Twitch broadcast transport. */
  live?: true;
  /** Loopback testing: real Twitch channel, separate synthetic host score. */
  localChat?: true;
  id: string;
  version: string;
  createdAt: number;
  serverNow: number;
  expiresAt: number;
  host: StreamPlayer;
  /** Expiry of a verified Pro game ticket, never inferred from the channel. */
  hostProVerifiedUntil?: number;
  config: ImageGameConfig;
  rounds: StreamRound[];
  token: string;
}
export interface StreamGuess {
  point: Point | null;
  maximum: number;
  /** Twitch message IDs prevent duplicate delivery from replacing a guess. */
  messageId: string;
  sentAt: number;
  nonce?: string;
  revision?: number;
}
export interface StreamReveal {
  roundId: string;
  answer: Point;
  area: AreaDefinition;
}
/** The host submits its Twitch-received roster once when closing the round. */
export interface StreamRoundSubmission {
  player: StreamPlayer;
  guess: Point | null;
  maximum: number;
}
/** Published only after durable closure; no private area mask or future answers. */
export interface StreamRoundOutcome {
  roundId: string;
  answer: Point;
  label: string;
  difficultyTier: AreaDifficulty;
  players: {
    id: string;
    guess: Point | null;
    score: number;
    areaScore: number;
    positionScore: number;
    distance: number | null;
  }[];
}
export interface StreamParticipant extends StreamPlayer {
  guesses: (StreamGuess | null)[];
}
export interface StreamGame {
  schema: 1;
  session: StreamSession;
  /** Server epoch minus browser epoch; chat timestamps already use server time. */
  clockOffset: number;
  round: number;
  stage: "guess" | "closing" | "reveal" | "complete";
  openedAt: number;
  closedAt: number | null;
  finishedAt: number | null;
  clue: ClueProgress;
  guess: Point | null;
  paused: boolean;
  /** Browser preference for the current game's explicit share action. */
  shareAnnouncements?: boolean;
  /** Confirmed initial invitation posts, retained if the host refreshes in the lobby. */
  initialShareCount?: number;
  /** Unique authenticated Twitch identities seen joining this game's transport. */
  joinedPlayers?: Record<string, { login: string; name: string; color?: string }>;
  joinedOverflow?: boolean;
  timing?: import('./stream-timing').StreamTiming;
  receipts?: Record<number, string[]>;
  participants: StreamParticipant[];
  /** Bounded deduplication for retries in the active round, retained across F5. */
  recentNonces?: Record<string, string[]>;
  reveals: StreamReveal[];
  published?: boolean;
  resultShareCount?: number;
  resultShareAttempted?: boolean;
  transportStats?: import('./parallel-types').ParallelMetrics;
}
export interface StreamPlayerResult extends StreamPlayer {
  rounds: (AreaGuessResult & { guess: Point | null })[];
  score: number;
  rank: number;
}
/** No credentials, unrevealed tokens, raw chat, or account IDs in public results. */
export interface StreamResult {
  schema: 1;
  id: string;
  version: string;
  createdAt: number;
  finishedAt: number;
  host: StreamPlayer;
  transportStats?: import('./parallel-types').ParallelMetrics;
  rounds: { id: string; answer: Point; name: string; difficultyTier: string }[];
  players: (Omit<StreamPlayerResult, "rounds"> & {
    rounds: Pick<AreaGuessResult, "score" | "areaScore" | "positionScore">[];
  })[];
}
export interface StreamPublishInput {
  token: string;
  finishedAt: number;
  /** Host-reported casual standings; the service validates and recomputes ranks. */
  players: Omit<StreamResult["players"][number], "rank">[];
}
export interface StreamHistoryPage {
  games: { id: string; finishedAt: number; players: number; hostName: string }[];
  next?: string;
}
export interface StreamPublishedResult extends Omit<StreamResult, "players"> {
  format: "compact-scores-v1";
  players: (StreamPlayer & {
    score: number;
    rank: number;
    rounds: [area: number, proximity: number][];
  })[];
}
export interface StreamPublishWireInput {
  token: string;
  finishedAt: number;
  players: Omit<StreamPublishedResult["players"][number], "rank">[];
}
