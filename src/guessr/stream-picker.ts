import { buttonNotice } from './button-notice';
import { ClueViewport } from './clue-viewport';
import { attachClueControls } from './clue-view';
import type { ImageGameConfig } from './image-game';
import { MapBoard } from './map-board';
import { maximumScore, newClueProgress, within, type Point, type ClueProgress } from './rules';
import { STREAM_ROUNDS } from './stream-types';
import { TwitchViewer, twitchMessageText } from './twitch-viewer';
import { decodeViewerClue } from './viewer-clue';
import { viewerChatPanel } from './viewer-chat-panel';
import { supportedCamera } from './clue-camera';
import { watchLiveRoom, type RoomConnection } from './live-room-client';
import type { LiveRoomView } from './live-room-types';
import { guessRouteUrl, readGuessRoute } from './routes';
import { expandStreamResult } from './stream-codec';
import { streamResultsView } from './stream-results';
import { localizedDistance } from './messages';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, onGuessrLanguageChanged, tr } from './i18n';

const ROUND_STORAGE_KEY = 'noitamap-guessr-viewer-round-v1';
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text: string | (() => string) = '') {
  const element = document.createElement(tag);
  element.className = className; if (text) bindText(element, text); return element;
}
function button(label: string, action: () => unknown, className = 'secondary') {
  const element = node('button', className, label);
  element.type = 'button'; element.onclick = () => void action(); return element;
}

