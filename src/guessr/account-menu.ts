import Dialog from 'bootstrap/js/dist/dialog.js';
import { gameAuth } from './api';
import { bindAttribute, bindText, tr, onGuessrLanguageChanged } from './i18n';
import { iconLabel } from './control-icons';
import type { TwitchViewer } from './twitch-viewer';

const menus = new WeakMap<HTMLElement, (viewer?: TwitchViewer) => () => void>();

export function mountAccountMenu(parent: HTMLElement) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline theme-secondary guessr-account';
  button.dataset.guessrAccount = ''; button.setAttribute('aria-haspopup', 'dialog');
  let auth: Awaited<ReturnType<typeof gameAuth>> | undefined, viewer: TwitchViewer | undefined;
  let closed = false, unsubscribe = () => {}, unsubscribeViewer = () => {}, dialog: HTMLDialogElement | undefined;
  let renderDialog = () => {};
  let restoring: Promise<void> | undefined;
  const restore = () => restoring ??= (async () => {
    const service = await gameAuth();
    if (closed || !service) return;
    auth = service; unsubscribe = service.subscribe(paint); paint();
  })().catch(() => { restoring = undefined; });
  const identity = () => {
    const state = auth?.getState(), chatter = viewer?.getState();
    const twitch = state?.linkedAccounts?.find(row => row.provider === 'twitch' && row.membershipStatus !== 'reconnect');
    const useChatter = !!chatter?.connected;
    return { name: useChatter ? chatter.displayName || chatter.login : twitch?.username || state?.nickname || state?.username,
      signedIn: useChatter || !!state?.authenticated,
      pro: !!state?.isSubscriber && (!useChatter || twitch?.userId === chatter.userId), state };
  };
  const paint = () => {
    if (closed) return;
    const account = identity(); button.replaceChildren(iconLabel(account.signedIn ? 'person-circle' : 'twitch', account.name || 'Sign in with Twitch'));
    if (account.name) button.querySelector('span')!.textContent = account.name;
    button.querySelector('span')!.classList.add('account-label');
    if (account.pro) { const badge = document.createElement('span'); badge.className = 'badge pro'; bindText(badge, 'Pro'); button.append(badge); }
    bindAttribute(button, 'aria-label', () => account.signedIn ? `${tr('Your account')}: ${account.name}` : tr('Sign in with Twitch'));
    if (dialog) renderDialog();
  };
  const connectViewer = (next?: TwitchViewer) => {
    unsubscribeViewer(); viewer = next; unsubscribeViewer = next?.subscribe(paint) ?? (() => {}); paint();
    return () => { if (viewer === next) { unsubscribeViewer(); viewer = undefined; paint(); } };
  };
  menus.set(button, connectViewer);
  const open = () => {
    void restore();
    if (dialog) { void Dialog.getOrCreateInstance(dialog).show(); return; }
    const current = dialog = document.createElement('dialog'); current.className = 'dialog guessr-account-dialog';
    current.setAttribute('aria-labelledby', 'guessr-account-title');
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = bindText(document.createElement('h2'), 'Your account'); title.id = 'guessr-account-title'; title.className = 'dialog-title';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn-close'; close.dataset.bsDismiss = 'dialog'; bindAttribute(close, 'aria-label', 'Close');
    header.append(title, close);
    const body = document.createElement('div'); body.className = 'dialog-body';
    const error = document.createElement('p'); error.className = 'form-text'; error.setAttribute('role', 'status'); error.hidden = true;
    const action = (label: string, run: () => unknown, className = 'btn btn-outline theme-secondary') => {
      const control = bindText(document.createElement('button'), label); control.type = 'button'; control.className = className;
      control.onclick = async () => { control.disabled = true; error.hidden = true;
        try { await run(); } catch { bindText(error, 'Could not refresh Pro status. Try again shortly.'); error.hidden = false; }
        finally { if (control.isConnected) control.disabled = false; }
      }; body.append(control);
    };
    const render = () => {
      body.replaceChildren(); const account = identity();
      if (account.signedIn) {
        const row = document.createElement('div'); row.className = 'account-identity';
        const name = document.createElement('strong'); name.className = 'account-name'; name.textContent = account.name || ''; name.dir = 'auto'; row.append(name);
        if (account.pro) { const badge = bindText(document.createElement('span'), 'Pro'); badge.className = 'badge pro'; row.append(badge); }
        body.append(row);
        if (account.state?.authenticated) {
          action('Refresh Pro status', async () => { await auth!.refreshMembership(); if (current.isConnected) {
            paint(); render(); bindText(error, auth!.getState().isSubscriber ? 'Pro access confirmed.' : 'No active Pro membership was found.'); error.hidden = false;
          } });
          if (!account.state.linkedAccounts?.some(row => row.provider === 'patreon')) action('Connect Patreon', () => auth!.login());
          if (!account.state.linkedAccounts?.some(row => row.provider === 'twitch')) action('Connect Twitch', () => auth!.loginTwitch());
        } else action('Sign in with Twitch', async () => (await gameAuth()).loginTwitch(), 'btn btn-twitch');
        action('Sign out', async () => { viewer?.disconnect(); await auth?.logout(); await instance.hide(); paint(); });
      } else {
        action('Sign in with Twitch', async () => (await gameAuth()).loginTwitch(), 'btn btn-twitch');
        action('Sign in with Patreon', async () => (await gameAuth()).login(), 'btn btn-patreon');
      }
      body.append(error);
    };
    renderDialog = render;
    current.append(header, body); document.body.append(current);
    const instance = new Dialog(current); render();
    current.addEventListener('hidden.bs.dialog', () => { instance.dispose(); current.remove(); dialog = undefined; renderDialog = () => {}; if (button.isConnected) button.focus({ preventScroll: true }); }, { once: true });
    void instance.show(button);
  };
  button.onclick = open; parent.append(button); paint();
  const language = onGuessrLanguageChanged(paint);
  // Public result links stay independent of auth. Restore the optional account
  // display only when this browser has a registered session reference.
  try {
    const token = localStorage.getItem('noitamap_jwt') || localStorage.getItem('noitamap_refresh_jwt') || '';
    if (token.length <= 4096 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) void restore();
  } catch { /* Sign-in remains available when browser storage is blocked. */ }
  return () => { closed = true; unsubscribe(); unsubscribeViewer(); language(); menus.delete(button); if (dialog) { Dialog.getInstance(dialog)?.dispose(); dialog.remove(); } };
}

export function bindViewerAccount(viewer: TwitchViewer): () => void {
  const button = document.querySelector<HTMLElement>('[data-guessr-account]');
  return button ? menus.get(button)?.(viewer) ?? (() => {}) : () => {};
}
