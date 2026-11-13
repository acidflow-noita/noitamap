import type { StreamPlayer, StreamResult } from './stream-types';

/** Twitch display labels may contain formatting marks. Identity is the numeric
 * Twitch ID; harmless label cleanup must never discard someone's scores. */
export function streamPlayerName(name: string, login: string): string {
  let display = '';
  for (const character of name.replace(/[\p{Cc}\p{Cf}\p{Cs}<>]/gu, '').trim()) {
    if (display.length + character.length > 48) break;
    display += character;
  }
  return display || login;
}

/** Old linked-Patreon sessions sometimes stored the provider's placeholder as
 * the host name. The saved Twitch identity is enough to repair its display. */
export function streamHostName(host: StreamPlayer, player?: StreamPlayer): string {
  if (host.name !== 'Patron' || host.login.toLowerCase() === 'patron') return host.name;
  if (player?.id === host.id && player.login === host.login && player.name && player.name !== 'Patron') return player.name;
  return host.login;
}

/** Repair presentation/exports without mutating archived data or player scores. */
export function streamResultNames(result: StreamResult): StreamResult {
  const player = result.players.find(player => player.id === result.host.id);
  const name = streamPlayerName(streamHostName(result.host, player), result.host.login);
  const players = result.players.map(player => {
    const next = player.id === result.host.id ? name : streamPlayerName(player.name, player.login);
    return next === player.name ? player : { ...player, name: next };
  });
  return name === result.host.name && players.every((player, index) => player === result.players[index]) ? result
    : { ...result, host: { ...result.host, name }, players };
}