/** Round changes replace the clue only: account, transport and map stay connected. */
export function mountStreamPicker(main: HTMLElement, config: ImageGameConfig, viewer: TwitchViewer, imageRoot: string): () => void {
  const url = new URL(location.href);
  const candidate = readGuessRoute(url).channel || '';
  let channel = /^[a-z0-9_]{1,25}$/.test(candidate) ? candidate : '';
  let legacyPayload = new URLSearchParams(url.hash.slice(1)).get('clue');
  let point: Point | null = null, lastSent = '', sending = false, closed = false;
  let viewport: ClueViewport | undefined, clearControls: (() => void) | undefined;
  let snapshot: ReturnType<typeof decodeViewerClue> | undefined;
  let progress: ClueProgress | null = null, roundKey = '';
  let submitted: { playerId: string; point: Point } | null = null;
  let drawnOutcome = '', drawnResults = '';
  let live: LiveRoomView | null = null, connectionState: RoomConnection = 'connecting', connectionDetail = 'Connecting to the NoitaGuessr game…';
  let room: ReturnType<typeof watchLiveRoom> | undefined, roomEpoch = 0;
  let refresh = () => {};
  const saveProgress = () => {
    if (!progress) return;
    try { localStorage.setItem(ROUND_STORAGE_KEY, JSON.stringify({ payload: roundKey, channel, clue: progress, point, sentKey: lastSent, submitted })); }
    catch { /* The active tab remains playable when storage is unavailable. */ }
  };
  const restoreProgress = () => {
    if (!progress || !snapshot) return;
    try {
      const raw = localStorage.getItem(ROUND_STORAGE_KEY);
      const saved = raw && raw.length <= 32000 ? JSON.parse(raw) : null, c = saved?.clue;
      if (saved?.payload === roundKey && saved?.channel === channel && c && supportedCamera(snapshot.source, c)
        && Number.isInteger(c.widest) && c.widest >= Math.max(c.level, progress.widest) && c.widest <= 6
        && Number.isInteger(c.travelSpent) && c.travelSpent >= progress.travelSpent && c.travelSpent <= 5000
        && Array.isArray(c.visited) && c.visited.length <= 512
        && c.visited.every((v: unknown) => typeof v === 'string' && v.length <= 24 && /^-?\d+,-?\d+$/.test(v))) {
        Object.assign(progress, { dx: c.dx, dy: c.dy, level: c.level, widest: c.widest, travelSpent: c.travelSpent,
          visited: [...new Set<string>([...progress.visited, ...c.visited])] });
        if (within(saved.point, config.bounds)) point = { x: saved.point.x, y: saved.point.y };
        if (typeof saved.sentKey === 'string' && saved.sentKey.length <= 320) lastSent = saved.sentKey;
        if (typeof saved.submitted?.playerId === 'string' && /^\d{1,30}$/.test(saved.submitted.playerId)
          && within(saved.submitted.point, config.bounds)) submitted = { playerId: saved.submitted.playerId, point: saved.submitted.point };
      }
    } catch { /* An invalid saved round does not prevent playing. */ }
  };

  const page = main.parentElement;
  page?.classList.add('stream-viewer-page'); main.classList.add('stream-viewer-shell');
  const connection = node('div', 'stream-account'), account = node('span', 'stream-viewer-account');
  const connect = button('Sign in with Twitch', async () => {
    try { await viewer.connect(); } catch (error) { if (!closed) connectNotice.show(twitchMessageText((error as Error).message)); }
  }, 'btn-twitch small');
  const connectNotice = buttonNotice(connect);
  const disconnect = button('Sign out', () => viewer.disconnect(), 'small secondary');
  connection.append(account, connect, disconnect);
  (page?.querySelector('.site-header .header-actions') ?? main).append(connection);
  const round = node('span', 'stream-round stream-header-round'); round.hidden = true;
  const header = page?.querySelector('.site-header');
  if (header) header.insertBefore(round, header.querySelector(':scope > .header-actions'));
  else main.prepend(round);

  const layout = node('div', 'stream-viewer-layout has-clue');
  const cluePanel = node('section', 'game-panel stream-viewer-clue');
  const emptyClue = (detail = 'The next clue appears here automatically.') => {
    bindAttribute(cluePanel, 'aria-label', 'Waiting for a round');
    const empty = node('div', 'stream-clue-empty');
    empty.append(node('strong', '', 'Waiting for a round'), node('p', '', detail));
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      const local = node('a', '', 'Start a local test round'); local.href = '/guess/stream/'; empty.append(local);
    }
    cluePanel.replaceChildren(empty);
  };
  emptyClue(); layout.append(cluePanel);
  const mapPanel = node('section', 'game-panel stream-picker'); bindAttribute(mapPanel, 'aria-label', 'Place your guess');
  const revealBar = node('div', 'panel-bar stream-round-outcome'); revealBar.hidden = true;
  const revealDetails = node('div', 'map-heading'), revealName = node('strong', 'panel-title');
  const revealDistance = node('span', 'stream-reveal-distance'), revealPoints = node('strong', 'badge round-points');
  revealBar.setAttribute('aria-live', 'polite');
  revealDetails.append(revealName, revealDistance); revealBar.append(revealDetails, revealPoints);
  const map = node('div', 'map-board'), actions = node('div', 'stream-guess-actions');
  const signIn = node('div', 'stream-signin');
  const signInError = node('p', 'stream-signin-error'); signInError.setAttribute('role', 'status');
  signIn.append(connect, signInError);
  const budget = node('span', 'stream-maximum'); budget.hidden = true;
  const roomStatus = node('span', 'stream-room-status'); roomStatus.setAttribute('role', 'status');
  const retry = button('Reconnect', () => room?.retry(), 'small secondary'); retry.hidden = true;
  const result = node('a', 'small secondary', 'View results'); result.hidden = true;
  const isHost = () => !!live?.hostId && live.hostId === viewer.getState().userId;
  const canGuess = () => navigator.onLine !== false && !!snapshot && !isHost() && (!!legacyPayload || !!live && connectionState === 'connected'
    && live.online && !live.paused && live.phase === 'guess');
  const send = button('Send guess', async () => {
    if (!point || !channel || !snapshot || !canGuess() || sending || !viewer.getState().connected) return;
    const submittedPoint = { ...point }, submittedChannel = channel, key = guessKey(), identity = roundKey, playerId = viewer.getState().userId!;
    sending = true; refresh();
    try {
      if (live?.roundId) await viewer.sendGuess(submittedChannel, snapshot.round, submittedPoint, progress ? maximumScore(progress) : 5000, live.roundId);
      else if (progress) await viewer.sendGuess(submittedChannel, snapshot.round, submittedPoint, maximumScore(progress));
      else await viewer.sendGuess(submittedChannel, snapshot.round, submittedPoint);
      if (roundKey === identity) {
        lastSent = key; submitted = { playerId, point: submittedPoint }; saveProgress();
        if (!closed) sendNotice.show(tr('Guess sent'), 'success');
      }
    } catch (error) { if (!closed) sendNotice.show(twitchMessageText((error as Error).message)); }
    finally { sending = false; if (!closed) refresh(); }
  }, 'primary');
  const sendNotice = buttonNotice(send);
  actions.append(budget, roomStatus, result, retry, send); mapPanel.append(revealBar, signIn, map, actions); layout.append(mapPanel);
  const resultsPanel = node('section', 'game-panel stream-viewer-results'); resultsPanel.hidden = true;
  layout.append(resultsPanel);
  const chat = viewerChatPanel(viewer, channel, () => {
    channel = ''; legacyPayload = null;
    startRoom(); chat.setChannel('');
    setRound(null, 'choose-channel');
    const next = guessRouteUrl('stream-picker', location.href, { channel: '' });
    const fragment = new URLSearchParams(next.hash.slice(1));
    fragment.delete('clue'); next.hash = fragment.toString();
    history.replaceState(null, '', next);
    showChannelForm().focus(); refresh();
  });
  layout.prepend(chat.panel); main.append(layout);
  const board = new MapBoard(map, config.bounds, config.overview, next => {
    if (within(next, config.bounds)) { point = next; board.setMarkers(next); saveProgress(); refresh(); }
  }, config.map);
  const guessKey = () => point ? `${viewer.getState().userId}/${channel}/${live?.roundId ?? snapshot?.round}/${Math.round(point.x)}/${Math.round(point.y)}/${progress ? maximumScore(progress) : ''}` : '';
  const setRound = (payload: string | null, identity: string) => {
    if (identity === roundKey) return;
    viewport?.destroy(); viewport = undefined; clearControls?.(); clearControls = undefined;
    snapshot = undefined; progress = null; point = null; submitted = null; lastSent = ''; roundKey = identity;
    drawnOutcome = ''; drawnResults = ''; revealBar.hidden = true;
    resultsPanel.hidden = true; cluePanel.hidden = false; mapPanel.hidden = false; layout.classList.remove('show-results');
    if (payload) try {
      snapshot = decodeViewerClue(payload, { imageRoot, version: config.version });
      if (snapshot.round > STREAM_ROUNDS) throw Error();
    } catch { snapshot = undefined; }
    round.hidden = !snapshot; round.textContent = snapshot ? tr('Round {{round}}', { round: formatGuessrNumber(snapshot.round) }) : '';
    if (!snapshot) emptyClue(payload ? 'This clue uses a different map version. Reload the page to update.' : undefined);
    else {
      if (snapshot.assistance) progress = { ...newClueProgress(), ...snapshot.camera, ...snapshot.assistance,
        visited: [...new Set(['0,0', `${snapshot.camera.dx},${snapshot.camera.dy}`])] };
      restoreProgress();
      bindAttribute(cluePanel, 'aria-label', () => tr('Round {{round}} clue', { round: formatGuessrNumber(snapshot!.round) }));
      const clue = node('div', 'clue loading'); cluePanel.replaceChildren(clue);
      if (progress) clearControls = attachClueControls(clue, snapshot.source, progress, 256, () => { saveProgress(); refresh(); }, { compact: true });
      else {
        viewport = new ClueViewport(clue, snapshot.source);
        void viewport.show(snapshot.camera).then(ready => { if (ready) clue.classList.remove('loading'); }).catch(() => {
          if (!closed && roundKey === identity) {
            clue.classList.remove('loading'); clue.replaceChildren(node('p', 'stream-clue-empty', 'Could not load the clue. Reload to retry.'));
          }
        });
      }
    }
    board.setMarkers(point); budget.hidden = !progress; refresh();
  };
  const showOutcome = () => {
    const outcome = live?.outcome, playerId = viewer.getState().userId;
    const revealed = !!outcome && outcome.roundId === live?.roundId && ['reveal', 'complete'].includes(live.phase);
    revealBar.hidden = !revealed;
    if (revealed) {
      const own = outcome.players.find(player => player.id === playerId);
      const displayedGuess = own?.guess ?? (submitted?.playerId === playerId ? submitted.point : null);
      revealName.textContent = guessrGameTerm(outcome.label);
      revealDistance.textContent = !playerId ? tr('Sign in to see your score') : own ? localizedDistance(own.distance) : tr('No guess recorded by the streamer');
      revealDistance.title = displayedGuess
        ? tr('Δx {{x}} · Δy {{y}}', { x: formatGuessrNumber(Math.round(displayedGuess.x - outcome.answer.x)), y: formatGuessrNumber(Math.round(displayedGuess.y - outcome.answer.y)) }) : '';
      revealPoints.textContent = playerId ? tr('{{points}} points', { points: formatGuessrNumber(own?.score ?? 0), count: own?.score ?? 0 }) : '—';
      const key = `${roundKey}/${playerId ?? ''}/${own?.score ?? 'missing'}`;
      if (key !== drawnOutcome) {
        drawnOutcome = key;
        board.setLocked(true); board.setMarkers(displayedGuess, outcome.answer);
        if (clearControls && snapshot) {
          clearControls(); clearControls = undefined;
          const clue = cluePanel.querySelector<HTMLElement>('.clue')!;
          viewport = new ClueViewport(clue, snapshot.source);
          void viewport.show({ dx: 0, dy: 0, level: 6 }).catch(() => {});
        }
      }
    } else board.setLocked(false);
    budget.hidden = !progress || revealed;
    if (live?.phase === 'complete' && live.result) {
      const key = `${live.gameId}/${playerId ?? ''}`;
      if (drawnResults !== key) {
        drawnResults = key;
        const summary = streamResultsView(expandStreamResult(live.result!), playerId ?? undefined);
        const open = node('a', 'secondary', 'Open results page');
        open.href = guessRouteUrl('stream-result', location.origin, { result: live.resultId ?? live.gameId! }).href;
        const links = node('div', 'action-row'); links.append(open);
        resultsPanel.replaceChildren(summary, links);
      }
      cluePanel.hidden = true; mapPanel.hidden = true; resultsPanel.hidden = false;
      layout.classList.add('show-results'); round.textContent = tr('Results'); round.hidden = false;
    }
  };
  const startRoom = () => {
    const epoch = ++roomEpoch;
    room?.dispose(); room = undefined; live = null;
    connectionState = 'connecting'; connectionDetail = '';
    chat.setGameConnection(legacyPayload || !channel ? null : 'connecting', 'Connecting to the NoitaGuessr game…');
    if (legacyPayload || !channel) return;
    room = watchLiveRoom(channel, {
      state: state => {
        if (closed || epoch !== roomEpoch || live && state.revision < live.revision) return;
        live = state;
        chat.setProStatus(state);
        setRound(state.clue, state.gameId && state.roundId ? `${state.gameId}/${state.roundId}` : `waiting/${channel}`);
        refresh();
      },
      status: (state, detail) => {
        if (closed || epoch !== roomEpoch) return;
        connectionState = state; connectionDetail = detail; chat.setGameConnection(state, detail); refresh();
      },
    });
  };
  const showChannelForm = () => {
    const form = node('form', 'stream-channel-form'), input = node('input');
    input.name = 'channel'; bindAttribute(input, 'placeholder', 'Twitch channel'); bindAttribute(input, 'aria-label', 'Twitch channel');
    input.required = true; input.maxLength = 26; input.pattern = '@?[A-Za-z0-9_]{1,25}';
    const enteredChannel = () => input.value.replace(/^@/, '').toLowerCase();
    const joinLabel = () => /^[a-z0-9_]{1,25}$/.test(enteredChannel())
      ? tr('Join {{channel}}’s game', { channel: enteredChannel() }) : tr('Join game');
    const open = node('button', 'btn-solid theme-primary primary', joinLabel);
    open.type = 'submit'; form.append(input, open);
    input.addEventListener('input', () => bindText(open, joinLabel));
    form.onsubmit = event => {
      event.preventDefault();
      const next = enteredChannel();
      if (!/^[a-z0-9_]{1,25}$/.test(next)) return;
      channel = next; history.replaceState(null, '', guessRouteUrl('stream-picker', url, { channel }));
      form.remove(); chat.setChannel(channel); startRoom(); refresh();
    };
    chat.panel.prepend(form);
    return input;
  };
  if (!channel) showChannelForm();
  refresh = () => {
    const state = viewer.getState();
    signIn.hidden = state.connected;
    map.hidden = !state.connected;
    signInError.textContent = state.error ? twitchMessageText(state.error) : '';
    signInError.hidden = !state.error;
    if (snapshot) round.textContent = tr('Round {{round}}', { round: formatGuessrNumber(snapshot.round) });
    showOutcome();
    if (progress) budget.textContent = tr('Up to {{points}} points', { points: formatGuessrNumber(maximumScore(progress)), count: maximumScore(progress) });
    account.textContent = state.connected ? tr('Playing as {{player}}', { player: state.login! }) : '';
    connect.hidden = state.connected; connect.disabled = state.connecting;
    bindText(connect, state.restoring ? 'Restoring Twitch…' : state.connecting ? 'Signing in…' : 'Sign in with Twitch');
    disconnect.hidden = !state.connected; disconnect.disabled = state.sending;
    send.disabled = !canGuess() || !state.connected || !point || !channel || sending || state.sending || guessKey() === lastSent;
    bindText(send, sending ? 'Sending…' : guessKey() && guessKey() === lastSent ? 'Sent' : 'Send guess');
    bindAttribute(send, 'title', isHost() ? 'You are the streamer. Submit your guess in the streamer tab.' : !channel ? 'Choose a Twitch channel'
      : !legacyPayload && connectionState !== 'connected' ? 'The NoitaGuessr game connection is unavailable'
      : !snapshot ? 'Waiting for the streamer to start a round'
      : live?.phase === 'complete' ? 'This game has finished'
      : live?.phase === 'reveal' ? 'This round is closed'
      : live && !live.online ? 'The streamer is disconnected from NoitaGuessr'
      : live?.paused ? 'The streamer has paused this round'
      : !state.connected ? 'Sign in with Twitch' : !point ? 'Place a pin first' : '');
    retry.hidden = !!legacyPayload || connectionState !== 'stopped';
    if (!legacyPayload && connectionState === 'connected') {
      bindText(roomStatus, !live || live.phase === 'waiting' ? 'No active NoitaGuessr game'
        : live.phase === 'complete' ? 'Game finished' : live.phase === 'reveal' ? 'Round closed'
        : !live.online ? 'Streamer disconnected from NoitaGuessr' : live.paused ? 'Paused' : isHost() ? 'You are the streamer' : '');
    } else bindText(roomStatus, connectionDetail);
    roomStatus.hidden = !channel || !!legacyPayload || !roomStatus.textContent;
    result.hidden = !live?.resultId;
    if (live?.resultId) result.href = guessRouteUrl('stream-result', location.origin, { result: live.resultId }).href;
  };
  if (legacyPayload) setRound(legacyPayload, legacyPayload);
  const unsubscribe = viewer.subscribe(refresh);
  const unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('online', refresh);
  startRoom(); refresh();
  return () => {
    closed = true; room?.dispose(); unsubscribe(); unsubscribeLanguage(); chat.dispose(); board.destroy(); viewport?.destroy(); clearControls?.();
    window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    connectNotice.dispose(); sendNotice.dispose(); connection.remove(); round.remove();
    page?.classList.remove('stream-viewer-page'); main.classList.remove('stream-viewer-shell');
  };
}
