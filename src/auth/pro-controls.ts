/* Shared provider UI. Independent of the host Bootstrap major version. */
import { authService } from "./auth-service";
import { createProGiftControls } from './pro-gifting';
import { bindAuthAttribute, bindAuthText } from './control-translations';

// Shared by the main map's Pro dialog and Guessr's account controls.
const TWITCH_ENABLED = true;

// Official Twitch glitch mark (white, for the purple button). Geometry from
// task/TwitchGlitchPurple.svg. Only injected when TWITCH_ENABLED.
const TWITCH_SYMBOL_WHITE = `
<svg viewBox="0 0 2400 2800" xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true">
  <path fill="#ffffff" d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600V1300z"/>
  <rect x="1700" y="550" fill="#ffffff" width="200" height="600"/>
  <rect x="1150" y="550" fill="#ffffff" width="200" height="600"/>
</svg>`;

// Official Patreon Symbol (White)
const PATREON_SYMBOL_WHITE = `
<svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <path fill="#ffffff" d="M1033.05,324.45c-0.19-137.9-107.59-250.92-233.6-291.7c-156.48-50.64-362.86-43.3-512.28,27.2
        C106.07,145.41,49.18,332.61,47.06,519.31c-1.74,153.5,13.58,557.79,241.62,560.67c169.44,2.15,194.67-216.18,273.07-321.33
        c55.78-74.81,127.6-95.94,216.01-117.82C929.71,603.22,1033.27,483.3,1033.05,324.45z"/>
</svg>`;

export function createProControls(
  options: {
    beforeLogin?: () => void;
    /** The host calls startLogin once its dialog transitions have completed. */
    onLogin?: (startLogin: () => void) => void;
    idPrefix?: string;
    streamerMode?: boolean;
  } = {},
): HTMLElement {
  const state = authService.getState();
  const linked = state.linkedAccounts || (state.provider ? [{
    provider: state.provider, username: state.username || '', isSubscriber: state.isSubscriber,
    membershipStatus: state.isSubscriber ? 'active' : 'inactive',
  }] : []);
  const controls = document.createElement("div");
  controls.className = "pro-columns";
  for (const provider of (TWITCH_ENABLED ? ['twitch', 'patreon'] : ['patreon']) as ('twitch' | 'patreon')[]) {
    const label = provider === 'twitch' ? 'Twitch' : 'Patreon';
    const account = linked.find(item => item.provider === provider);
    const column = document.createElement('div');
    column.className = 'pro-col';
    if (account) {
      const summary = document.createElement('div');
      summary.className = 'pro-provider-status';
      const name = document.createElement('strong');
      name.textContent = `${label}: ${account.username}`;
      const connection = document.createElement('span');
      bindAuthText(connection, 'auth.accountConnected', 'Account connected');
      const membership = document.createElement('span');
      membership.className = account.isSubscriber ? 'pro-membership-active' : 'pro-membership-inactive';
      const [membershipKey, membershipSource] = account.membershipStatus === 'reconnect'
        ? ['auth.reconnectRequired', 'Sign in again to check membership']
        : account.membershipStatus === 'stale'
          ? ['auth.membershipUnavailable', 'Membership check unavailable']
          : account.isSubscriber ? ['auth.proActive', 'Pro active']
            : ['auth.noActiveMembership', 'No active membership'];
      bindAuthText(membership, membershipKey, membershipSource);
      summary.append(name, connection, membership);
      column.append(summary);
      if (linked.length > 1 && state.accountId) {
        const unlink = document.createElement('button');
        unlink.type = 'button';
        unlink.className = 'pro-unlink';
        bindAuthText(unlink, 'auth.disconnectAccount', 'Disconnect {{provider}}', { provider: label });
        unlink.addEventListener('click', async () => {
          unlink.disabled = true;
          try {
            await authService.unlink(provider);
            controls.replaceWith(createProControls(options));
          } catch (error) {
            const message = document.createElement('span');
            message.setAttribute('role', 'alert');
            if (error instanceof Error && error.message !== 'Could not disconnect this account.') message.textContent = error.message;
            else bindAuthText(message, 'auth.disconnectFailed', 'Could not disconnect account.');
            column.append(message);
            unlink.disabled = false;
          }
        });
        column.append(unlink);
      }
    }
    if (!account || account.membershipStatus === 'reconnect') {
      const login = document.createElement('button');
      login.type = 'button';
      login.id = (options.idPrefix || '') + `${provider}LoginBtn`;
      login.className = `btn btn-solid theme-primary btn-${provider} justify-content-center`;
      login.innerHTML = provider === 'twitch' ? TWITCH_SYMBOL_WHITE : PATREON_SYMBOL_WHITE;
      const text = document.createElement('span');
      text.className = 'pro-provider-label';
      if (state.authenticated) bindAuthText(text, 'auth.connectAccount', 'Connect {{provider}}', { provider: label });
      else bindAuthText(text, provider === 'twitch' ? 'auth.loginWithTwitch' : 'auth.loginWithPatreon', `Sign in with ${label}`);
      login.append(text);
      if (state.authenticated && state.linkingAvailable === false) {
        login.disabled = true;
        bindAuthAttribute(login, 'title', 'auth.linkingUnavailable', 'Account connections are not available yet.');
      }
      login.addEventListener('click', () => {
        const startLogin = () => {
          options.beforeLogin?.();
          if (provider === 'twitch') authService.loginTwitch();
          else authService.login();
        };
        if (options.onLogin) options.onLogin(startLogin);
        else startLogin();
      });
      column.append(login);
    }
    const subscribe = document.createElement('a');
    subscribe.href = provider === 'twitch' ? 'https://www.twitch.tv/products/wuote' : 'https://www.patreon.com/wuote/membership';
    subscribe.target = '_blank';
    subscribe.rel = 'noopener noreferrer';
    subscribe.className = 'btn btn-outline theme-secondary btn-patron justify-content-center';
    subscribe.innerHTML = '<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>';
    const text = document.createElement('span');
    text.className = 'pro-provider-label';
    if (provider === 'twitch') bindAuthText(text, 'auth.subscribeTwitch', 'Subscribe on Twitch');
    else bindAuthText(text, 'auth.becomePatron', 'Become a Patron');
    subscribe.append(text);
    column.append(subscribe);
    column.append(createProGiftControls(provider, options.streamerMode === true));
    controls.append(column);
  }
  return controls;
}
