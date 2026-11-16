import { gameAuth } from './api';
import { StreamApi } from './stream-api';
import { TwitchViewer } from './twitch-viewer';

/** Display identity from a ticket obtained directly from the site's auth API.
 * The game Worker independently verifies the signature and authorizes the seat. */
function identity(token: string) {
  const part = token.split('.')[1];
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
  if (claims.v !== 2 || claims.typ !== 'game' || claims.aud !== 'noitamap-guessr'
    || typeof claims.twitchUserId !== 'string' || !/^\d{1,30}$/.test(claims.twitchUserId)
    || typeof claims.twitchLogin !== 'string' || !/^[a-z0-9_]{1,25}$/.test(claims.twitchLogin)) throw Error('Connect your Twitch channel before hosting.');
  return { userId: claims.twitchUserId as string, login: claims.twitchLogin as string,
    displayName: typeof claims.name === 'string' ? claims.name : claims.twitchLogin };
}
export async function pvpViewer(role: 'auto' | 'player' = 'auto'): Promise<TwitchViewer> {
  const auth = await gameAuth();
  const state = auth.getState();
  const login = () => auth.loginTwitch();
  if (!state.authenticated) return new TwitchViewer({ chat: false, siteLogin: login });
  if (!state.linkedAccounts?.some(row => row.provider === 'twitch' && row.membershipStatus !== 'reconnect'))
    return new TwitchViewer({ chat: false, siteLogin: login });
  const api = new StreamApi();
  const host = role === 'auto' && state.isSubscriber;
  const player = host ? identity(await api.hostSocketTicket()) : (await auth.getPlayerTicket()).player;
  let unsubscribe = () => {};
  const viewer = new TwitchViewer({ chat: false, siteIdentity: player, siteRole: host ? 'host' : 'account', siteLogin: login,
    siteAuthorization: async () => {
      if (!auth.getState().authenticated) throw Error('Sign in to continue.');
      const ticket = host ? { token: await api.hostSocketTicket(), player: undefined } : await auth.getPlayerTicket();
      const token = ticket.token;
      if ((ticket.player ?? identity(token)).userId !== player.userId) throw Error('The Twitch connection changed. Click Send after connecting again.');
      return token;
    },
    siteSignOut: () => { void auth.logout(); },
    onDispose: () => unsubscribe(),
  });
  unsubscribe = auth.subscribe(next => {
    if (!next.authenticated || next.accountId !== state.accountId || !next.linkedAccounts?.some(row => row.provider === 'twitch' && row.userId === player.userId)) viewer.disconnect(false);
  });
  return viewer;
}
