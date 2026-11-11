import type { TwitchViewer } from './twitch-viewer';
import { streamerProStatus, hasKnownStreamerPro } from './streamer-pro-status';
import type { TwitchChatStatus } from './twitch-chat';
import { bindAttribute, bindText, onGuessrLanguageChanged, tr } from './i18n';
import { guessRouteUrl } from './routes';
import { twitchMessageText } from './twitch-viewer';
import { gameApiOrigin } from './api';
import { hoverHelp } from './hover-help';
import type { RoomConnection } from './live-room-types';
import { GUESSR_TRANSPORT_CHANNEL } from './chat-transport';
import type { StreamChatMessage } from './stream-state';

/** A compact game connection bar. The transport channel is never a chat UI. */
export function viewerChatPanel(viewer: TwitchViewer, initialChannel: string, onChangeStreamer?: () => void,
  events?: { message(message: StreamChatMessage): void; status(status: TwitchChatStatus, detail: string): void }, gameId?: string) {
  const panel = document.createElement('section'); panel.className = 'game-panel stream-connection-bar';
  const header = document.createElement('div'); header.className = 'stream-chat-header';
  const title = document.createElement('strong');
  const historyLink = document.createElement('a'); historyLink.className = 'stream-channel-link';
  historyLink.target = '_blank'; historyLink.rel = 'noopener noreferrer'; title.append(historyLink);
  const identity = document.createElement('div'); identity.className = 'stream-chat-identity';
  const pro = streamerProStatus({ channel: initialChannel, local: !gameApiOrigin() && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) });
  const changeStreamer = bindText(document.createElement('button'), 'Exit game');
  changeStreamer.type = 'button'; changeStreamer.className = 'btn btn-sm btn-outline theme-secondary stream-change-channel';
  changeStreamer.onclick = () => onChangeStreamer?.();
  const light = document.createElement('span'); light.className = 'stream-chat-state';
  light.tabIndex = 0; light.setAttribute('role', 'status'); light.setAttribute('aria-live', 'polite');
  const name = document.createElement('span'); name.className = 'stream-name';
  name.append(title, pro.badge); identity.append(light, name);
  const gift = document.createElement('button'); gift.type = 'button'; gift.className = 'btn btn-patron stream-gift-pro';
  gift.dataset.proGift = 'choose';
  gift.onclick = () => { void import('./pro-gift-dialog').then(({ showStreamerGift }) => showStreamerGift(channel)); };
  const heading = document.createElement('div'); heading.className = 'stream-chat-heading';
  heading.append(changeStreamer, identity);
  const actions = document.createElement('div'); actions.className = 'stream-chat-actions'; actions.append(gift);
  header.append(heading, actions); panel.append(header);
  let channel = initialChannel, key = '', stop: (() => void) | undefined, closed = false, hasGame = false;
  let chatStatus: TwitchChatStatus = 'offline', chatDetail = '';
  let gameStatus: RoomConnection | null = null, gameDetail = '';
  const giftHelp = hoverHelp(gift, () => tr('Gift {{channel}} a subscription to wuote’s Twitch channel. Subscribers to wuote have Pro access and can start NoitaGuessr games for their chat.', { channel }));
  const explanation = () => {
    if (navigator.onLine === false) return tr('You are offline. Reconnect to continue.');
    const state = viewer.getState();
    if (!state.connected) return twitchMessageText(state.error || 'Sign in with Twitch');
    const twitch = chatStatus === 'live' ? tr('Twitch chat connected') : twitchMessageText(chatDetail || 'Twitch chat disconnected');
    const game = gameStatus === 'connected' ? tr('Connected to the game.') : gameDetail ? tr(gameDetail) : '';
    return [game, twitch].filter(Boolean).join(' ');
  };
  const statusHelp = hoverHelp(light, explanation);
  const paint = () => {
    const state = viewer.getState();
    const health = navigator.onLine === false || gameStatus === 'offline' ? 'network-issues'
      : !state.connected && !state.restoring && !state.connecting || chatStatus === 'auth-required' || chatStatus === 'channel-not-found' || gameStatus === 'stopped' ? 'disconnected'
      : gameStatus === 'retrying' || chatStatus === 'reconnecting' ? 'reconnecting'
      : state.restoring || state.connecting || gameStatus === 'connecting' || chatStatus === 'connecting' ? 'connecting'
      : state.connected && chatStatus === 'live' && (gameStatus === null || gameStatus === 'connected') ? 'connected' : 'disconnected';
    const label = tr(health === 'network-issues' ? 'Network issues' : health === 'connecting' ? 'Connecting…'
      : health === 'reconnecting' ? 'Reconnecting…' : health === 'connected' ? 'Connected'
      : !state.connected || chatStatus === 'auth-required' ? 'Twitch sign-in required' : 'Disconnected');
    light.hidden = !channel;
    light.dataset.connection = health;
    light.classList.toggle('stream-chat-state-online', health === 'connected');
    light.setAttribute('aria-label', label);
    statusHelp.update();
  };
  const refresh = () => {
    const state = viewer.getState();
    header.hidden = !channel;
    changeStreamer.hidden = !channel || !onChangeStreamer;
    gift.hidden = !channel || !!gameId || hasGame || hasKnownStreamerPro(channel) || state.login === channel;
    bindText(gift, 'Gift Pro to {{channel}}', { channel }); giftHelp.update();
    historyLink.textContent = channel;
    historyLink.href = guessRouteUrl('history', location.origin, { channel }).href;
    bindAttribute(historyLink, 'aria-label', '{{player}}’s results', { player: channel });
    actions.hidden = gift.hidden;
    // Switching games does not reconnect the shared transport subscription.
    const next = state.connected && channel ? `${state.userId}/${GUESSR_TRANSPORT_CHANNEL}` : '';
    if (next === key) { paint(); return; }
    key = next; stop?.(); stop = undefined;
    chatStatus = next ? 'connecting' : 'offline'; chatDetail = '';
    paint();
    if (!next) return;
    stop = viewer.watchChat(GUESSR_TRANSPORT_CHANNEL, {
      status: (status, detail) => {
        if (closed || key !== next) return;
        chatStatus = status; chatDetail = detail; paint(); events?.status(status, detail);
      },
      // Ordinary chat is neither retained in memory nor rendered into the page.
      message: message => events?.message(message),
    });
  };
  const unsubscribe = viewer.subscribe(refresh), unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh); window.addEventListener('online', refresh);
  return { panel, setProStatus(value: Parameters<typeof pro.update>[0]) { hasGame = !!value.gameId; pro.update(value); refresh(); },
    transportState() { return { status: chatStatus, detail: chatDetail }; },
    setGameConnection(status: RoomConnection | null, detail = '') { gameStatus = status; gameDetail = detail; paint(); },
    setChannel(value: string) { channel = value; hasGame = false; pro.update({}); refresh(); },
    dispose() {
      closed = true; unsubscribe(); unsubscribeLanguage(); stop?.(); statusHelp.dispose(); giftHelp.dispose(); pro.dispose();
      window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    } };
}
