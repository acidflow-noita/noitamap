import type { StreamPlayer, StreamResult } from './stream-types';

/** Old linked-Patreon sessions sometimes stored the provider's placeholder as
 * the host name. The saved Twitch identity is enough to repair its display. */
export function streamHostName(host: StreamPlayer, player?: StreamPlayer): string {
  if (host.name !== 'Patron' || host.login.toLowerCase() === 'patron') return host.name;
  if (player?.id === host.id && player.login === host.login && player.name && player.name !== 'Patron') return player.name;
  return host.login;
}

/** Repair presentation/exports without mutating archived data or player scores.
 * Chatter names come directly from Twitch and must never be rewritten. */
export function streamResultNames(result: StreamResult): StreamResult {
  const player = result.players.find(player => player.id === result.host.id);
  const name = streamHostName(result.host, player);
  if (name === result.host.name && player?.name !== 'Patron') return result;
  if (name === result.host.name && player?.name === name) return result;
  return { ...result, host: { ...result.host, name },
    players: result.players.map(player => player.id === result.host.id ? { ...player, name } : player) };
}
