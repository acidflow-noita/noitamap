import type { TwitchViewer } from './twitch-viewer';
import { streamerProStatus } from './streamer-pro-status';
import { bindAttribute, bindText, onGuessrLanguageChanged, tr } from './i18n';
import { guessRouteUrl } from './routes';
import { twitchMessageText } from './twitch-viewer';
import { gameApiOrigin } from './api';
import { hoverHelp } from './hover-help';
import type { RoomConnection } from './live-room-types';
import { updateGameConnection } from './game-chrome';

/** Account identity and the durable game's connection state. */
export function viewerChatPanel(viewer: TwitchViewer, initialChannel: string, onChangeStreamer?: () => void,
  gameId?: string, options: { pvp?: boolean } = {}) {
  const panel = document.createElement('section'); panel.className = 'game-panel stream-connection-bar';
  const header = document.createElement('div'); header.className = 'stream-chat-header';
  const title = document.createElement('strong');
  const historyLink = document.createElement('a'); historyLink.className = 'stream-channel-link';
  historyLink.target = '_blank'; historyLink.rel = 'noopener noreferrer'; title.append(historyLink);
  const identity = document.createElement('div'); identity.className = 'stream-chat-identity';
  const pro = streamerProStatus({ channel: initialChannel, player: options.pvp, local: !gameApiOrigin() && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) });
  const changeStreamer = bindText(document.createElement('button'), 'Exit game');
  changeStreamer.type = 'button'; changeStreamer.className = 'btn btn-sm btn-outline theme-secondary stream-change-channel';
  changeStreamer.onclick = () => onChangeStreamer?.();
  const name = document.createElement('span'); name.className = 'stream-name';
  name.append(title, pro.badge); identity.append(name);
  const mode = bindText(document.createElement('span'), options.pvp ? '1v1' : 'Chat vs Streamer'); mode.className = 'stream-mode-label'; identity.append(mode);
  const gift = document.createElement('button'); gift.type = 'button'; gift.className = 'btn btn-patron stream-gift-pro';
  gift.dataset.proGift = 'choose';
  gift.onclick = () => { void import('./pro-gift-dialog').then(({ showStreamerGift }) => showStreamerGift(channel)); };
  const heading = document.createElement('div'); heading.className = 'stream-chat-heading';
  heading.append(changeStreamer, identity);
  const actions = document.createElement('div'); actions.className = 'stream-chat-actions'; actions.append(gift);
  header.append(heading, actions); panel.append(header);
  let channel = initialChannel, hasGame = false;
  let gameStatus: RoomConnection | null = null, gameDetail = '';
  let pvpPlayers: import('./stream-types').StreamPlayer[] = [];
  let renderedPlayers = '';
  const renderPlayers = () => {
    if (!pvpPlayers.length) { historyLink.textContent = tr('1v1'); return; }
    const signature = JSON.stringify([pvpPlayers.map(player => [player.id, player.name]), tr('Waiting for an opponent')]);
    if (signature === renderedPlayers && historyLink.contains(pro.badge)) return;
    renderedPlayers = signature;
    const creator = document.createElement('span'); creator.className = 'stream-name';
    const label = document.createElement('strong'); label.textContent = pvpPlayers[0].name;
    creator.append(label, pro.badge);
    const versus = document.createElement('span'); versus.textContent = ' vs ';
    const opponent = document.createElement('strong'); opponent.textContent = pvpPlayers[1]?.name ?? tr('Waiting for an opponent');
    historyLink.replaceChildren(creator, versus, opponent);
  };
  const giftHelp = hoverHelp(gift, () => tr('Gift {{channel}} a subscription to wuote’s Twitch channel. Subscribers to wuote have Pro access and can start NoitaGuessr games for their chat.', { channel }));
  const explanation = () => {
    if (navigator.onLine === false) return tr('You are offline. Reconnect to continue.');
    const state = viewer.getState();
    if (!state.connected) return twitchMessageText(state.error || 'Sign in with Twitch');
    return gameStatus === 'connected' ? tr('Connected to the game.') : gameDetail ? tr(gameDetail) : '';
  };
  const paint = () => {
    const state = viewer.getState();
    const health = navigator.onLine === false ? 'network-issues'
      : state.connected && gameStatus === 'connected' ? 'connected'
      : gameStatus === 'offline' ? 'network-issues'
      : !state.connected && !state.restoring && !state.connecting || gameStatus === 'stopped' ? 'disconnected'
      : gameStatus === 'retrying' ? 'reconnecting'
      : state.restoring || state.connecting || gameStatus === 'connecting' ? 'connecting'
      : 'disconnected';
    const label = tr(health === 'network-issues' ? 'Network issues' : health === 'connecting' ? 'Connecting…'
      : health === 'reconnecting' ? 'Reconnecting…' : health === 'connected' ? 'Connected'
      : !state.connected ? 'Twitch sign-in required' : 'Disconnected');
    if (panel.isConnected) updateGameConnection(health === 'network-issues' ? 'offline' : health, explanation());

  };
  const refresh = () => {
    const state = viewer.getState();
    header.hidden = !channel;
    changeStreamer.hidden = !channel || !onChangeStreamer;
    gift.hidden = !!options.pvp || !channel || !!gameId || hasGame || state.login === channel;
    bindText(gift, 'Gift Pro to {{channel}}', { channel }); giftHelp.update();
    if (!options.pvp) {
      if (historyLink.textContent !== channel) historyLink.textContent = channel;
      historyLink.href = guessRouteUrl('history', location.origin, { channel }).href;
      bindAttribute(historyLink, 'aria-label', '{{player}}’s results', { player: channel });
    } else renderPlayers();
    actions.hidden = gift.hidden;
    paint();
  };
  const unsubscribe = viewer.subscribe(refresh), unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh); window.addEventListener('online', refresh);
  return { panel, setProStatus(value: Parameters<typeof pro.update>[0]) { hasGame = !!value.gameId; pro.update(value); refresh(); },
    setPlayers(players: import('./stream-types').StreamPlayer[]) {
      if (!options.pvp || !players.length) return;
      pvpPlayers = players; renderPlayers();
    },
    setGameConnection(status: RoomConnection | null, detail = '') { gameStatus = status; gameDetail = detail; paint(); },
    setChannel(value: string) { if (value === channel) return; channel = value; hasGame = false; pro.update({}); refresh(); },
    dispose() {
      unsubscribe(); unsubscribeLanguage(); giftHelp.dispose(); pro.dispose();
      window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    } };
}
