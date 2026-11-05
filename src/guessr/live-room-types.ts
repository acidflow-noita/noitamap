import type { StreamPublishedResult, StreamRoundOutcome } from './stream-types.ts';
import type { AreaDifficulty } from './area-rules.ts';

/** Public room messages never contain future answers or private reveal tokens. */
export interface LiveRoomView {
  schema: 1;
  channel: string;
  hostId?: string;
  hostPro?: 'active' | 'unknown';
  hostProVerifiedUntil?: number;
  gameId: string | null;
  revision: number;
  phase: 'waiting' | 'guess' | 'reveal' | 'complete';
  online: boolean;
  paused: boolean;
  ended?: boolean;
  round: number;
  roundId: string | null;
  clue: string | null;
  difficultyTier?: AreaDifficulty;
  expiresAt: number | null;
  resultId?: string;
  outcome?: StreamRoundOutcome;
  result?: StreamPublishedResult;
  timing?: { phase: 'lobby' | 'warmup' | 'play'; startsAt: number; deadline: number | null; hostRound: number; chatRound?: number | null; seconds: number; revealed?: number; early?: boolean };
}
export interface LiveRoomGame {
  channel: string;
  hostId?: string;
  hostProVerifiedUntil?: number;
  gameId: string;
  expiresAt: number;
  rounds: { id: string; clue: string; difficultyTier?: AreaDifficulty }[];
}
export type LiveRoomMessage = { type: 'state'; state: LiveRoomView } | { type: 'heartbeat'; at: number };
export interface LiveRoomMethods {
  start(ownerId: string, game: LiveRoomGame): Promise<LiveRoomView>;
  advance(ownerId: string, gameId: string, roundId: string): Promise<LiveRoomView>;
  reveal(ownerId: string, gameId: string, roundId: string, outcome?: StreamRoundOutcome): Promise<LiveRoomView>;
  pulse(ownerId: string, gameId: string, hostProVerifiedUntil?: number): Promise<LiveRoomView>;
  pause(ownerId: string, gameId: string, paused: boolean): Promise<LiveRoomView>;
  quit(ownerId: string, gameId: string): Promise<LiveRoomView>;
  publish(ownerId: string, gameId: string, result?: StreamPublishedResult): Promise<LiveRoomView>;
}
export interface LiveRoomNamespace {
  getByName(channel: string): LiveRoomMethods & { fetch(request: Request): Promise<Response> };
}
