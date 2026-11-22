import { sharedRoundResults } from './stream-round-results';
import { updateSubmit } from './submit-control';
import { bindViewerAccount } from './account-menu';
import { fitGameFrame } from './game-frame';
import { pageBack } from './page-heading';
import { moveGameExit } from './game-chrome';
import { GAME_UNAVAILABLE_MESSAGE } from './stream-lifetime';
import { allowGuessrChangelog } from './changelog';
import { StreamRoundCache } from './stream-round-cache';
import { mapControls } from './map-controls';
import { ClueViewport } from './clue-viewport';
import { fitClueToPanel } from './clue-stage';
import { attachClueControls } from './clue-view';
import { clueTitleBar, formatRoundTime, maximumIndicator, roundPanelHeader, showRoundTime, updateRoundIndicators } from './round-status';
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
import { watchParallelGame } from './parallel-game-client';
import { StreamViewerHistory } from './stream-viewer-history';
import { guessReceiptKey, guessRejectionText } from './stream-wire';
import type { LiveRoomView } from './live-room-types';
import { guessRouteUrl, readGuessRoute } from './routes';
import { expandStreamResult } from './stream-codec';
import { streamResultsView } from './stream-results';
import { roundResultReviews } from './stream-result-review';
import type { StreamResult } from './stream-types';
import type { StreamRoundView } from './stream-round-data';
import { rememberPublishedStream } from './stream-history-records';
import { localizedDistance } from './messages';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, onGuessrLanguageChanged, tr } from './i18n';
import { pageHeading } from './page-heading';
import { hoverHelp } from './hover-help';
import { confirmQuitGame } from './quit-game';
import { buttonNotice } from './button-notice';
import { rememberPvp, forgetPvp } from './pvp-resume';
import { StreamResultArchive } from './stream-result-archive';
import { gameJoinNotice } from './join-notice';
import { showRoundProgress } from './round-progress';

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
  const pvp = readGuessRoute(url).pane === 'pvp-game';
  const candidate = readGuessRoute(url).channel || (pvp ? 'pvp' : '');
  let requestedGame = readGuessRoute(url).game;
  let personal = new StreamViewerHistory(config.bounds);
  let sharedRounds = requestedGame ? new StreamRoundCache(requestedGame, config.bounds) : undefined;
  let sharedRound: number | null = null, sharedSignature = '', clearShared: (() => void) | undefined;
  let sharedNext: HTMLButtonElement | undefined, sharedBack: HTMLButtonElement | undefined, sharedReady: HTMLButtonElement | undefined;
  personal.identify(requestedGame, viewer.getState().userId ?? viewer.getState().savedUserId ?? null);
  let feed: ReturnType<typeof watchParallelGame> | undefined;
  let autoRound = '';
  let checkAutomatic = () => {};
  let reviewedRound: number | null = null, lastSendAt = 0, actionError = '', sendReason = '';
  let pvpCommands = 0;
  let unavailableGame = false;
  const joinedNotice = gameJoinNotice();
  let channel = /^[a-z0-9_]{1,25}$/.test(candidate) ? candidate : '';
  const leave = onLeave ?? (() => { location.href = '/guess/'; });
  const pvpCommand = async (message: Omit<Extract<import('./parallel-types').ParallelClientMessage, { id: string }>, 'id'> & Record<string, unknown>) => {
    if (!feed || !('command' in feed)) return;
    pvpCommands++; refresh();
    try { actionError = ''; await feed.command({ ...message, id: crypto.randomUUID() } as Extract<import('./parallel-types').ParallelClientMessage, { id: string }>); }
    catch (error) { actionError = (error as Error).message; }
    finally { pvpCommands--; }
    if (!closed) refresh();
  };
  const exitMatch = () => {
    if (unavailableGame) { if (pvp && requestedGame) forgetPvp(requestedGame); leave(); return; }
    if (!pvp || !live || live.phase === 'complete' || live.ended || connectionDetail === 'This invitation is not available.'
      || connectionDetail === 'This game is open in another tab. Continue there.') { leave(); return; }
    const leavingLobby = live.timing?.phase === 'lobby';
    confirmQuitGame(async () => { await pvpCommand({ type: 'quit' }); if (!actionError && leavingLobby) leave(); },
      live.timing?.phase === 'lobby' ? live.pvp?.creator ? 'This cancels the match invitation.' : 'This declines the match invitation.' : 'Leaving now concedes the match to your opponent.');
  };
  if (!requestedGame) {
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
  let publishedResult: StreamResult | undefined;
  let clearResults: (() => void) | undefined;
  let live: LiveRoomView | null = null, connectionState: RoomConnection = 'connecting', connectionDetail = 'Connecting to the NoitaGuessr game…';
  let room: ReturnType<typeof watchParallelGame> | undefined, roomEpoch = 0;
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
    try { actionError = '';
      if (connectionState === 'stopped' && viewer.getState().connected) viewer.disconnect();
      await viewer.connect();
    } catch (error) { if (!closed) { actionError = twitchMessageText((error as Error).message); refresh(); } }
  }, 'btn-twitch small');
  const disconnect = button('Sign out', () => viewer.disconnect(), 'small secondary');
  connection.append(account, connect, disconnect);
  // Account identity and sign-out live in the shared header menu. The sign-in
  // prompt remains beside the guess map when participation needs authorization.
  const clearAccount = bindViewerAccount(viewer);
  const round = node('strong', 'stream-round');

  const layout = node('div', 'stream-viewer-layout has-clue');
  const clearFrame = fitGameFrame(layout);
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
  signIn.append(connect, signInError);
  const budget = maximumIndicator(); budget.classList.add('stream-maximum'); budget.hidden = true;
  const roomStatus = node('span', 'stream-room-status'); roomStatus.setAttribute('role', 'status');
  const retry = button('Reconnect', () => room?.retry(), 'small secondary'); retry.hidden = true;
  const delivery = node('span', 'stream-delivery'); delivery.setAttribute('role', 'status');
  const timer = node('span', 'stream-round-timer');
  timer.setAttribute('role', 'timer'); timer.hidden = true;
  const previousResult = button('View results', () => {
    if (!live) return;
    const latest = Math.max(0, ...sharedRounds?.rounds.keys() ?? []);
    if (latest) { sharedRound = latest; refresh(); sharedBack?.focus({ preventScroll: true }); return; }
    for (let i = (live.totalRounds ?? STREAM_ROUNDS) - 1; i >= 0; i--) {
      if (personal.round(i).reveal) {
        reviewedRound = i; drawnOutcome = ''; refresh(); returnToRound.focus({ preventScroll: true }); break;
      }
    }
  }, 'small secondary stream-previous-result'); previousResult.hidden = true;
  const returnToRound = button('Back', () => {
    reviewedRound = null; drawnOutcome = ''; board.setMarkers(point); refresh(); previousResult.focus({ preventScroll: true });
  }, 'small secondary');
  returnToRound.hidden = true; revealBar.prepend(returnToRound);
  const result = node('a', 'small secondary', 'View results'); result.hidden = true;
  const isHost = () => !pvp && !!live?.hostId && live.hostId === viewer.getState().userId;
  const gameNow = () => feed?.now() ?? Date.now();
  const canGuess = () => (!pvp || !!live?.pvp?.active && !live.pvp.locked && !personal.round(live.round - 1).pending && !personal.round(live.round - 1).received)
    && (!!feed?.hasJoined()) && reviewedRound === null && navigator.onLine !== false && !!snapshot && !isHost() && (!!live && connectionState === 'connected'
    && live.online && !live.paused && live.phase === 'guess' && (!live.timing || gameNow() >= live.timing.startsAt
      && (live.timing.deadline === null || gameNow() < live.timing.deadline)));
  const sendGuess = async (automatic = false) => {
    if (!point || !channel || !snapshot || (!automatic && !canGuess()) || sending || !viewer.getState().connected) return;
    if (automatic && (!live?.timing?.deadline || live.ended || live.phase !== 'guess' || isHost() || gameNow() > live.timing.deadline + STREAM_SUBMISSION_GRACE_MS)) return;
    const submittedPoint = { x: Math.round(point.x), y: Math.round(point.y) }, key = guessKey(), identity = roundKey, playerId = viewer.getState().userId!;
    const submittedRound = snapshot.round;
    const submittedMaximum = progress ? maximumScore(progress) : 5000;
    const target = live?.roundId ? { roundId: live.roundId, gameId: live.gameId!,
      } : undefined;
    sending = true; sendingRound = submittedRound - 1; lastSendAt = Date.now(); actionError = ''; refresh();
    let receipt: string | undefined;
    try {
      if (target) {
        const nonce = crypto.getRandomValues(new Uint8Array(8));
        receipt = await guessReceiptKey(target.roundId, playerId, Array.from(nonce, n => n.toString(16).padStart(2, '0')).join(''));
        // The click was allowed before zero. A round update while hashing or
        // sending must not cancel it, retarget it, or borrow the next allowance.
        if (closed || unavailableGame || live?.gameId !== target.gameId || viewer.getState().userId !== playerId) return;
        personal.identify(target.gameId, playerId);
        const revision = Math.max(personal.nextRevision(submittedRound - 1), feed?.nextRevision(target.roundId) ?? 1);
        personal.submit(submittedRound - 1, receipt, submittedPoint, submittedMaximum, revision, automatic);
        if (feed && 'submit' in feed) feed.submit({ roundId: target.roundId, point: submittedPoint, maximum: submittedMaximum,
          nonce: Array.from(nonce, n => n.toString(16).padStart(2, '0')).join(''), revision: revision!, automatic });
        refresh();
        personal.markSent(submittedRound - 1, receipt);
      } else throw Error('Join game');
      if (roundKey === identity) {
        lastSent = key; lastSendAt = Date.now(); submitted = { playerId, point: submittedPoint }; saveProgress();
      }
    } catch (error) {
      if (!closed) actionError = (roundKey === identity ? '' : `${tr('Round {{round}}', { round: formatGuessrNumber(submittedRound) })}: `)
        + twitchMessageText((error as Error).message);
    }
    finally { sending = false; sendingRound = undefined; if (!closed) refresh(); }
  };
  const send = button('Send guess', () => sendGuess(), 'primary');
  send.setAttribute('aria-live', 'polite'); send.setAttribute('aria-atomic', 'true');
  const sendControl = node('span', 'stream-send-control'); sendControl.append(send);
  const sendHelp = hoverHelp(sendControl, () => tr(sendReason), send);
  const secondaryActions = node('div', 'stream-secondary-actions');
  secondaryActions.append(result, retry);
  actions.append(sendControl); mapPanel.append(roundPanelHeader(revealBar, actions, secondaryActions), signIn, map); layout.append(mapPanel);
  const resultsPanel = node('section', 'stream-viewer-results'); resultsPanel.hidden = true;
  layout.append(resultsPanel);
  const sharedPanel = node('section', 'stream-shared-round'); sharedPanel.hidden = true; layout.append(sharedPanel);
  const chat = viewerChatPanel(viewer, channel, exitMatch, requestedGame, { pvp });
  const toolbar = chat.panel.querySelector<HTMLElement>('.stream-chat-header')!;
  toolbar.classList.add('stream-toolbar');
  const exit = toolbar.querySelector<HTMLButtonElement>('.stream-change-channel');
  if (exit) moveGameExit(main, exit);
  toolbar.querySelector('.stream-chat-heading')?.classList.add('stream-toolbar-navigation');
  const commands = toolbar.querySelector<HTMLElement>('.stream-chat-actions')!; commands.classList.add('stream-toolbar-actions');
  commands.prepend(previousResult);
  const phase = node('div', 'stream-toolbar-round'); phase.append(commands, round); toolbar.append(timer, phase);
  const activity = node('div', 'stream-activity stream-viewer-activity');
  activity.hidden = true; activity.append(roomStatus, delivery);
  layout.prepend(chat.panel); main.append(layout, activity);
  const pvpLobby = node('section', 'game-panel stream-start-panel pvp-lobby'); pvpLobby.hidden = true;
  const pvpTitle = node('h2'), pvpDetail = node('p'), pvpRule = node('p', 'form-text'), pvpClock = node('output', 'stream-waiting-timer');
  const pvpNames = node('div', 'pvp-lobby-players');
  const creatorName = node('strong'), versus = node('span', '', 'vs'), opponentName = node('strong');
  const opponentSlot = node('div', 'pvp-lobby-player'), opponentReady = node('small');
  opponentSlot.append(opponentName, opponentReady); pvpNames.append(creatorName, versus, opponentSlot);
  const pvpReady = button('Ready', () => pvpCommand({ type: 'ready', ready: true, round: (live?.timing?.hostRound ?? 1) - 1, phase: 'lobby' }), 'primary');
  const pvpStart = button('Start game', () => pvpCommand({ type: 'start', opponentId: live?.pvp?.players[1]?.id }), 'primary');
  const pvpReject = button('Choose another opponent', () => pvpCommand({ type: 'reject-opponent', playerId: live?.pvp?.players[1]?.id }));
  const pvpInvite = button('Copy invite link', async () => {
    try { await navigator.clipboard.writeText(guessRouteUrl('pvp-game', location.origin, { game: requestedGame! }).href); inviteNotice.show('Copied', 'success'); }
    catch { actionError = 'Could not copy the link. Copy it from your address bar.'; refresh(); }
  });
  const inviteNotice = buttonNotice(pvpInvite);
  const pvpActions = node('div', 'action-row'); pvpActions.append(pvpInvite, pvpReady, pvpStart, pvpReject);
  pvpLobby.append(pvpTitle, pvpNames, pvpClock, pvpDetail, pvpRule, pvpActions); layout.append(pvpLobby);
  const pickPoint = (next: Point) => {
    if (within(next, config.bounds)) { point = next; board.setMarkers(next); saveProgress(); refresh(); }
  };
  let board = new MapBoard(map, config.bounds, config.overview, pickPoint, config.map);
  const navigation = mapControls(board); actions.classList.add('guess-map-toolbar'); actions.prepend(navigation);
  const guessKey = () => point ? `${viewer.getState().userId}/${channel}/${live?.roundId ?? snapshot?.round}/${Math.round(point.x)}/${Math.round(point.y)}/${progress ? maximumScore(progress) : ''}` : '';
  const setRound = (payload: string | null, identity: string) => {
    if (identity === roundKey && (!!payload === !!snapshot)) return;
    clearResults?.(); clearResults = undefined;
    viewport?.destroy(); viewport = undefined; clearControls?.(); clearControls = undefined;
    snapshot = undefined; progress = null; point = null; submitted = null; lastSent = ''; actionError = ''; roundKey = identity;
    reviewedRound = null; sharedRound = null;
    drawnOutcome = ''; drawnResults = ''; revealBar.hidden = true;
    resultsPanel.hidden = true; cluePanel.hidden = false; mapPanel.hidden = false; layout.classList.remove('show-results');
    if (payload) try {
      snapshot = decodeViewerClue(payload, { imageRoot, version: config.version });
      if (snapshot.round > STREAM_ROUNDS) throw Error();
    } catch { snapshot = undefined; }
    if (snapshot) showRoundProgress(round, live?.totalRounds ?? STREAM_ROUNDS, snapshot.round);
    else bindText(round, 'Ready to start');
    if (!snapshot) emptyClue(payload ? 'This clue uses a different map version. Reload the page to update.' : undefined);
    else {
      if (snapshot.assistance) progress = { ...newClueProgress(), ...snapshot.camera, ...snapshot.assistance,
        visited: [...new Set(['0,0', `${snapshot.camera.dx},${snapshot.camera.dy}`])] };
      restoreProgress();
      bindAttribute(cluePanel, 'aria-label', () => tr('Round {{round}} clue', { round: formatGuessrNumber(snapshot!.round) }));
      const clue = node('div', 'clue loading');
      cluePanel.replaceChildren(roundPanelHeader(clueTitleBar(budget)), clue);
      if (progress) clearControls = attachClueControls(clue, snapshot.source, progress, 256, () => { saveProgress(); refresh(); },
        { compact: true, difficultyTier: () => live?.difficultyTier,
          onExplore: () => { if (live?.roundId) feed?.explored(live.roundId); } });
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
  const showPublishedResult = (completed: StreamResult, published = true) => {
    if (pvp && published) {
      forgetPvp(completed.id);
      history.replaceState(null, '', guessRouteUrl('stream-result', location.href, { result: completed.id }));
    }
    const playerId = viewer.getState().userId ?? viewer.getState().savedUserId;
    const key = `completed/${completed.id}/${playerId ?? ''}/${published}`;
    if (published) rememberPublishedStream(completed.id, channel);
    if (drawnResults !== key) {
      drawnResults = key; clearResults?.();
      const summary = streamResultsView(completed, playerId ?? undefined, undefined, config);
      clearResults = summary.destroy;
      const open = node('a', 'btn btn-outline theme-secondary', 'Open results page');
      open.href = guessRouteUrl('stream-result', location.origin, { result: completed.id }).href;
      if (published) summary.querySelector('.stream-results-menu')!.append(open);
      else summary.querySelector('.stream-results-menu')!.append(node('span', '', 'Not published yet. Retrying automatically.'));
      resultsPanel.replaceChildren(summary);
      if (pvp) void new StreamResultArchive().save({ result: completed, published }).catch(() => {});
    }
    sharedRound = null; revealBar.hidden = true;
    cluePanel.hidden = true; mapPanel.hidden = true; resultsPanel.hidden = false;
    layout.classList.add('show-results'); bindText(round, 'Results'); round.hidden = false;
  };
  const showPersonalOutcome = () => {
    if (!live) return;
    if (publishedResult || live.result) { showPublishedResult(publishedResult ?? expandStreamResult(live.result!), !!publishedResult || !!live.resultId); return; }
    if (!viewer.getState().userId && !viewer.getState().savedUserId) { resultsPanel.hidden = true; return; }
    const current = personal.round(live.round - 1);
    const index = reviewedRound ?? (live.phase !== 'guess' && current.reveal ? live.round - 1 : null);
    const own = index === null ? undefined : personal.round(index);
    revealBar.hidden = !own?.reveal;
    returnToRound.hidden = reviewedRound === null;
    if (own?.reveal) {
      const score = own.score;
      revealName.textContent = `${tr('Round {{round}}', { round: formatGuessrNumber(index! + 1) })}: ${guessrGameTerm(own.reveal.area.label)}`;
      revealDistance.textContent = own.pending ? tr('Waiting for confirmation') : !own.received ? tr(pvp ? 'No recorded guesses' : 'No guess recorded by the streamer') : localizedDistance(score?.distance ?? null);
      revealPoints.classList.toggle('score-perfect', own.score?.score === 5000);
      revealPoints.textContent = own.pending ? '…' : tr('{{points}} points', { points: formatGuessrNumber(score?.score ?? 0), count: score?.score ?? 0 });
      const key = `${live.gameId}/${index}/${own.received?.key}/${own.pending}`;
      if (drawnOutcome !== key) { drawnOutcome = key; board.setMarkers(own.received?.point ?? null, own.reveal.answer); }
      board.setLocked(true);
    } else board.setLocked(!canGuess());
    if (live.phase === 'complete') {
      if (live.resultId && channel) rememberPublishedStream(live.resultId, channel);
      const signature = `${viewer.getState().userId ?? viewer.getState().savedUserId}/${viewer.getState().connected}/${sharedRounds?.rounds.size}/`
        + Array.from({ length: live?.totalRounds ?? STREAM_ROUNDS }, (_, i) => { const r = personal.round(i); return `${r.score?.score}/${r.pending}/${r.received?.key}`; }).join('/');
      if (drawnResults !== signature) {
        drawnResults = signature;
        const openRounds = [...resultsPanel.querySelectorAll<HTMLDetailsElement>('details[data-round][open]')].map(item => Number(item.dataset.round));
        clearResults?.(); clearResults = undefined;
        const heading = node('h1', '', viewer.getState().connected ? 'Your result' : 'Saved result');
        const waiting = Array.from({ length: live?.totalRounds ?? STREAM_ROUNDS }, (_, i) => personal.round(i)).some(r => r.pending || r.received && !r.reveal);
        const total = node('strong', 'stream-rank', () => waiting ? tr('Waiting for results')
          : tr('{{points}} points', { points: formatGuessrNumber(personal.total()), count: personal.total() }));
        const table = node('table', 'table stream-score-table'), body = node('tbody');
        const released: StreamRoundView[] = [];
        let runningTotal = 0;
        for (let i = 0; i < (live?.totalRounds ?? STREAM_ROUNDS); i++) {
          const r = personal.round(i), row = node('tr');
          runningTotal += r.score?.score ?? 0;
          const shared = sharedRounds?.rounds.get(i + 1);
          if (shared) released.push(shared);
          else if (r.reveal) {
            const id = viewer.getState().userId ?? viewer.getState().savedUserId!;
            released.push({ round: i + 1, answer: r.reveal.answer, label: r.reveal.area.label,
              host: { id: live.hostId ?? '', login: channel, name: channel },
              players: [{ id, login: viewer.getState().login ?? '', name: viewer.getState().login ?? tr('You'),
                guess: r.received?.point ?? null, score: r.score?.score ?? 0, total: runningTotal }] });
          }
          row.append(node('td', '', () => tr('Round {{round}}', { round: formatGuessrNumber(i + 1) })),
            node('td', '', r.reveal ? () => guessrGameTerm(r.reveal!.area.label) : '—'),
            node('td', 'numeric' + (r.score?.score === 5000 ? ' score-perfect' : ''), r.pending ? 'Waiting for confirmation' : r.received && !r.reveal ? 'Waiting for results'
              : r.received ? () => formatGuessrNumber(r.score?.score ?? 0) : '—'));
          body.append(row);
        }
        const reviews = roundResultReviews(released, config, openRounds); clearResults = reviews.destroy;
        table.append(body); const links = node('div', 'stream-results-menu'); links.append(result);
        const wrap = node('div', 'table-wrap'); wrap.append(table);
        resultsPanel.replaceChildren(heading, links, total, reviews.element, wrap);
      }
      cluePanel.hidden = true; mapPanel.hidden = true; resultsPanel.hidden = false; layout.classList.add('show-results');
    }
  };
  const startRoom = () => {
    const epoch = ++roomEpoch;
    room?.dispose(); room = undefined; feed?.dispose(); feed = undefined; live = null;
    connectionState = 'connecting'; connectionDetail = '';
    chat.setGameConnection(!channel ? null : 'connecting', 'Connecting to the NoitaGuessr game…');
    if (!channel) return;
    const handlers = {
      state: state => {
        if (closed || epoch !== roomEpoch || live && state.revision < live.revision) return;
        unavailableGame = !!requestedGame && state.gameId !== requestedGame || pvp !== (state.mode === 'pvp');
        if (unavailableGame) {
          live = null; chat.setProStatus({}); setRound(null, `unavailable/${requestedGame}`); refresh(); return;
        }
        if (!requestedGame && state.gameId) {
          requestedGame = state.gameId;
          history.replaceState(null, '', guessRouteUrl('stream-picker', location.href, { channel, game: requestedGame }));
        }
        checkAutomatic();
        if (state.phase === 'complete' && live?.phase !== 'complete') sharedRound = null;
        if (state.config && state.config.version !== config.version) {
          config = state.config; imageRoot = state.imageRoot ?? imageRoot;
          personal = new StreamViewerHistory(config.bounds);
          sharedRounds = requestedGame ? new StreamRoundCache(requestedGame, config.bounds) : undefined;
          board.destroy(); board = new MapBoard(map, config.bounds, config.overview, pickPoint, config.map);
          actions.querySelector('.guess-map-controls')?.replaceWith(mapControls(board));
        } else if (state.imageRoot) imageRoot = state.imageRoot;
        live = state;
        if (pvp && state.gameId) {
          if (state.ended || state.phase === 'complete' && state.resultId) forgetPvp(state.gameId);
          else if (viewer.getState().userId && state.pvp?.players.some(player => player.id === viewer.getState().userId)) rememberPvp({
            id: state.gameId, playerId: viewer.getState().userId!, round: state.round, rounds: state.totalRounds!,
            completed: (state.timing?.revealed ?? 0).toString(2).replaceAll('0', '').length,
            complete: state.phase === 'complete', lobby: state.timing?.phase === 'lobby', creator: state.pvp?.creator,
          });
        }
        channel = state.channel; chat.setChannel(channel);
        if (pvp) chat.setPlayers(state.pvp?.players ?? []);
        const playerId = viewer.getState().userId;
        if (playerId && viewer.getState().connected && !state.ended && state.phase !== 'complete'
          && playerId !== state.hostId && (!pvp || state.pvp?.players.some(player => player.id === playerId))) {
          joinedNotice.show(playerId, channel);
        }
        personal.identify(state.gameId ?? requestedGame, viewer.getState().userId ?? viewer.getState().savedUserId ?? null);
        chat.setProStatus(state);
        setRound(state.clue, state.gameId && state.roundId ? `${state.gameId}/${state.roundId}` : `waiting/${channel}`);
        if (state.ended) emptyClue(pvp ? 'The match was cancelled.' : 'The streamer ended this game.', 'Game ended');
        else if (state.timing?.phase === 'lobby') emptyClue(state.streaming === false ? 'Everyone plays the same location at the same time.'
          : 'You guess each location before it appears on the streamer’s broadcast.', 'Ready to start');
        refresh();
      },
      status: (state, detail) => {
        if (closed || epoch !== roomEpoch) return;
        if (state === 'stopped' && detail === GAME_UNAVAILABLE_MESSAGE) {
          unavailableGame = true; emptyClue(GAME_UNAVAILABLE_MESSAGE, 'Game ended');
        }
        connectionState = state; connectionDetail = detail; chat.setGameConnection(state, detail); refresh();
      },
    } satisfies Pick<Parameters<typeof watchParallelGame>[3], 'state' | 'status'>;
    {
      const events: Parameters<typeof watchParallelGame>[3] = { ...handlers,
        published: completed => { if (completed.id === requestedGame) { publishedResult = completed; refresh(); } },
        roundResults: data => { sharedRounds?.save(data); refresh(); },
        durableReceipt: message => {
          const playerId = viewer.getState().userId;
          if (!playerId || !requestedGame) return;
          void guessReceiptKey(message.roundId, playerId, message.nonce).then(key => {
            if (closed || epoch !== roomEpoch || viewer.getState().userId !== playerId) return;
            personal.identify(requestedGame, playerId);
            if (message.accepted && message.point) personal.restoreReceipt(message.round - 1, key, message.point, message.maximum ?? 5000, message.revision, message.automatic);
            else personal.receipts(message.round - 1, [key], true, message.reason === 'superseded' ? 'superseded' : 'closed');
            refresh();
          });
        },
        reveal: (round, reveal) => { personal.reveal(round, reveal); refresh(); },
      };
      feed = watchParallelGame(viewer, channel, requestedGame!, events, { pvp });
      room = feed;

    }
  };
  const showSharedResults = () => {
    if (live?.ended || live?.phase === 'complete' || publishedResult) sharedRound = null;
    else if (live?.phase === 'reveal' && sharedRounds?.rounds.size)
      sharedRound = Math.max(...sharedRounds.rounds.keys());
    const data = sharedRound === null ? undefined : sharedRounds?.rounds.get(sharedRound);
    sharedPanel.hidden = !data; layout.classList.toggle('show-round-results', !!data);
    if (!data) {
      if (sharedSignature) { clearShared?.(); clearShared = undefined; sharedPanel.replaceChildren(); sharedSignature = ''; }
      return;
    }
    const signature = `${requestedGame}/${data.round}`;
    if (signature !== sharedSignature) {
      clearShared?.(); sharedPanel.replaceChildren(); sharedSignature = signature;
      const actions = node('div', 'stream-round-review-actions');
      sharedBack = pageBack(button('Back', () => {
        sharedRound = null; refresh(); previousResult.focus({ preventScroll: true });
      }, 'secondary'));
      sharedPanel.append(sharedBack);
      if (pvp) {
        sharedReady = button('Ready to continue', () => void pvpCommand({
          type: 'ready', ready: true, round: (live?.timing?.hostRound ?? 1) - 1, phase: 'review',
        }), 'primary');
        actions.append(sharedReady);
      }
      sharedNext = button('Waiting for the streamer', () => {}, 'secondary'); sharedNext.disabled = true;
      actions.append(sharedNext);
      clearShared = sharedRoundResults(sharedPanel, config, data, actions);
    }
    const finalReveal = data.round === live?.totalRounds && !!live.timing?.seconds;
    const readyPhase = pvp && live?.phase === 'reveal' && !finalReveal;
    sharedBack!.hidden = readyPhase || (!pvp && live?.phase !== 'guess' && live?.phase !== 'complete');
    sharedNext!.hidden = live?.phase === 'guess' || live?.phase === 'complete' || finalReveal;
    bindText(sharedBack!, live?.phase === 'complete' ? 'Back to results' : 'Back to round {{round}}', { round: formatGuessrNumber(live?.round ?? 1) });
    if (sharedReady) {
      sharedReady.hidden = !readyPhase;
      const ready = !!live?.pvp?.ready.includes(viewer.getState().userId ?? '');
      bindText(sharedReady, ready ? 'Ready' : 'Ready to continue');
      sharedReady.disabled = !readyPhase || ready || pvpCommands > 0;
    }
    if (live?.phase !== 'guess') {
      bindText(round, 'Round {{round}} results', { round: formatGuessrNumber(data.round) });
      const until = live?.phase === 'complete' || finalReveal ? undefined : live?.timing?.resultsUntil;
      if (until) {
        const seconds = Math.max(0, Math.ceil((Math.max(until, live?.timing?.deadline ?? 0) - gameNow()) / 1000));
        bindText(sharedNext!, 'Next round in {{time}}', { time: formatRoundTime(seconds) });
        return seconds;
      } else bindText(sharedNext!, 'Waiting for the streamer');
    }
  };
  refresh = () => {
    allowGuessrChangelog(false);
    const state = viewer.getState();
    personal.identify(live?.gameId ?? requestedGame, state.userId ?? state.savedUserId ?? null);
    if (live?.phase === 'complete' && !state.connected) connection.insertBefore(connect, disconnect);
    else if (connect.parentElement !== signIn) signIn.prepend(connect);
    const joined = !!feed?.hasJoined();
    const inLobby = !pvp && joined && !unavailableGame && !live?.ended
      && live?.timing?.phase === 'lobby' && !snapshot;
    layout.classList.toggle('show-stream-lobby', inLobby);
    round.hidden = inLobby;
    const needsAuthorization = connectionState === 'stopped' && connectionDetail === 'Sign in with Twitch to play.';
    signIn.hidden = state.connected && !needsAuthorization || reviewedRound !== null;
    map.hidden = (!state.connected || needsAuthorization) && reviewedRound === null;
    signInError.textContent = actionError || (state.error ? twitchMessageText(state.error) : '');
    signInError.hidden = !signInError.textContent;
    if (snapshot && live?.phase !== 'complete' && reviewedRound === null && sharedRound === null)
      showRoundProgress(round, live?.totalRounds ?? STREAM_ROUNDS, snapshot.round);
    showPersonalOutcome();
    const reviewSeconds = showSharedResults();
    if (progress) updateRoundIndicators(layout, progress,
      reviewedRound === null ? live?.difficultyTier : personal.round(reviewedRound).reveal?.area.difficultyTier);
    budget.hidden = !progress || reviewedRound !== null || !revealBar.hidden;
    account.textContent = state.connected ? tr('Playing as {{player}}', { player: state.login! }) : '';
    connect.hidden = state.connected && !needsAuthorization; connect.disabled = state.connecting;
    bindText(connect, state.restoring ? 'Restoring Twitch…' : state.connecting ? 'Signing in…' : 'Sign in with Twitch');
    disconnect.hidden = !state.connected; disconnect.disabled = state.sending;
    const own = live ? personal.round(live.round - 1) : null;
    let deliveryRound = live ? live.round - 1 : undefined;
    if (sending && sendingRound !== undefined) deliveryRound = sendingRound;
    else if (live && !own?.submitted) {
      for (let previous = live.round - 2; previous >= 0; previous--) {
        if (personal.round(previous).pending) { deliveryRound = previous; break; }
      }
    }
    const deliveryOwn = deliveryRound === undefined ? own : personal.round(deliveryRound);
    const previousDelivery = !!live && deliveryRound !== undefined && deliveryRound !== live.round - 1;
    const sameGuess = !!guessKey() && guessKey() === lastSent;
    const mayResend = sameGuess && (own?.lastStatus === 'rejected' || own?.pending && Date.now() - lastSendAt >= 15_000);
    send.disabled = !canGuess() || !state.connected || !point || !channel || sending || sameGuess && !mayResend;
    const currentSending = sending && (!live || sendingRound === live.round - 1);
    const sendLabel = currentSending ? own?.automatic ? 'Auto-sending…' : 'Sending…'
      : mayResend ? 'Resend guess'
      : sameGuess && own?.pending ? own.automatic ? 'Auto-sending…' : 'Waiting for confirmation'
      : sameGuess && own?.received ? own.automatic ? 'Auto-submitted' : 'Guess received'
      : own?.submitted && !sameGuess ? 'Update guess' : 'Send guess';
    const label = pvp ? live?.pvp?.locked || !!own?.received ? own?.automatic ? 'Auto-submitted' : 'Guess locked'
      : sendLabel === 'Send guess' || sendLabel === 'Update guess' ? 'Lock guess' : sendLabel : sendLabel;
    updateSubmit(send, label, sameGuess && own?.received && !own.pending || pvp && !!live?.pvp?.locked ? 'received' : currentSending || sameGuess && own?.pending ? 'waiting' : 'ready');
    send.setAttribute('aria-busy', String(currentSending || sameGuess && !!own?.pending));
    const receiptStatus = live?.ended ? 'The streamer ended this game.' : sending ? deliveryOwn?.automatic ? 'Auto-sending…' : 'Sending…' : deliveryOwn?.pending ? deliveryOwn.received ? 'Update awaiting confirmation. Previous guess counts.'
      : deliveryOwn.automatic ? 'Auto-sending…' : 'Waiting for confirmation'
      : deliveryOwn?.lastStatus === 'rejected' ? deliveryOwn.received ? 'Update not received. Previous guess counts.' : guessRejectionText(deliveryOwn.reason)
      : deliveryOwn?.received ? deliveryOwn.automatic ? 'Auto-submitted' : 'Guess received' : 'Place a pin first';
    bindText(delivery, () => actionError || (previousDelivery ? `${tr('Round {{round}}', { round: formatGuessrNumber(deliveryRound! + 1) })}: ` : '') + tr(receiptStatus));
    delivery.dataset.state = actionError || deliveryOwn?.lastStatus === 'rejected' ? 'error' : deliveryOwn?.received && !deliveryOwn.pending ? 'received' : 'waiting';
    delivery.hidden = !actionError && !previousDelivery && deliveryOwn?.lastStatus !== 'rejected';
    const controls = cluePanel.querySelector<HTMLElement>('.clue-controls');
    if (controls) controls.inert = !canGuess();
    if (live?.timing) {
      const timing = live.timing, now = gameNow(), starting = Math.max(0, Math.ceil((timing.startsAt - now) / 1000));
      const remaining = Math.max(0, Math.ceil(((timing.deadline ?? now) - now) / 1000));
      const value = reviewSeconds ?? (live.ended ? tr('Game ended') : live.paused ? tr('Reconnecting…') : timing.phase === 'lobby' ? tr('Not started')
        : live.phase !== 'guess' ? tr('Round closed') : starting || (timing.deadline === null ? tr('Manual timing') : remaining));
      const label = showRoundTime(timer, value, reviewSeconds === undefined && starting > 0);
      timer.hidden = unavailableGame || timing.phase === 'lobby' || (live.phase !== 'guess' && reviewSeconds === undefined);
      board.setLocked(!canGuess() || reviewedRound !== null);
      let countdown = cluePanel.querySelector<HTMLElement>('.stream-countdown');
      if (starting && live.phase === 'guess' && !live.paused) {
        if (!countdown) { countdown = node('div', 'stream-countdown'); cluePanel.append(countdown); }
        countdown.textContent = label;
      } else countdown?.remove();
    } else timer.hidden = true;
    const disabledReason = live?.ended ? 'The streamer ended this game.' : !state.connected ? 'Sign in with Twitch'
      : pvp && live?.pvp?.locked ? 'Your guess is locked. Waiting for the other players.'
      : !joined ? 'Connecting to the NoitaGuessr game…' : isHost() ? 'You are the streamer. Submit your guess in the streamer tab.' : !channel ? 'Open the game link shared by your streamer.'
      : live?.timing?.phase === 'lobby' ? pvp ? 'Waiting for both players to be ready.' : 'Waiting for the streamer to start the game.'
      : connectionState !== 'connected' ? 'The NoitaGuessr game connection is unavailable'
      : !snapshot ? 'Waiting for the streamer to start a round'
      : live?.phase === 'complete' ? 'This game has finished'
      : live?.phase === 'reveal' ? 'This round is closed'
      : live && !live.online ? 'The streamer is disconnected from NoitaGuessr'
      : live?.paused ? 'The streamer is disconnected from NoitaGuessr'
      : live?.timing && gameNow() < live.timing.startsAt ? 'Your round has not started yet.'
      : live?.timing?.deadline && gameNow() >= live.timing.deadline ? 'This round is closed'
      : !point ? 'Place a pin first' : '';
    sendControl.tabIndex = send.disabled ? 0 : -1;
    const help = disabledReason || (sameGuess ? receiptStatus : '');
    if (help !== sendReason) { sendReason = help; sendHelp.update(); }
    const needsReceipt = deliveryOwn?.pending && Date.now() - lastSendAt > 15_000;
    if (needsReceipt && Date.now() - lastSendAt > 20000) { lastSendAt = Date.now(); feed?.requestRecovery(); }
    retry.hidden = true;
    bindText(retry, needsReceipt && connectionState !== 'stopped' ? 'Check delivery' : 'Reconnect');
    if (connectionState === 'connected') {
      bindText(roomStatus, live?.ended ? 'The streamer ended this game.' : live?.timing?.phase === 'lobby' ? 'Waiting for the streamer to start the game.' : !live || live.phase === 'waiting' ? 'No active NoitaGuessr game'
        : live.phase === 'complete' ? 'Game finished' : live.phase === 'reveal' && live.round === (live.totalRounds ?? STREAM_ROUNDS) ? tr('Waiting for the streamer', { rounds: formatGuessrNumber(live.totalRounds ?? STREAM_ROUNDS) }) : live.phase === 'reveal' ? 'Round closed'
        : live.timing?.early ? 'Everyone has submitted. This round is closing.'
        : !live.online ? 'Streamer disconnected from NoitaGuessr' : live.paused ? 'Paused' : isHost() ? 'You are the streamer' : '');
    } else bindText(roomStatus, connectionDetail);
    if (unavailableGame) bindText(roomStatus, 'This game is no longer active.');
    roomStatus.hidden = !channel || !roomStatus.textContent;
    result.hidden = !live?.resultId && !(unavailableGame && requestedGame);
    const resultId = live?.resultId ?? (unavailableGame ? requestedGame : undefined);
    if (resultId) result.href = guessRouteUrl('stream-result', location.origin, { result: resultId }).href;
    const onRound = live?.phase === 'guess' && !live.ended && resultsPanel.hidden && sharedPanel.hidden && reviewedRound === null;
    const latestShared = Math.max(0, ...sharedRounds?.rounds.keys() ?? []);
    let latestPersonal = -1;
    if (onRound && !latestShared) {
      for (let i = 0; i < (live?.totalRounds ?? STREAM_ROUNDS); i++) if (personal.round(i).reveal) latestPersonal = i;
    }
    previousResult.hidden = !onRound;
    previousResult.disabled = !latestShared && latestPersonal < 0;
    if (onRound) {
      if (latestShared || latestPersonal < 0) bindText(previousResult, 'Round {{round}} results', { round: formatGuessrNumber(latestShared || 1) });
      else {
        const outcome = personal.round(latestPersonal);
        bindText(previousResult, () => `${tr('Round {{round}}', { round: formatGuessrNumber(latestPersonal + 1) })}: ${outcome.pending ? '…' : formatGuessrNumber(outcome.score?.score ?? 0)}`);
      }
    }
    if (pvp) {
      const waiting = !unavailableGame && !!live?.pvp && (live.ended || live.timing?.phase === 'lobby' || live.phase === 'waiting');
      pvpLobby.hidden = !waiting; layout.classList.toggle('show-pvp-lobby', waiting);
      if (waiting) {
        const lobby = !live!.ended && live!.timing?.phase === 'lobby', players = live!.pvp!.players, creator = live!.pvp!.creator;
        const ready = live!.pvp!.ready.includes(state.userId ?? '');
        creatorName.textContent = players[0]?.name ?? '';
        opponentName.textContent = players[1]?.name ?? tr('Waiting for an opponent');
        creatorName.style.color = players[0]?.color && /^#[a-f0-9]{6}$/i.test(players[0].color) ? players[0].color : '';
        opponentName.style.color = players[1]?.color && /^#[a-f0-9]{6}$/i.test(players[1].color) ? players[1].color : '';
        versus.hidden = players.length < 2;
        opponentSlot.hidden = players.length < 2;
        opponentReady.hidden = !lobby || players.length < 2;
        bindText(opponentReady, live!.pvp!.ready.includes(players[1]?.id ?? '') ? 'Ready' : 'Not ready');
        bindText(pvpTitle, lobby ? players.length < 2 ? 'Waiting for an opponent' : 'Ready to start' : 'Your opponent is playing');
        bindText(pvpDetail, () => actionError ? tr(actionError) : lobby ? tr(creator ? 'Share the invitation, then start when both players are ready.' : 'Waiting for both players to be ready.')
          : tr('You will play this location after your opponent.'));
        pvpRule.hidden = !lobby;
        bindText(pvpRule, live!.streaming ? creator ? 'Other players guess each location before it appears on your stream.'
          : 'You guess each location before it appears on the streamer’s broadcast.' : 'Everyone plays the same location at the same time.');
        if (!lobby && !creator) bindText(pvpDetail, 'You have finished your guesses. Waiting for your opponent.');
        if (live!.ended) { bindText(pvpTitle, 'Game ended'); bindText(pvpDetail, 'The match was cancelled.'); }
        pvpInvite.hidden = !lobby || !creator; pvpStart.hidden = !lobby || !creator;
        pvpStart.disabled = pvpCommands > 0 || players.length !== 2 || !live!.pvp!.ready.includes(players[1]?.id ?? '') || connectionState !== 'connected';
        pvpReject.hidden = !lobby || !creator || players.length !== 2;
        pvpReject.disabled = pvpCommands > 0;
        pvpReady.hidden = !lobby || creator; pvpReady.disabled = pvpCommands > 0 || ready || connectionState !== 'connected';
        bindText(pvpReady, ready ? 'Ready' : 'I’m ready');
        pvpClock.hidden = lobby || !!live!.ended;
        const remaining = Math.max(0, Math.ceil(((live!.timing?.deadline ?? gameNow()) - gameNow()) / 1000));
        pvpClock.textContent = `${formatGuessrNumber(Math.floor(remaining / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(remaining % 60, { minimumIntegerDigits: 2 })}`;
      }
      bindText(roomStatus, actionError || (live?.ended ? 'The match was cancelled.' : connectionState === 'stopped' ? connectionDetail : ''));
      roomStatus.hidden = !roomStatus.textContent || live?.phase === 'complete';
    }
    activity.hidden = roomStatus.hidden && delivery.hidden;
  };
  const unsubscribe = viewer.subscribe(refresh);
  const unsubscribeLanguage = onGuessrLanguageChanged(refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('online', refresh);
  startRoom(); refresh();
  checkAutomatic = () => {
    if (unavailableGame) return;
    const deadline = live?.timing?.deadline;
    if (!live?.roundId || deadline == null || autoRound === live.roundId || gameNow() < deadline || gameNow() > deadline + STREAM_SUBMISSION_GRACE_MS) return;
    if (!point || !snapshot || !viewer.getState().connected || isHost() || guessKey() === lastSent) return;
    if (sending) return;
    autoRound = live.roundId; void sendGuess(true);
  };
  const ticks = setInterval(() => { checkAutomatic(); refresh(); }, 250);
  return () => {
    clearAccount(); clearFrame(); joinedNotice.dispose();
    closed = true; clearShared?.(); room?.dispose(); unsubscribe(); unsubscribeLanguage(); chat.dispose(); board.destroy(); viewport?.destroy(); clearControls?.(); clearResults?.();
    clearInterval(ticks);
    window.removeEventListener('offline', refresh); window.removeEventListener('online', refresh);
    sendHelp.dispose(); inviteNotice.dispose(); connection.remove(); round.remove(); activity.remove();
    page?.classList.remove('stream-viewer-page'); main.classList.remove('stream-viewer-shell');
  };
}
