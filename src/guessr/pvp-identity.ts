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
export async function pvpViewer(): Promise<TwitchViewer> {
  const auth = await gameAuth();
  const state = auth.getState();
  if (!state.authenticated || !state.isSubscriber) return new TwitchViewer({ chat: false });
  const api = new StreamApi();
  const player = identity(await api.hostSocketTicket());
  return new TwitchViewer({ chat: false, siteIdentity: player,
    siteAuthorization: async () => {
      if (!auth.getState().authenticated) throw Error('Sign in to continue.');
      const token = await api.hostSocketTicket();
      if (identity(token).userId !== player.userId) throw Error('The Twitch connection changed. Click Send after connecting again.');
      return token;
    },
    siteSignOut: () => { void auth.logout(); },
  });
}
