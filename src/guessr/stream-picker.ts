import { ClueViewport } from './clue-viewport';
import { fitClueToPanel } from './clue-stage';
import { attachClueControls } from './clue-view';
import { difficultyIndicator, maximumIndicator, updateRoundIndicators } from './round-status';
import type { ImageGameConfig } from './image-game';
import { MapBoard } from './map-board';
import { maximumScore, newClueProgress, within, type Point, type ClueProgress } from './rules';
import { STREAM_ROUNDS } from './stream-types';
import { STREAM_SUBMISSION_GRACE_MS } from './stream-timing';
import { TwitchViewer, twitchMessageText } from './twitch-viewer';
import { decodeViewerClue } from './viewer-clue';
import { viewerChatPanel } from './viewer-chat-panel';
import { supportedCamera } from './clue-camera';
import type { RoomConnection } from './live-room-types';
import { watchTwitchGame } from './twitch-game-client';
import { StreamViewerHistory } from './stream-viewer-history';
import { guessReceiptKey, guessRejectionText } from './stream-wire';
import type { LiveRoomView } from './live-room-types';
import { guessRouteUrl, readGuessRoute } from './routes';
import { expandStreamResult } from './stream-codec';
import { streamResultsView } from './stream-results';
import { rememberPublishedStream } from './stream-history-records';
import { localizedDistance } from './messages';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, onGuessrLanguageChanged, tr } from './i18n';
import { pageHeading } from './page-heading';
import { hoverHelp } from './hover-help';

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
export function mountStreamPicker(main: HTMLElement, config: ImageGameConfig, viewer: TwitchViewer, imageRoot: string, onLeave?: () => void): () => void {
  const url = new URL(location.href);
  const candidate = readGuessRoute(url).channel || '';
  let requestedGame = readGuessRoute(url).game;
  const twitchUpdates = !new URLSearchParams(url.hash.slice(1)).has('clue');
  const personal = new StreamViewerHistory(config.bounds);
  personal.identify(requestedGame, viewer.getState().userId ?? viewer.getState().savedUserId ?? null);
  let feed: ReturnType<typeof watchTwitchGame> | undefined;
  let reviewedRound: number | null = null, lastSendAt = 0, actionError = '', sendReason = '';
  let recoveryRequested = '';
  let unavailableGame = false;
  let channel = /^[a-z0-9_]{1,25}$/.test(candidate) ? candidate : '';
  let legacyPayload = new URLSearchParams(url.hash.slice(1)).get('clue');
  const leave = onLeave ?? (() => { location.href = '/guess/'; });
  if (!channel && !legacyPayload) {
    const panel = node('section', 'card card-body rounded-9 stream-join-instructions');
    panel.append(pageHeading(node('h1', '', 'Play as chatter'), button('Back', leave)),
      node('p', '', 'Open the game link shared by your streamer.'));
    main.append(panel); return () => {};
  }
  let point: Point | null = null, lastSent = '', sending = false, closed = false;
  let sendingRound: number | undefined;
  let viewport: ClueViewport | undefined, clearControls: (() => void) | undefined;
  let snapshot: ReturnType<typeof decodeViewerClue> | undefined;
  let progress: ClueProgress | null = null, roundKey = '';
  let submitted: { playerId: string; point: Point } | null = null;
  let drawnOutcome = '', drawnResults = '';
  let clearResults: (() => void) | undefined;
  let live: LiveRoomView | null = null, connectionState: RoomConnection = 'connecting', connectionDetail = 'Connecting to the NoitaGuessr game…';
  let room: ReturnType<typeof watchTwitchGame> | undefined, roomEpoch = 0;
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
    try { actionError = ''; await viewer.connect(); } catch (error) { if (!closed) { actionError = twitchMessageText((error as Error).message); refresh(); } }
  }, 'btn-twitch small');
  const disconnect = button('Sign out', () => viewer.disconnect(), 'small secondary');
  connection.append(account, connect, disconnect);
  (page?.querySelector('.site-header .header-actions') ?? main).append(connection);
  const round = node('strong', 'stream-round');

  const layout = node('div', 'stream-viewer-layout has-clue');
  const cluePanel = node('section', 'game-panel stream-viewer-clue');
  const emptyClue = (detail = 'The next clue appears here automatically.', title = 'Waiting for a round') => {
    bindAttribute(cluePanel, 'aria-label', 'Waiting for a round');
    const empty = node('div', 'stream-clue-empty');
    empty.append(node('strong', '', title), node('p', '', detail));
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
  const joinGame = button('Join game', () => { feed?.join(); refresh(); }, 'primary');
  bindText(joinGame, () => tr('Join {{channel}}’s game', { channel }));
  joinGame.hidden = true; signIn.append(connect, joinGame, signInError);
  const budget = maximumIndicator(); budget.classList.add('stream-maximum'); budget.hidden = true;
  const budgetBar = node('div', 'panel-bar stream-budget-bar'); budgetBar.hidden = true;
  budgetBar.append(budget); mapPanel.prepend(budgetBar);
  const roomStatus = node('span', 'stream-room-status'); roomStatus.setAttribute('role', 'status');
  const retry = button('Reconnect', () => room?.retry(), 'small secondary'); retry.hidden = true;
  const delivery = node('span', 'stream-delivery'); delivery.setAttribute('role', 'status');
  const timer = node('span', 'stream-round-timer'); timer.hidden = !twitchUpdates;
  const previousResult = button('View results', () => {
    if (!live) return;
    for (let i = 9; i >= 0; i--) if (personal.round(i).reveal) { reviewedRound = i; drawnOutcome = ''; refresh(); break; }
  }, 'small secondary'); previousResult.hidden = true;
  const returnToRound = button('Back', () => { reviewedRound = null; drawnOutcome = ''; board.setMarkers(point); refresh(); }, 'small secondary');
  returnToRound.hidden = true; revealBar.prepend(returnToRound);
  const result = node('a', 'small secondary', 'View results'); result.hidden = true;
  const isHost = () => !!live?.hostId && live.hostId === viewer.getState().userId;
  const gameNow = () => feed?.now() ?? Date.now();
  const canGuess = () => (!twitchUpdates || !!feed?.hasJoined()) && reviewedRound === null && navigator.onLine !== false && !!snapshot && !isHost() && (!!legacyPayload || !!live && connectionState === 'connected'
    && live.online && !live.paused && live.phase === 'guess' && (!live.timing || gameNow() >= live.timing.startsAt
      && (live.timing.deadline === null || gameNow() < live.timing.deadline)));
  const send = button('Send guess', async () => {
    if (!point || !channel || !snapshot || !canGuess() || sending || !viewer.getState().connected) return;
    const submittedPoint = { x: Math.round(point.x), y: Math.round(point.y) }, submittedChannel = channel, key = guessKey(), identity = roundKey, playerId = viewer.getState().userId!;
    const submittedRound = snapshot.round;
    const submittedMaximum = progress ? maximumScore(progress) : 5000;
    const target = live?.roundId ? { roundId: live.roundId, gameId: live.gameId!,
      sendDeadline: live.timing?.deadline == null ? undefined : Date.now() + live.timing.deadline - gameNow() + STREAM_SUBMISSION_GRACE_MS } : undefined;
    sending = true; sendingRound = submittedRound - 1; lastSendAt = Date.now(); actionError = ''; refresh();
    let receipt: string | undefined;
    try {
      if (twitchUpdates && target) {
        const nonce = crypto.getRandomValues(new Uint8Array(8));
        receipt = await guessReceiptKey(target.roundId, playerId, Array.from(nonce, n => n.toString(16).padStart(2, '0')).join(''));
        // The click was allowed before zero. A round update while hashing or
        // sending must not cancel it, retarget it, or borrow the next allowance.
        if (closed || live?.gameId !== target.gameId || viewer.getState().userId !== playerId) return;
        personal.identify(target.gameId, playerId);
        personal.submit(submittedRound - 1, receipt, submittedPoint, submittedMaximum);
        refresh();
        await viewer.sendGuess(submittedChannel, submittedRound, submittedPoint, submittedMaximum, target.roundId, nonce, target.gameId, target.sendDeadline);
        personal.markSent(submittedRound - 1, receipt);
      }
      else if (target) await viewer.sendGuess(submittedChannel, submittedRound, submittedPoint, submittedMaximum, target.roundId);
      else if (progress) await viewer.sendGuess(submittedChannel, submittedRound, submittedPoint, submittedMaximum);
      else await viewer.sendGuess(submittedChannel, submittedRound, submittedPoint);
      if (roundKey === identity) {
        lastSent = key; lastSendAt = Date.now(); submitted = { playerId, point: submittedPoint }; saveProgress();
      }
    } catch (error) {
      if (receipt && ['dropped', 'forbidden', 'expired', 'invalid-guess', 'disconnected', 'rate-limit', 'busy', 'round-closed'].includes((error as { code?: string }).code ?? ''))
        personal.receipts(submittedRound - 1, [receipt], true);
      if (!closed) actionError = (roundKey === identity ? '' : `${tr('Round {{round}}', { round: formatGuessrNumber(submittedRound) })}: `)
        + twitchMessageText((error as Error).message);
    }
    finally { sending = false; sendingRound = undefined; if (!closed) refresh(); }
  }, 'primary');
  const sendControl = node('span', 'stream-send-control'); sendControl.append(send);
  const sendHelp = hoverHelp(sendControl, () => tr(sendReason), send);
  const secondaryActions = node('div', 'stream-secondary-actions');
  secondaryActions.append(previousResult, result, retry);
  actions.append(delivery, sendControl, secondaryActions); mapPanel.append(revealBar, signIn, map, actions); layout.append(mapPanel);
  const resultsPanel = node('section', 'game-panel stream-viewer-results'); resultsPanel.hidden = true;
  layout.append(resultsPanel);
  const chat = viewerChatPanel(viewer, channel, leave,
    { message: message => { void feed?.receive(message); }, status: (status, detail) => feed?.transport(status, detail) }, requestedGame);
  const toolbar = chat.panel.querySelector<HTMLElement>('.stream-chat-header')!;
  toolbar.classList.add('stream-toolbar');
  toolbar.querySelector('.stream-chat-heading')?.classList.add('stream-toolbar-navigation');
  toolbar.querySelector('.stream-chat-actions')?.classList.add('stream-toolbar-actions');
  const phase = node('div', 'stream-toolbar-round'); phase.append(round, timer); toolbar.insertBefore(phase, toolbar.lastElementChild);
  roomStatus.className = 'stream-room-status stream-activity'; chat.panel.append(roomStatus);
  layout.prepend(chat.panel); main.append(layout);
  const board = new MapBoard(map, config.bounds, config.overview, next => {
    if (within(next, config.bounds)) { point = next; board.setMarkers(next); saveProgress(); refresh(); }
  }, config.map);
  const guessKey = () => point ? `${viewer.getState().userId}/${channel}/${live?.roundId ?? snapshot?.round}/${Math.round(point.x)}/${Math.round(point.y)}/${progress ? maximumScore(progress) : ''}` : '';
  const setRound = (payload: string | null, identity: string) => {
    if (identity === roundKey && (!!payload === !!snapshot)) return;
    clearResults?.(); clearResults = undefined;
    viewport?.destroy(); viewport = undefined; clearControls?.(); clearControls = undefined;
    snapshot = undefined; progress = null; point = null; submitted = null; lastSent = ''; actionError = ''; roundKey = identity;
    reviewedRound = null;
    drawnOutcome = ''; drawnResults = ''; revealBar.hidden = true;
    resultsPanel.hidden = true; cluePanel.hidden = false; mapPanel.hidden = false; layout.classList.remove('show-results');
    if (payload) try {
      snapshot = decodeViewerClue(payload, { imageRoot, version: config.version });
      if (snapshot.round > STREAM_ROUNDS) throw Error();
    } catch { snapshot = undefined; }
    round.textContent = snapshot ? tr('Round {{value1}} / {{value2}}', { value1: formatGuessrNumber(snapshot.round), value2: formatGuessrNumber(STREAM_ROUNDS) }) : tr('Ready to start');
    if (!snapshot) emptyClue(payload ? 'This clue uses a different map version. Reload the page to update.' : undefined);
    else {
      if (snapshot.assistance) progress = { ...newClueProgress(), ...snapshot.camera, ...snapshot.assistance,
        visited: [...new Set(['0,0', `${snapshot.camera.dx},${snapshot.camera.dy}`])] };
      restoreProgress();
      bindAttribute(cluePanel, 'aria-label', () => tr('Round {{round}} clue', { round: formatGuessrNumber(snapshot!.round) }));
      const clueBar = node('div', 'panel-bar'), heading = node('div', 'clue-heading');
      heading.append(node('span', 'panel-title', 'Where are you?'), difficultyIndicator()); clueBar.append(heading);
      const clue = node('div', 'clue loading'); cluePanel.replaceChildren(clueBar, clue);
      if (progress) clearControls = attachClueControls(clue, snapshot.source, progress, 256, () => { saveProgress(); refresh(); },
        { compact: true, difficultyTier: () => live?.difficultyTier });
      else {
        viewport = new ClueViewport(clue, snapshot.source);
        void viewport.show(snapshot.camera).then(ready => { if (ready) clue.classList.remove('loading'); }).catch(() => {
          if (!closed && roundKey === identity) {
            clue.classList.remove('loading'); clue.replaceChildren(node('p', 'stream-clue-empty', 'Could not load the clue. Reload to retry.'));
          }
        });
      }
      fitClueToPanel(clue);
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
        ? tr('Δx {{x}}, Δy {{y}}', { x: formatGuessrNumber(Math.round(displayedGuess.x - outcome.answer.x)), y: formatGuessrNumber(Math.round(displayedGuess.y - outcome.answer.y)) }) : '';
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
      if (live.resultId && channel) rememberPublishedStream(live.resultId, channel);
      const key = `${live.gameId}/${playerId ?? ''}`;
      if (drawnResults !== key) {
        drawnResults = key;
        clearResults?.();
        const summary = streamResultsView(expandStreamResult(live.result!), playerId ?? undefined);
        clearResults = summary.destroy;
        const open = node('a', 'secondary', 'Open results page');
        open.href = guessRouteUrl('stream-result', location.origin, { result: live.resultId ?? live.gameId! }).href;
        const links = node('div', 'action-row'); links.append(open);
        resultsPanel.replaceChildren(summary, links);
      }
      cluePanel.hidden = true; mapPanel.hidden = true; resultsPanel.hidden = false;
      layout.classList.add('show-results'); round.textContent = tr('Results'); round.hidden = false;
    }
  };
  const showPersonalOutcome = () => {
    if (!twitchUpdates || !live) return;
    if (!viewer.getState().userId && !viewer.getState().savedUserId) { resultsPanel.hidden = true; return; }
    const current = personal.round(live.round - 1);
    const index = reviewedRound ?? (live.phase !== 'guess' && current.reveal ? live.round - 1 : null);
    const own = index === null ? undefined : personal.round(index);
    revealBar.hidden = !own?.reveal;
    returnToRound.hidden = reviewedRound === null;
    if (own?.reveal) {
      const score = own.score;
      revealName.textContent = `${tr('Round {{round}}', { round: formatGuessrNumber(index! + 1) })}: ${guessrGameTerm(own.reveal.area.label)}`;
      revealDistance.textContent = own.pending ? tr('Waiting for confirmation') : !own.received ? tr('No guess recorded by the streamer') : localizedDistance(score?.distance ?? null);
      revealPoints.textContent = own.pending ? '…' : tr('{{points}} points', { points: formatGuessrNumber(score?.score ?? 0), count: score?.score ?? 0 });
      const key = `${live.gameId}/${index}/${own.received?.key}/${own.pending}`;
      if (drawnOutcome !== key) { drawnOutcome = key; board.setMarkers(own.received?.point ?? null, own.reveal.answer); }
      board.setLocked(true);
    } else board.setLocked(!canGuess());
    let latest = -1;
    for (let i = 0; i < 10; i++) if (personal.round(i).reveal) latest = i;
    previousResult.hidden = latest < 0 || reviewedRound !== null;
    if (latest >= 0) {
      const latestResult = personal.round(latest);
      bindText(previousResult, () => `${tr('Round {{round}}', { round: formatGuessrNumber(latest + 1) })}: ${latestResult.pending ? '…' : formatGuessrNumber(latestResult.score?.score ?? 0)}`);
    }
    if (live.phase === 'complete') {
      if (live.resultId && channel) rememberPublishedStream(live.resultId, channel);
      const signature = `${viewer.getState().userId ?? viewer.getState().savedUserId}/${viewer.getState().connected}/`
        + Array.from({ length: 10 }, (_, i) => { const r = personal.round(i); return `${r.score?.score}/${r.pending}/${r.received?.key}`; }).join('/');
      if (drawnResults !== signature) {
        drawnResults = signature;
        const heading = node('h1', '', viewer.getState().connected ? 'Your result' : 'Saved result');
        const waiting = Array.from({ length: 10 }, (_, i) => personal.round(i)).some(r => r.pending || r.received && !r.reveal);
        const total = node('strong', 'stream-rank', () => waiting ? tr('Waiting for results')
          : tr('{{points}} points', { points: formatGuessrNumber(personal.total()), count: personal.total() }));
        const table = node('table', 'table'), body = node('tbody');
        for (let i = 0; i < 10; i++) {
          const r = personal.round(i), row = node('tr');
          row.append(node('td', '', () => tr('Round {{round}}', { round: formatGuessrNumber(i + 1) })),
            node('td', '', r.reveal ? () => guessrGameTerm(r.reveal!.area.label) : '—'),
            node('td', 'score', r.pending ? 'Waiting for confirmation' : r.received && !r.reveal ? 'Waiting for results'
              : r.received ? () => formatGuessrNumber(r.score?.score ?? 0) : '—'));
          body.append(row);
        }
        table.append(body); const links = node('div', 'action-row'); links.append(result);
        resultsPanel.replaceChildren(heading, total, table, links);
      }
      cluePanel.hidden = true; mapPanel.hidden = true; resultsPanel.hidden = false; layout.classList.add('show-results');
    }
  };
  const startRoom = () => {
    const epoch = ++roomEpoch;
    room?.dispose(); room = undefined; feed?.dispose(); feed = undefined; live = null; recoveryRequested = '';
    connectionState = 'connecting'; connectionDetail = '';
    chat.setGameConnection(legacyPayload || !channel ? null : 'connecting', 'Connecting to the NoitaGuessr game…');
    if (legacyPayload || !channel) return;
    const handlers = {
      state: state => {
        if (closed || epoch !== roomEpoch || live && state.revision < live.revision) return;
        unavailableGame = !!requestedGame && state.gameId !== requestedGame;
        if (unavailableGame) {
          live = null; chat.setProStatus({}); setRound(null, `unavailable/${requestedGame}`); refresh(); return;
        }
        if (!requestedGame && state.gameId) {
          requestedGame = state.gameId;
          history.replaceState(null, '', guessRouteUrl('stream-picker', location.href, { channel, game: requestedGame }));
        }
        live = state;
        personal.identify(state.gameId ?? requestedGame, viewer.getState().userId ?? viewer.getState().savedUserId ?? null);
        chat.setProStatus(state);
        setRound(state.clue, state.gameId && state.roundId ? `${state.gameId}/${state.roundId}` : `waiting/${channel}`);
        if (state.ended) emptyClue('The streamer ended this game.', 'Game ended');
        else if (state.timing?.phase === 'lobby') emptyClue('Waiting for the streamer to start the game.', 'Ready to start');
        if (twitchUpdates && feed) {
          const recovery = personal.recovery(state.timing?.revealed ?? 0);
          const signature = JSON.stringify(recovery);
          if ((recovery.missing || recovery.receipts.length) && signature !== recoveryRequested) {
            recoveryRequested = signature; feed.requestRecovery();
          }
        }
        refresh();
      },
      status: (state, detail) => {
        if (closed || epoch !== roomEpoch) return;
        connectionState = state; connectionDetail = detail; chat.setGameConnection(state, detail); refresh();
      },
    } satisfies Pick<Parameters<typeof watchTwitchGame>[3], 'state' | 'status'>;
    if (twitchUpdates) {
      feed = watchTwitchGame(viewer, channel, requestedGame, { ...handlers,
        recovery: () => personal.recovery(live?.timing?.revealed ?? 0),
        reveal: (round, reveal) => { personal.reveal(round, reveal); refresh(); },
        receipts: (round, keys, rejected, reason) => {
          const before = personal.round(round);
          personal.receipts(round, keys, rejected, reason);
          if (before.pending && !personal.round(round).pending) {
            if (rejected && reason === 'closed' && live && round === live.round - 1) {
              live = { ...live, phase: 'reveal' }; feed?.requestRecovery();
            }
            const recovery = personal.recovery(live?.timing?.revealed ?? 0);
            if (recovery.missing || recovery.receipts.length) feed?.requestRecovery();
          }
          refresh();
        },
      });
      room = feed;
      const transport = chat.transportState(); feed.transport(transport.status, transport.detail);
    }
  };
  refresh = () => {
    const state = viewer.getState();
    personal.identify(live?.gameId ?? requestedGame, state.userId ?? state.savedUserId ?? null);
    if (twitchUpdates && live?.phase === 'complete' && !state.connected) connection.insertBefore(connect, disconnect);
    else if (connect.parentElement !== signIn) signIn.prepend(connect);
    const joined = !twitchUpdates || !!feed?.hasJoined();
    signIn.hidden = state.connected && joined || reviewedRound !== null;
    map.hidden = (!state.connected || !joined) && reviewedRound === null;
    joinGame.hidden = !state.connected || joined;
    signInError.textContent = actionError || (state.error ? twitchMessageText(state.error) : '');
    signInError.hidden = !signInError.textContent;
    if (snapshot) round.textContent = tr('Round {{value1}} / {{value2}}', { value1: formatGuessrNumber(snapshot.round), value2: formatGuessrNumber(STREAM_ROUNDS) });
    if (twitchUpdates) showPersonalOutcome(); else showOutcome();
    if (progress) updateRoundIndicators(layout, progress,
      reviewedRound === null ? live?.difficultyTier : personal.round(reviewedRound).reveal?.area.difficultyTier);
    budgetBar.hidden = !progress || reviewedRound !== null || !revealBar.hidden;
    budget.hidden = budgetBar.hidden;
    account.textContent = state.connected ? tr('Playing as {{player}}', { player: state.login! }) : '';
    connect.hidden = state.connected; connect.disabled = state.connecting;
    bindText(connect, state.restoring ? 'Restoring Twitch…' : state.connecting ? 'Signing in…' : 'Sign in with Twitch');
    disconnect.hidden = !state.connected; disconnect.disabled = state.sending;
    const own = live ? personal.round(live.round - 1) : null;
    let deliveryRound = live ? live.round - 1 : undefined;
    if (sending && sendingRound !== undefined) deliveryRound = sendingRound;
    else if (twitchUpdates && live && !own?.submitted) {
      for (let previous = live.round - 2; previous >= 0; previous--) {
        if (personal.round(previous).pending) { deliveryRound = previous; break; }
      }
    }
    const deliveryOwn = deliveryRound === undefined ? own : personal.round(deliveryRound);
    const previousDelivery = !!live && deliveryRound !== undefined && deliveryRound !== live.round - 1;
    const sameGuess = !!guessKey() && guessKey() === lastSent;
    const mayResend = twitchUpdates && sameGuess && (own?.lastStatus === 'rejected' || own?.pending && Date.now() - lastSendAt >= 15_000);
    send.disabled = !canGuess() || !state.connected || !point || !channel || sending || state.sending || sameGuess && !mayResend;
    bindText(send, mayResend ? 'Resend guess' : own?.submitted && !sameGuess ? 'Update guess' : 'Send guess');
    const receiptStatus = live?.ended ? 'The streamer ended this game.' : sending ? 'Sending…' : deliveryOwn?.pending ? deliveryOwn.received ? 'Update awaiting confirmation. Previous guess counts.'
      : deliveryOwn.sent ? 'Sent to Twitch. Waiting for the streamer’s confirmation.' : 'Waiting for confirmation'
      : deliveryOwn?.lastStatus === 'rejected' ? deliveryOwn.received ? 'Update not received. Previous guess counts.' : guessRejectionText(deliveryOwn.reason)
      : deliveryOwn?.received ? 'Guess received' : !twitchUpdates && sameGuess ? 'Guess sent' : 'Place a pin first';
    bindText(delivery, () => actionError || (previousDelivery ? `${tr('Round {{round}}', { round: formatGuessrNumber(deliveryRound! + 1) })}: ` : '') + tr(receiptStatus));
    delivery.dataset.state = actionError || deliveryOwn?.lastStatus === 'rejected' ? 'error' : deliveryOwn?.received && !deliveryOwn.pending ? 'received' : 'waiting';
    const controls = cluePanel.querySelector<HTMLElement>('.clue-controls');
    if (controls && twitchUpdates) controls.inert = !canGuess();
    if (twitchUpdates && live?.timing) {
      const timing = live.timing, now = gameNow(), starting = Math.max(0, Math.ceil((timing.startsAt - now) / 1000));
      const remaining = Math.max(0, Math.ceil(((timing.deadline ?? now) - now) / 1000));
      timer.textContent = live.ended ? tr('Game ended') : live.paused ? tr('Reconnecting…') : timing.phase === 'lobby' ? tr('Not started')
        : live.phase !== 'guess' ? tr('Round closed') : starting ? tr('Starting in {{seconds}}', { seconds: formatGuessrNumber(starting) }) : timing.deadline === null ? tr('Manual timing')
        : `${formatGuessrNumber(Math.floor(remaining / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(remaining % 60, { minimumIntegerDigits: 2 })}`;
      timer.hidden = timing.phase === 'lobby' || live.phase !== 'guess';
      timer.dataset.clock = String(!live.ended && !live.paused && !starting && live.phase === 'guess' && timing.deadline !== null);
      board.setLocked(!canGuess() || reviewedRound !== null);
      let countdown = cluePanel.querySelector<HTMLElement>('.stream-countdown');
      if (starting && live.phase === 'guess' && !live.paused) {
        if (!countdown) { countdown = node('div', 'stream-countdown'); cluePanel.append(countdown); }
        countdown.textContent = timer.textContent;
      } else countdown?.remove();
    }
    const disabledReason = live?.ended ? 'The streamer ended this game.' : !state.connected ? 'Sign in with Twitch'
      : !joined ? 'Join game' : isHost() ? 'You are the streamer. Submit your guess in the streamer tab.' : !channel ? 'Open the game link shared by your streamer.'
      : live?.timing?.phase === 'lobby' ? 'Waiting for the streamer to start the game.'
      : !legacyPayload && connectionState !== 'connected' ? 'The NoitaGuessr game connection is unavailable'
      : !snapshot ? 'Waiting for the streamer to start a round'
      : live?.phase === 'complete' ? 'This game has finished'
      : live?.phase === 'reveal' ? 'This round is closed'
      : live && !live.online ? 'The streamer is disconnected from NoitaGuessr'
      : live?.paused ? twitchUpdates ? 'The streamer is disconnected from NoitaGuessr' : 'The streamer has paused this round'
      : live?.timing && gameNow() < live.timing.startsAt ? 'Your round has not started yet.'
      : live?.timing?.deadline && gameNow() >= live.timing.deadline ? 'This round is closed'
      : !point ? 'Place a pin first' : '';
    sendControl.tabIndex = send.disabled ? 0 : -1;
    if (disabledReason !== sendReason) { sendReason = disabledReason; sendHelp.update(); }
    if (!sending && !actionError && !own?.submitted && !previousDelivery && disabledReason) bindText(delivery, disabledReason);
    const needsReceipt = twitchUpdates && deliveryOwn?.pending && Date.now() - lastSendAt > 15_000;
    retry.hidden = !joined || !!legacyPayload || live?.ended || live?.phase === 'complete' || !['stopped', 'retrying'].includes(connectionState) && !needsReceipt;
    bindText(retry, needsReceipt && connectionState !== 'stopped' ? 'Check delivery' : 'Reconnect');
    if (!legacyPayload && connectionState === 'connected') {
      bindText(roomStatus, live?.ended ? 'The streamer ended this game.' : live?.timing?.phase === 'lobby' ? 'Waiting for the streamer to start the game.' : !live || live.phase === 'waiting' ? 'No active NoitaGuessr game'
        : live.phase === 'complete' ? 'Game finished' : live.phase === 'reveal' && live.round === STREAM_ROUNDS ? 'You have finished all 10 rounds. Waiting for the streamer.' : live.phase === 'reveal' ? 'Round closed'
        : live.timing?.early ? 'Everyone has submitted. This round is closing.'
        : !live.online ? 'Streamer disconnected from NoitaGuessr' : live.paused ? 'Paused' : isHost() ? 'You are the streamer' : '');
    } else bindText(roomStatus, connectionDetail);
    if (unavailableGame) bindText(roomStatus, 'This game is no longer active.');
    roomStatus.hidden = !channel || !!legacyPayload || !roomStatus.textContent;
    result.hidden = !live?.resultId && !(unavailableGame && requestedGame);
    const resultId = live?.resultId ?? (unavailableGame ? requestedGame : undefined);
    if (resultId) result.href = guessRouteUrl('stream-result', location.origin, { result: resultId }).href;
  };
  if (legacyPayload) setRound(legacyPayload, legacyPayload);
  const unsubscribe = viewer.subscribe(refresh);
  const unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('online', refresh);
  startRoom(); refresh();
  const ticks = twitchUpdates ? setInterval(refresh, 250) : undefined;
  return () => {
    closed = true; room?.dispose(); unsubscribe(); unsubscribeLanguage(); chat.dispose(); board.destroy(); viewport?.destroy(); clearControls?.(); clearResults?.();
    clearInterval(ticks);
    window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    sendHelp.dispose(); connection.remove(); round.remove(); roomStatus.remove();
    page?.classList.remove('stream-viewer-page'); main.classList.remove('stream-viewer-shell');
  };
}
