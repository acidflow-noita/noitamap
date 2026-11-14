import { verifyGameTicket } from './tickets';
import type { Env } from './index';
import type { ParallelAuthorization, ParallelIdentity } from '../../../src/guessr/parallel-types';
import type { ParallelRecord } from '../../../src/guessr/parallel-core';
import { streamPlayerName } from '../../../src/guessr/stream-display-name';
import { twitchColor } from '../../../src/guessr/player-color';

const utf8 = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64 = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(env: Env): Promise<CryptoKey> {
  if (!env.STREAM_SIGNING_SECRET || env.STREAM_SIGNING_SECRET.length < 32) throw Error('Missing socket signing key');
  return crypto.subtle.importKey('raw', utf8.encode('noitaguessr-socket-v1:' + env.STREAM_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function socketTicket(env: Env, gameId: string, identity: ParallelIdentity): Promise<string> {
  const payload = b64(utf8.encode(JSON.stringify({ gameId, identity, purpose: 'socket-resume-v1' })));
  return payload + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), utf8.encode(payload))));
}
/** Provider credentials are accepted only in the first TLS-protected frame.
 * Neither storage, attachments, URLs nor logs contain the provider token. */
export async function authorizeSocket(env: Env, record: ParallelRecord, input: ParallelAuthorization, now: number): Promise<ParallelIdentity | null> {
  if (input.role === 'resume') {
    if (typeof input.ticket !== 'string' || input.ticket.length > 4096) return null;
    try {
      const parts = input.ticket.split('.');
      if (parts.length !== 2 || !parts.every(p => /^[\w-]+$/.test(p)) || !await crypto.subtle.verify('HMAC', await key(env), unb64(parts[1]), utf8.encode(parts[0]))) return null;
      const data = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
      const p = data.identity as ParallelIdentity;
      if (data.purpose !== 'socket-resume-v1' || data.gameId !== record.game.session.id || p.expiresAt <= now) return null;
      if (p.role === 'host' && (p.owner !== record.owner || p.id !== record.game.session.host.id)) return null;
      return p;
    } catch { return null; }
  }
  if (input.role === 'host') {
    if (typeof input.ticket !== 'string') return null;
    const user = await verifyGameTicket(input.ticket, env.GAME_TICKET_PUBLIC_KEY ?? '', now);
    if (!user || user.sub !== record.owner || user.twitchUserId !== record.game.session.host.id) return null;
    return { ...record.game.session.host, role: 'host', owner: user.sub, expiresAt: user.exp * 1000 };
  }
  if (input.role !== 'player' || typeof input.accessToken !== 'string' || !/^[a-zA-Z0-9]{10,512}$/.test(input.accessToken)) return null;
  record.metrics.twitchValidations++;
  const validation = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + input.accessToken }, signal: AbortSignal.timeout(10000),
  });
  if (!validation.ok) return null;
  const data = await validation.json() as { client_id: string; user_id: string; login: string; expires_in: number; scopes?: string[] };
  if (!env.TWITCH_PLAYER_CLIENT_ID || data.client_id !== env.TWITCH_PLAYER_CLIENT_ID || !/^\d{1,30}$/.test(data.user_id)
    || !/^[a-z0-9_]{1,25}$/.test(data.login) || !(data.expires_in > 0) || !record.game.pvp && !data.scopes?.includes('user:write:chat')) return null;
  const headers = { Authorization: 'Bearer ' + input.accessToken, 'Client-Id': env.TWITCH_PLAYER_CLIENT_ID };
  const [profile, colorResponse] = await Promise.all([
    fetch('https://api.twitch.tv/helix/users?id=' + data.user_id, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null),
    fetch('https://api.twitch.tv/helix/chat/color?user_id=' + data.user_id, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null),
  ]);
  const users = profile?.ok ? await profile.json() as { data: { id: string; display_name: string }[] } : null;
  const user = users?.data.find(u => u.id === data.user_id);
  const colors = colorResponse?.ok ? await colorResponse.json() as { data: { user_id: string; color: string }[] } : null;
  const color = twitchColor(colors?.data.find(u => u.user_id === data.user_id)?.color);
  return { id: data.user_id, login: data.login, name: streamPlayerName(user?.display_name ?? data.login, data.login),
    ...(color ? { color } : {}), role: 'player', expiresAt: now + Math.min(3600, data.expires_in) * 1000 };
}
