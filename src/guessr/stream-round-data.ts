import { streamStandings } from './stream-state';
import type { Point } from './rules';
import type { StreamGame, StreamPlayer } from './stream-types';
import { streamHostName } from './stream-display-name';

export interface StreamRoundView {
  mode?: 'stream' | 'pvp';
  round: number;
  host: StreamPlayer;
  answer: Point;
  label: string;
  players: (StreamPlayer & { guess: Point | null; recorded?: boolean; score: number; total: number })[];
}
/** Released round only. No credentials, future clues, or later-round guesses. */
export function streamRoundData(game: StreamGame, index: number): StreamRoundView {
  const reveal = game.reveals[index];
  if (!reveal || index < 0 || index > game.round) throw Error('This round has not been revealed.');
  const hostName = streamHostName(game.session.host, game.participants.find(p => p.id === game.session.host.id));
  return { ...(game.session.mode ? { mode: game.session.mode } : {}), round: index + 1, host: { ...game.session.host, name: hostName }, answer: reveal.answer, label: reveal.area.label,
    players: streamStandings(game.participants, game.reveals.slice(0, index + 1)).map(player => ({
      id: player.id, login: player.login, name: player.id === game.session.host.id ? hostName : player.name, color: player.color,
      guess: player.rounds[index].guess, score: player.rounds[index].score, total: player.score,
    })) };
}
