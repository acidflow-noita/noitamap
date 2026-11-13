import type { Point } from './rules';
import type { StreamGame, StreamParticipant, StreamPlayer, StreamResult, StreamReveal, StreamSession } from './stream-types';
import type { LiveRoomView } from './live-room-types';
import type { StreamChatMessage } from './stream-state';

export interface ParallelSubmission {
  roundId: string;
  point: Point;
  maximum: number;
  nonce: string;
  revision: number;
  automatic?: boolean;
}
export interface ParallelIdentity extends StreamPlayer {
  role: 'host' | 'player';
  owner?: string;
  expiresAt: number;
}
export interface ParallelMetrics {
  upgrades: number;
  authenticated: number;
  reconnects: number;
  twitchValidations: number;
  socketMessages: number;
  directGuesses: number;
  twitchGuesses: number;
  duplicates: number;
  replacements: number;
  rejected: number;
  accepted: number;
  storageRowsWritten: number;
  firstByTwitch: number;
  firstBySocket: number;
  publicationAttempts: number;
}
export const emptyParallelMetrics = (): ParallelMetrics => ({ upgrades: 0, authenticated: 0, reconnects: 0,
  twitchValidations: 0, socketMessages: 0, directGuesses: 0, twitchGuesses: 0, duplicates: 0,
  replacements: 0, rejected: 0, accepted: 0, storageRowsWritten: 0, firstByTwitch: 0, firstBySocket: 0, publicationAttempts: 0 });

export type ParallelAuthorization =
  | { role: 'host'; ticket: string }
  | { role: 'player'; accessToken: string }
  | { role: 'resume'; ticket: string };
export type ParallelClientMessage =
  | ({ type: 'authorize' } & ParallelAuthorization)
  | { type: 'guess'; submission: ParallelSubmission }
  | { type: 'relay'; message: StreamChatMessage }
  | { type: 'start'; id: string }
  | { type: 'host-guess'; id: string; roundId: string; point: Point | null; maximum: number }
  | { type: 'quit'; id: string }
  | { type: 'publish'; id: string }
  | { type: 'advance'; id: string }
  | { type: 'recover' };
export type ParallelServerMessage =
  | { type: 'authorized'; ticket: string; expiresAt: number; player: StreamPlayer; now: number; acceptedRevisions?: Record<string, number> }
  | { type: 'state'; state: LiveRoomView; now: number }
  | { type: 'host'; game: StreamGame; now: number; metrics: ParallelMetrics; publicationError?: string; ended?: boolean }
  | { type: 'participant'; participant: StreamParticipant; joined: number }
  | { type: 'command'; id: string; accepted: boolean }
  | { type: 'receipt'; round: number; roundId: string; nonce: string; revision: number; accepted: boolean;
      playerId?: string; reason?: 'closed' | 'superseded' | 'invalid'; point?: Point; maximum?: number; automatic?: boolean }
  | { type: 'reveal'; round: number; reveal: StreamReveal; results?: import('./stream-round-data').StreamRoundView }
  | { type: 'published'; result: StreamResult }
  | { type: 'error'; code: 'auth' | 'capacity' | 'invalid' | 'unavailable'; message: string };

/** Only the authenticated session-creation route can initialize an object. */
export interface ParallelInitialization {
  owner: string;
  session: StreamSession;
  reveals: StreamReveal[];
  seconds: number;
}
export interface ParallelNamespace {
  getByName(id: string): {
    initialize(input: ParallelInitialization): Promise<void>;
    fetch(request: Request): Promise<Response>;
  };
}
