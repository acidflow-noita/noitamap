import type { StreamResult } from './stream-types';
import { validStreamRoundCount } from './stream-types';
import { playerColor } from './player-color';
import { streamHostName } from './stream-display-name';

export interface StreamSharePlayer {
  readonly name: string;
  readonly color: string;
  readonly score: number;
  readonly rank: number;
  readonly rounds: readonly number[];
}
export interface StreamShareData {
  readonly mode?: 'pvp';
  readonly conceded?: string;
  readonly kind: 'chatter' | 'streamer';
  readonly day: string;
  readonly filename: string;
  readonly players: number;
  readonly player: StreamSharePlayer;
  readonly streamer: StreamSharePlayer;
  readonly gap: number;
  readonly chatters: number;
  readonly outscored: number;
}

/** Only names, colors and scoring enter the image renderer. Never pass clue
 * locations, source URLs, session credentials or account identifiers to it. */
export function streamShareData(result: StreamResult, playerId = result.host.id): StreamShareData | null {
  if (!(result.mode === 'pvp' && result.concededBy ? result.rounds.length <= 10 : validStreamRoundCount(result.rounds.length)) || !Number.isSafeInteger(result.finishedAt) || result.finishedAt <= 0
    || !result.players.length) return null;
  const ids = new Set<string>();
  for (const player of result.players) {
    if (!player.id || ids.has(player.id) || typeof player.name !== 'string' || !player.name.trim()
      || player.name.length > 100 || player.rounds.length !== result.rounds.length) return null;
    ids.add(player.id);
    if (player.rounds.some(round => !Number.isInteger(round.score) || round.score < 0 || round.score > 5000)
      || player.score !== player.rounds.reduce((sum, round) => sum + round.score, 0)) return null;
  }
  const host = result.players.find(player => player.id === result.host.id);
  const selected = result.players.find(player => player.id === playerId);
  if (!host || !selected) return null;
  const opponent = result.mode === 'pvp' ? result.players.find(p => p.id !== selected.id)! : host;
  if (!opponent) return null;
  const date = new Date(result.finishedAt);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const playerData = (player: StreamResult['players'][number]): StreamSharePlayer => Object.freeze({
    name: player.id === host.id ? streamHostName(result.host, host) : player.name,
    color: playerColor(player, result.mode === 'pvp' ? '' : host.id), score: player.score,
    // The existing competition-rank rule: equal totals share a rank.
    rank: result.mode === 'pvp' ? player.rank : 1 + result.players.filter(other => other.score > player.score).length,
    rounds: Object.freeze(player.rounds.map(round => round.score)),
  });
  const login = (value: string) => /^[a-z0-9_]{1,25}$/i.test(value) ? value.toLowerCase() : 'player';
  return Object.freeze({ kind: result.mode !== 'pvp' && selected.id === host.id ? 'streamer' : 'chatter', day,
    ...(result.mode === 'pvp' ? { mode: 'pvp' as const } : {}),
    ...(result.concededBy ? { conceded: result.players.find(p => p.id === result.concededBy)?.name } : {}),
    filename: `noitaguessr-${login(result.host.login)}-${login(selected.login)}-${day}.png`,
    players: result.players.length, player: playerData(selected), streamer: playerData(opponent),
    gap: selected.score - opponent.score, chatters: result.players.length - 1,
    outscored: result.players.filter(other => other.id !== host.id && other.score < host.score).length,
  });
}
