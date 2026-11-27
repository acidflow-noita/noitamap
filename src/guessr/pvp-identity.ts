import { gameAuth } from './api';
import { StreamApi } from './stream-api';
import { TwitchViewer, TWITCH_VERIFICATION_FAILED } from './twitch-viewer';
import type { AuthState } from '../auth/auth-service';

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
  const twitchAccount = (state: AuthState) => state.authenticated && state.accountId
    ? state.linkedAccounts?.find(row => row.provider === 'twitch' && row.membershipStatus !== 'reconnect') : undefined;
  let binding: { account: string; twitchId: string; host: boolean } | undefined;
  let pending: Promise<void> | undefined, signingOut: Promise<void> | undefined;
  let disposed = false;
  const viewer = new TwitchViewer({ chat: false,
    siteLogin: async () => {
      await signingOut;
      if (!auth.getState().authenticated && auth.hasSavedSession()) await auth.checkAuth();
      if (disposed) return;
      if (twitchAccount(auth.getState())) return sync(auth.getState());
      if (!auth.getState().authenticated && auth.hasSavedSession()) throw Error(TWITCH_VERIFICATION_FAILED);
      return auth.loginTwitch();
    },
    siteSignOut: () => {
      binding = undefined;
      signingOut = auth.logout().finally(() => { signingOut = undefined; });
    },
    onDispose: () => { disposed = true; binding = undefined; unsubscribe(); },
  });
  function sync(state: AuthState): Promise<void> | undefined {
    if (disposed || signingOut) return;
    const linked = twitchAccount(state), host = role === 'auto' && state.isSubscriber;
    if (binding && linked && binding.account === state.accountId && binding.twitchId === linked.userId && binding.host === host) return pending;
    binding = undefined;
    if (viewer.getState().connected) viewer.disconnect(false);
    if (!linked) return;
    const expected = binding = { account: state.accountId!, twitchId: linked.userId, host };
    const api = host ? new StreamApi() : undefined;
    const issue = async (renew = false) => {
      const ticket = api ? await api.hostSocketTicket(renew).then(token => ({ token, player: identity(token) }))
        : await auth.getPlayerTicket(renew);
      if (binding !== expected || ticket.player.userId !== expected.twitchId) throw Error('The Twitch connection changed. Click Send after connecting again.');
      return ticket;
    };
    pending = issue().then(({ player }) => {
      if (binding === expected) viewer.setSiteSession(player, host ? 'host' : 'account', async renew => (await issue(renew)).token);
    }).catch(error => {
      if (binding === expected) {
        binding = undefined;
        viewer.siteConnectionFailed();
        throw error;
      }
    });
    return pending;
  }
  const unsubscribe = auth.subscribe(next => { void sync(next)?.catch(() => {}); });
  if (!auth.getState().authenticated && auth.hasSavedSession()) await auth.checkAuth();
  await sync(auth.getState())?.catch(() => {});
  if (!auth.getState().authenticated && auth.hasSavedSession()) viewer.siteConnectionFailed();
  return viewer;
}
