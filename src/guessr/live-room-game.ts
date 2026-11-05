import type { LiveRoomGame } from './live-room-types.ts';
import type { StreamSession } from './stream-types.ts';
import { encodeViewerClue } from './viewer-clue.ts';
import { guessRouteUrl } from './routes.ts';

/** Server-side: prepare public clues from the trusted dataset, without answers. */
export function liveRoomGame(session: StreamSession, imageRoot: string): LiveRoomGame {
  return {
    channel: session.host.login,
    hostId: session.host.id,
    ...(session.localChat || session.hostProVerifiedUntil === undefined ? {} : {
      hostProVerifiedUntil: session.hostProVerifiedUntil,
    }),
    gameId: session.id,
    expiresAt: session.expiresAt,
    rounds: session.rounds.map((round, index) => ({
      id: round.id,
      ...(round.difficultyTier ? { difficultyTier: round.difficultyTier } : {}),
      clue: encodeViewerClue({
        source: round.clue,
        camera: { dx: 0, dy: 0, level: 0 },
        assistance: { widest: 0, travelSpent: 0 },
        round: index + 1,
        version: session.version,
      }, { imageRoot, version: session.version }),
    })),
  };
}

/** One stable link per game, across rounds and reloads. No clue or credential in it. */
export function liveRoomLink(origin: string, channel: string, gameId: string, transport?: 'twitch'): string {
  if (!/^[a-z0-9_]{1,25}$/i.test(channel)) throw new Error('Invalid Twitch channel.');
  return guessRouteUrl('stream-picker', new URL('/guess/', origin), { channel, game: gameId, transport }).href;
}
