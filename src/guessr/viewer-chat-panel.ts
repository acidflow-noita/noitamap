import { buttonNotice } from './button-notice';
import type { TwitchViewer } from './twitch-viewer';
import { isGuessChatMessage } from './guess-command';
import { createChatPrivacyOption, hideLocalGuesses, setHideLocalGuesses } from './stream-chat-privacy';
import { streamerProStatus } from './streamer-pro-status';
import type { TwitchChatStatus } from './twitch-chat';
import { bindAttribute, bindText, onGuessrLanguageChanged, tr } from './i18n';
import { twitchMessageText } from './twitch-viewer';
import { gameApiOrigin } from './api';
import { hoverHelp } from './hover-help';
import type { RoomConnection } from './live-room-client';

/** Direct Twitch chat shares the same account as Send guess; no third-party iframe. */
export function viewerChatPanel(viewer: TwitchViewer, initialChannel: string, onChangeStreamer?: () => void) {
  const panel = document.createElement('section'); panel.className = 'game-panel stream-chat';
  const header = document.createElement('div'); header.className = 'stream-chat-header';
  const title = document.createElement('strong');
  const identity = document.createElement('div'); identity.className = 'stream-chat-identity';
  const pro = streamerProStatus({ local: !gameApiOrigin() && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) });
  const changeStreamer = bindText(document.createElement('button'), 'Change streamer');
  changeStreamer.type = 'button'; changeStreamer.className = 'btn btn-sm btn-outline theme-secondary stream-change-channel';
  changeStreamer.onclick = () => onChangeStreamer?.();
  identity.append(title, pro.badge);
  const gift = document.createElement('button'); gift.type = 'button'; gift.className = 'btn btn-patron stream-gift-pro';
  gift.dataset.proGift = 'choose';
  gift.onclick = () => { void import('./pro-gift-dialog').then(({ showStreamerGift }) => showStreamerGift(channel)); };
  const stateLabel = document.createElement('span'); stateLabel.className = 'stream-chat-state';
  stateLabel.tabIndex = 0;
  stateLabel.setAttribute('role', 'status');
  stateLabel.setAttribute('aria-live', 'polite');
  title.before(stateLabel);
  const { label: privacy, input: hideGuesses } = createChatPrivacyOption('Hide guesses', hideLocalGuesses());
  const privacyHelp = hoverHelp(privacy, () => tr('Hide guesses only in your local view'), hideGuesses);
  const heading = document.createElement('div'); heading.className = 'stream-chat-heading';
  heading.append(identity, changeStreamer);
  const headerActions = document.createElement('div'); headerActions.className = 'stream-chat-actions';
  headerActions.append(gift, privacy);
  header.append(heading, headerActions);
  const messages = document.createElement('div'); messages.className = 'stream-chat-messages';
  messages.setAttribute('role', 'log'); bindAttribute(messages, 'aria-label', 'Twitch chat messages');
  const empty = document.createElement('p'); empty.className = 'stream-chat-empty';
  const form = document.createElement('form'); form.className = 'stream-chat-composer';
  const input = document.createElement('input'); input.maxLength = 500; bindAttribute(input, 'placeholder', 'Message…');
  const send = bindText(document.createElement('button'), 'Send'); send.type = 'submit'; send.className = 'secondary small';
  form.append(input, send); panel.append(header, messages, empty, form);
  const feedback = buttonNotice(send);
  let channel = initialChannel, key = '', stop: (() => void) | undefined, closed = false;
  bindText(gift, 'Gift Pro to {{channel}}', () => ({ channel }));
  const giftHelp = hoverHelp(gift, () => tr('Gift {{channel}} a subscription to wuote’s Twitch channel. Subscribers to wuote have Pro access and can start NoitaGuessr games for their chat.', { channel }));
  let chatStatus: TwitchChatStatus = 'offline', chatDetail = '';
  let gameStatus: RoomConnection | null = null, gameDetail = '';
  const statusExplanation = () => {
    if (navigator.onLine === false) return tr('You are offline. Reconnect to continue.');
    const state = viewer.getState();
    if (!state.connected) return twitchMessageText(state.error || 'Sign in with Twitch above to use chat.');
    if (chatStatus === 'channel-not-found') return tr('No Twitch account was found for {{channel}}. Check the Twitch username.', { channel });
    const chat = chatStatus === 'live' ? tr('Twitch chat connected')
      : chatDetail ? tr('Twitch chat: {{detail}}', { detail: twitchMessageText(chatDetail) })
      : tr('Twitch chat disconnected');
    const game = gameStatus === 'connected' ? tr('Connected to the game.') : gameDetail ? tr(gameDetail) : '';
    return [game, chat].filter(Boolean).join(' ');
  };
  const statusHelp = hoverHelp(stateLabel, statusExplanation);
  const paintChatStatus = () => {
    const state = viewer.getState();
    const health = navigator.onLine === false || gameStatus === 'offline' ? 'network-issues'
      : !state.connected && !state.restoring && !state.connecting || chatStatus === 'auth-required' || chatStatus === 'channel-not-found' || gameStatus === 'stopped' ? 'disconnected'
      : gameStatus === 'retrying' || chatStatus === 'reconnecting' ? 'reconnecting'
      : state.restoring || state.connecting || gameStatus === 'connecting' || chatStatus === 'connecting' ? 'connecting'
      : state.connected && chatStatus === 'live' && (gameStatus === null || gameStatus === 'connected') ? 'connected' : 'disconnected';
    const online = health === 'connected';
    stateLabel.hidden = !channel;
    const label = tr(health === 'network-issues' ? 'Network issues'
      : health === 'connecting' ? 'Connecting…' : health === 'reconnecting' ? 'Reconnecting…'
      : online ? gameStatus === null ? 'Twitch chat connected' : 'Connected'
      : chatStatus === 'channel-not-found' ? 'Twitch channel not found'
      : !state.connected || chatStatus === 'auth-required' ? 'Twitch sign-in required' : 'Disconnected');
    stateLabel.dataset.connection = health;
    stateLabel.classList.toggle('stream-chat-state-online', online);
    stateLabel.setAttribute('aria-label', label);
    if (!online) {
      const text = document.createElement('span'); text.className = 'visually-hidden'; text.textContent = label;
      stateLabel.replaceChildren(text);
    } else stateLabel.replaceChildren();
    statusHelp.update();
    if (!messages.childElementCount && key) {
      empty.hidden = false;
      empty.textContent = chatStatus === 'live' ? tr('New messages appear here.') : statusExplanation();
    }
  };
  const applyPrivacy = () => {
    const owner = viewer.getState().login === channel;
    privacy.hidden = !owner;
    for (const row of [...messages.children] as HTMLElement[])
      row.hidden = owner && hideGuesses.checked && row.dataset.guess === 'true';
  };
  hideGuesses.onchange = () => { setHideLocalGuesses(hideGuesses.checked); applyPrivacy(); };
  const refresh = () => {
    const state = viewer.getState();
    changeStreamer.hidden = !channel || !onChangeStreamer;
    gift.hidden = !channel || state.login === channel || chatStatus === 'channel-not-found';
    bindText(gift, 'Gift Pro to {{channel}}', { channel });
    giftHelp.update();
    title.textContent = channel || tr('Twitch chat');
    input.setAttribute('aria-label', channel ? tr('Message {{channel}}’s chat', { channel }) : tr('Chat message'));
    input.disabled = navigator.onLine === false || !channel || !state.connected || state.sending || chatStatus === 'channel-not-found';
    send.disabled = input.disabled || !input.value.trim();
    applyPrivacy();
    headerActions.hidden = gift.hidden && privacy.hidden;
    const next = state.connected && channel ? `${state.userId}/${channel}` : '';
    if (next === key) {
      if (!next) empty.textContent = state.restoring ? tr('Restoring Twitch connection…') : twitchMessageText(state.error || 'Sign in with Twitch above to use chat.');
      paintChatStatus();
      return;
    }
    key = next; stop?.(); stop = undefined; messages.replaceChildren(); empty.hidden = false;
    if (!next) {
      chatStatus = 'offline'; chatDetail = '';
      empty.textContent = twitchMessageText(state.error || 'Sign in with Twitch above to use chat.');
      paintChatStatus();
      return;
    }
    chatStatus = 'connecting'; chatDetail = 'Connecting to chat…'; paintChatStatus();
    stop = viewer.watchChat(channel, {
      status: (status, detail) => {
        if (closed || key !== next) return;
        chatStatus = status; chatDetail = detail; refresh();
      },
      message: message => {
        if (closed || key !== next) return;
        const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
        const row = document.createElement('div'); row.className = 'stream-chat-message';
        row.dataset.messageId = message.id; row.dataset.userId = message.player.id;
        row.dataset.guess = String(isGuessChatMessage(message.text));
        row.hidden = viewer.getState().login === channel && hideGuesses.checked && row.dataset.guess === 'true';
        const author = document.createElement('strong'); author.textContent = message.player.name + ': ';
        row.append(author, document.createTextNode(message.text.slice(0, 2000)));
        messages.append(row); empty.hidden = true;
        while (messages.childElementCount > 200) messages.firstElementChild?.remove();
        if (atBottom) messages.scrollTop = messages.scrollHeight;
      },
      remove: (kind, id) => {
        if (closed || key !== next) return;
        for (const row of [...messages.children] as HTMLElement[])
          if (kind === 'all' || kind === 'user' && row.dataset.userId === id || kind === 'message' && row.dataset.messageId === id) row.remove();
      },
    });
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (input.disabled || !input.value.trim()) return;
    const text = input.value;
    void viewer.sendMessage(channel, text).then(() => {
      if (closed) return;
      if (input.value === text) input.value = '';
      refresh(); input.focus();
    }).catch(error => { if (!closed) feedback.show(twitchMessageText((error as Error).message)); });
  };
  input.oninput = refresh;
  const unsubscribe = viewer.subscribe(refresh);
  const unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('online', refresh);
  paintChatStatus();
  return { panel, setProStatus: pro.update,
    setGameConnection(status: RoomConnection | null, detail = '') { gameStatus = status; gameDetail = detail; paintChatStatus(); },
    setChannel(value: string) { channel = value; pro.update({}); refresh(); },
    dispose() {
      closed = true; unsubscribe(); unsubscribeLanguage(); stop?.(); feedback.dispose(); statusHelp.dispose(); giftHelp.dispose(); privacyHelp.dispose(); pro.dispose();
      window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    } };
}
