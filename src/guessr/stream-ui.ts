import "./stream.css";
import { updateGameConnection, moveGameExit } from './game-chrome';
import { updateSubmit, submitHelp } from './submit-control';
import { pvpViewer } from './pvp-identity';
import { showActivity, clearActivity } from './activity-ticker';
import { hostSessionExpired, GAME_UNAVAILABLE_MESSAGE } from './stream-lifetime';
import { ParallelConnection } from './parallel-connection';
import type { ParallelServerMessage } from './parallel-types';
import { maximumScore } from './rules';
import { postTwitchGameLink } from './twitch-announcement';
import { gameAuth } from "./api";
import { attachClueControls } from "./clue-view";
import { ClueViewport } from "./clue-viewport";
import { fitClueToPanel } from './clue-stage';
import { allowGuessrChangelog } from './changelog';
import { updateRoundIndicators } from './round-status';
import { supportedCamera } from "./clue-camera";
import type { ImageGameConfig } from "./image-game";
import type { Point } from "./rules";
import { StreamApi } from "./stream-api";
import {
  acceptStreamGuess,
  advanceStreamRound,
  closeStreamRound,
  newStreamGame,
  revealStreamRound,
  reconcileLiveRound,
  streamResult,
  streamStandings,
  streamTime,
  type StreamChatMessage,
} from "./stream-state";
import { streamResultsView } from "./stream-results";
import {
  STREAM_ROUNDS, STREAM_DEFAULT_ROUNDS, STREAM_ROUND_OPTIONS, validStreamRoundCount,
  STREAM_SESSION_KEY,
  type StreamGame,
  type StreamResult,
} from "./stream-types";
import type { TwitchChatStatus, TwitchChatCredentials } from "./twitch-chat";
import { TwitchViewer, savedTwitchViewerId } from "./twitch-viewer";
import { TwitchAnnouncementError, canShareGameLink } from './twitch-announcement';
import { hoverHelp } from './hover-help';
import { mountStreamPicker } from "./stream-picker";
import { liveRoomLink } from "./live-room-game";
import { buttonNotice } from './button-notice';
import { guessRouteUrl, readGuessRoute } from './routes';
import { formatGuessCommand, parseGuessCommand } from './guess-command';
import { streamerProStatus } from './streamer-pro-status';
import { instructionSteps } from './stepper';
import { pageHeading } from './page-heading';
import { loadingPlaceholders } from './loading-placeholders';
import type { LiveRoomView, RoomConnection } from './live-room-types';
import { bindAttribute, bindText, clearTextBinding, formatGuessrNumber, guessrGameTerm, tr } from './i18n';
import { GAME_PROTOCOL } from './game-protocol';
import { startStreamTiming, beginStreamTiming, startHostWindow, streamTick, hostMayGuess, suspendStreamTiming, resumeStreamTiming, validStreamSeconds, shortenFinishedWindow, STREAM_DELIVERY_GRACE_MS } from './stream-timing';
import { streamRoundResults } from './stream-round-results';
import { confirmQuitGame } from './quit-game';
import { playerColor } from './player-color';
import { StreamResultArchive, clearCompletedHostTokens, type ArchivedStreamResult } from './stream-result-archive';
import { streamHostName } from './stream-display-name';
import { streamingSetting } from './streaming-setting';
import { streamsAhead } from './match-settings';
import { streamRevealAt } from './stream-timing';
import { localizedError } from './messages';
import { showRoundProgress } from './round-progress';

const SHARE_ANNOUNCEMENTS_KEY = 'noitamap-guessr-share-announcements';

export interface StreamUIHooks {
  config: ImageGameConfig;
  shell(game?: boolean): HTMLElement;
  panels(
    main: HTMLElement,
    guess: Point | null,
    locked: boolean,
    pick: (point: Point) => void,
    readOnly?: boolean,
    config?: ImageGameConfig,
  ): { clue: HTMLElement; bar: HTMLElement };
  cleanupClue(cleanup: () => void): void;
  markers(guess: Point | null, answer?: Point): void;
  lockGuess(locked: boolean): void;
  hud(options: {
    label: string;
    badge: string;
    twitch?: boolean;
    round: number;
    total: number;
    score: number;
    exit: () => void;
  }): HTMLElement;
  result(
    main: HTMLElement,
    name: string,
    distance: number | null,
    url: string,
    score: number,
    difficulty?: string,
  ): void;
  home(): void;
  toast(message: string): void;
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string | (() => string) = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) bindText(node, text);
  node.className = className;
  return node;
}
function action(
  text: string | (() => string),
  fn: () => unknown,
  className = "secondary",
): HTMLButtonElement {
  const button = el("button", text, className);
  button.type = "button";
  button.onclick = () => void fn();
  return button;
}
async function copy(
  text: string,
  toast: (message: string) => void,
  notice: ReturnType<typeof buttonNotice>,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice.show(tr("Copied"), "success");
  } catch {
    document.querySelector(".stream-copy-fallback")?.remove();
    const textBox = el("textarea", "", "stream-copy-fallback");
    textBox.readOnly = true;
    textBox.value = text;
    bindAttribute(textBox, "aria-label", "Text to copy");
    (document.querySelector("main") ?? document.body).append(textBox);
    textBox.focus();
    textBox.select();
    toast(tr("Select and copy the highlighted text."));
  }
}
function actionRow(...buttons: HTMLElement[]): HTMLElement {
  const row = el('div', '', 'action-row'); row.append(...buttons); return row;
}
function shareButtonLabel(button: HTMLButtonElement, source: string): void {
  let label = button.querySelector<HTMLElement>('.share-button-text');
  if (!label) {
    clearTextBinding(button);
    const wrap = el('span', '', 'share-label'); label = el('span', '', 'share-button-text'); wrap.append(label);
    for (const key of ['Share game link in chat', 'Copy game link', 'Posting…', 'Posted in chat']) {
      const sizer = el('span', '', 'label-sizer'); sizer.setAttribute('aria-hidden', 'true'); bindAttribute(sizer, 'data-label', key); wrap.append(sizer);
    }
    button.replaceChildren(wrap);
  }
  if (button.dataset.label !== source) { button.dataset.label = source; bindText(label, source); }
}
function copyAction(label: string, value: () => string, toast: (message: string) => void): HTMLButtonElement {
  const control = action(label, async () => {
    try { await copy(value(), toast, notice); }
    catch (error) { notice.show(tr((error as Error).message), 'danger'); }
  });
  const notice = buttonNotice(control);
  return control;
}

export class StreamUI {
  readonly api = new StreamApi();
  game: StreamGame | null = null;
  private parallel?: ParallelConnection;
  private parallelAutoRound = '';
  private publicationError = '';
  private parallelDetail = '';
  private coordinatorUnavailable = false;
  private get durable(): boolean { return this.game?.session.transport === 'parallel'; }
  private connectParallel(): void {
    const game = this.game;
    if (!game || !this.durable || this.parallel) return;
    this.parallel = new ParallelConnection(this.api.origin!, game.session.id, 'host:' + game.session.host.id,
      async () => ({ role: 'host', ticket: await this.api.hostSocketTicket() }), {
        status: (status, detail) => {
          if (this.game !== game) return;
          this.coordinatorUnavailable = status === 'stopped' && detail === GAME_UNAVAILABLE_MESSAGE;
          this.roomHealthy = status === 'connected'; this.parallelDetail = detail;
          this.status = status === 'connected' ? 'live' : status === 'retrying' ? 'reconnecting' : status === 'stopped' ? 'auth-required' : 'connecting';
          this.updateStatus(); this.updateTimer();
          if (this.coordinatorUnavailable && this.mounted && !this.quitting) this.render();
        },
        message: message => { if (this.game === game) this.parallelMessage(message); },
      });
  }
  private parallelMessage(message: ParallelServerMessage): void {
    const game = this.game; if (!game) return;
    if (message.type === 'host') {
      this.publicationError = message.publicationError ?? '';
      const before = `${game.round}/${game.stage}/${game.paused}/${game.timing?.phase}/${game.timing?.startsAt}/${game.published}`;
      const oldRound = game.round, oldStage = game.stage, clue = game.clue, pin = game.guess;
      const local = { shareAnnouncements: game.shareAnnouncements, initialShareCount: game.initialShareCount,
        resultShareCount: game.resultShareCount, resultShareAttempted: game.resultShareAttempted, receipts: game.receipts };
      const revealed = game.reveals.length;
      Object.assign(game, message.game, local, { clockOffset: message.now - Date.now(), transportStats: message.metrics });
      if (oldRound === game.round && oldStage === 'guess' && game.stage === 'guess') { game.clue = clue; game.guess = pin; }
      if (message.ended) {
        if (this.quitting) return;
        this.suspend(); this.game = null;
        try { if (JSON.parse(localStorage.getItem(STREAM_SESSION_KEY) ?? 'null')?.session?.id === game.session.id) localStorage.removeItem(STREAM_SESSION_KEY); } catch {}
        this.hooks.home(); return;
      }
      this.roomHealthy = true; this.save();
      this.connectGame();
      const after = `${game.round}/${game.stage}/${game.paused}/${game.timing?.phase}/${game.timing?.startsAt}/${game.published}`;
      if (before !== after || message.publicationError && game.stage === 'complete') this.render();
      this.updateStatus(); this.updateTimer(); if (game.stage !== 'complete') this.startTick();
    } else if (message.type === 'participant') {
      const old = game.participants.find(p => p.id === message.participant.id);
      if (old) Object.assign(old, message.participant); else game.participants.push(message.participant);
      if (message.participant.id !== game.session.host.id) {
        game.joinedPlayers ??= {}; game.joinedPlayers[message.participant.id] = message.participant;
      }
      if (message.submittedCounts) game.submittedCounts = message.submittedCounts;
      if (message.submitted) {
        this.recentGuesser = message.participant.name; this.activityUntil = Date.now() + 6000;
        const notice = document.getElementById('stream-activity-message');
        if (notice) showActivity(notice, this.recentGuesser, playerColor(message.participant, game.session.host.id));
      }
      this.saveTimer ??= setTimeout(this.save, 250); this.updateLobby(true); this.updateStatus();
    } else if (message.type === 'published') {
      const changed = !game.published; game.published = true; this.save();
      if (changed && game.stage === 'complete') this.finish();
      void this.shareResultLink(true);
    }
  }
  private async durableCommand(type: 'start' | 'advance' | 'quit' | 'publish'): Promise<void> {
    this.connectParallel();
    await this.parallel!.command({ type, id: crypto.randomUUID() });
  }
  private viewer?: TwitchViewer;
  private status: TwitchChatStatus = "offline";
  private statusDetail = "Chat disconnected.";
  private busy = false;
  private clearSubmit?: () => void;
  private playView?: { main: HTMLElement; gameId: string; round: number };
  private quitting = false;
  private mounted = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveWarning = false;
  private pulseTimer?: ReturnType<typeof setTimeout>;
  private roomHealthy = true;
  private proStatus?: ReturnType<typeof streamerProStatus>;
  private statusHelp?: ReturnType<typeof hoverHelp>;
  private startPermissionHelp?: ReturnType<typeof hoverHelp>;
  private shareNotice?: ReturnType<typeof buttonNotice>;
  private sharePending = false;
  private sharedUntil = 0;
  private shareStatus = '';
  private shareFeedbackUntil = 0;
  private autoShareOnConnect = false;
  private shareTimer?: ReturnType<typeof setTimeout>;
  private shareAnnouncements = false;
  private sharingPermissionFailed = false;
  private setupCredentials?: TwitchChatCredentials;
  private tickTimer?: ReturnType<typeof setInterval>;
  private tickSavedAt = 0;
  private timedRounds = true;
  private roundSeconds = 90;
  private roundCount = STREAM_DEFAULT_ROUNDS;
  private streaming = true;
  private hostRelease?: () => void;
  private activityUntil = 0;
  private guessNoticeTimer?: ReturnType<typeof setTimeout>;
  private recentGuesser = '';
  private lobbyTimer?: ReturnType<typeof setTimeout>;
  private archive = new StreamResultArchive();
  private publications = new Map<string, Promise<void>>();
  private disposeHeader(): void {
    this.playView = undefined;
    clearActivity(document.getElementById('stream-activity-message'));
    this.clearSubmit?.(); this.clearSubmit = undefined;
    this.proStatus?.dispose(); this.proStatus = undefined;
    this.statusHelp?.dispose(); this.statusHelp = undefined;
    this.startPermissionHelp?.dispose(); this.startPermissionHelp = undefined;
    this.shareNotice?.dispose(); this.shareNotice = undefined;
    clearTimeout(this.guessNoticeTimer); this.guessNoticeTimer = undefined;
    clearTimeout(this.lobbyTimer); this.lobbyTimer = undefined;
    clearTimeout(this.shareTimer);
  }
  constructor(private hooks: StreamUIHooks) {
    const pane = readGuessRoute(new URL(location.href)).pane;
    // A chatter tab may share browser storage with the host. It must never
    // restore, save or pause that private host session.
    if (pane === 'stream-picker' || pane === 'pvp' || pane === 'pvp-game') return;
    try { this.shareAnnouncements = localStorage.getItem(SHARE_ANNOUNCEMENTS_KEY) === 'true'; } catch { /* Optional preference. */ }
    try {
      const settings = JSON.parse(localStorage.getItem('noitamap-guessr-round-timer') ?? 'null');
      if (settings && validStreamSeconds(settings.seconds) && settings.seconds > 0) this.roundSeconds = settings.seconds;
      if (typeof settings?.automatic === 'boolean') this.timedRounds = settings.automatic;
      if (validStreamRoundCount(settings?.rounds)) this.roundCount = settings.rounds;
    } catch { /* Use the default 90-second timer. */ }
    try {
      const saved = JSON.parse(
        localStorage.getItem(STREAM_SESSION_KEY) || "null",
      ) as StreamGame;
      if (
        saved?.schema === 1 &&
        (this.api.local || !hostSessionExpired(saved)) &&
        (pane !== 'stream-result' || saved.stage === 'complete' && saved.session?.id === readGuessRoute(new URL(location.href)).result) &&
        (this.api.local || saved.stage === 'complete' || saved.session?.transport === 'parallel' && saved.session.protocol === GAME_PROTOCOL) &&
        typeof saved.session.token === "string" &&
        /^[a-f0-9-]{36}$/.test(saved.session.id) &&
        validStreamRoundCount(saved.session.rounds?.length) &&
        (saved.session.live || saved.stage === "complete") &&
        Number.isInteger(saved.round) &&
        saved.round >= 0 &&
        saved.round < saved.session.rounds.length &&
        ["guess", "closing", "reveal", "complete"].includes(saved.stage) &&
        Array.isArray(saved.participants) &&
        Array.isArray(saved.reveals) &&
        saved.reveals.length <= saved.session.rounds.length &&
        (supportedCamera(saved.session.rounds[saved.round].clue, saved.clue)
          || saved.session.transport === 'parallel' && ['lobby', 'warmup'].includes(saved.timing?.phase ?? ''))
      ) {
        this.game = saved;
        if ((saved.initialShareCount ?? 0) >= (saved.shareAnnouncements ? 1 : 3)) this.shareStatus = 'Game link shared in chat.';
        if (typeof saved.shareAnnouncements === 'boolean') this.shareAnnouncements = saved.shareAnnouncements;
        if (this.api.local) this.api.setLocalChannel(saved.session.localChat ? saved.session.host.login : undefined);
        if (!Number.isFinite(saved.clockOffset)) saved.clockOffset = 0;
        // An interrupted host must explicitly resume before accepting messages.
        if (saved.stage === "guess" && saved.session.transport !== 'parallel') saved.paused = true;
      }
    } catch {
      /* A corrupt local recovery file never prevents using the picker. */
    }
  }
  save = (): void => {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.game || this.quitting) return;
    try {
      localStorage.setItem(STREAM_SESSION_KEY, JSON.stringify(this.game));
      this.saveWarning = false;
    } catch {
      if (!this.saveWarning)
        this.hooks.toast(
          tr("This browser could not save stream progress. Keep this tab open and download the completed result."),
        );
      this.saveWarning = true;
    }
  };
  suspend(): void {
    this.disposeHeader();
    const wasHosting = this.mounted;
    this.parallel?.dispose(); this.parallel = undefined;
    this.mounted = false;
    clearInterval(this.tickTimer);
    if (!this.durable && this.game?.timing && wasHosting && this.game.stage !== 'complete') {
      suspendStreamTiming(this.game, streamTime(this.game));
    }
    this.hostRelease?.(); this.hostRelease = undefined;
    clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;

    if (!this.durable && wasHosting && this.game?.stage === "guess") {
      if (this.game.timing) suspendStreamTiming(this.game, streamTime(this.game));
      else this.game.paused = true;
      if (this.api.local && this.game.session.live && !this.game.timing)
        void this.api.pause(this.game.session.id, true).catch(() => {});
    }
    if (wasHosting) this.save();
  }
  /** Called after confirmation. Failure leaves recovery data for an idempotent retry. */
  async quit(): Promise<void> {
    const game = this.game;
    if (!game || game.stage === 'complete') return;
    if (this.busy) throw new Error(tr('Wait for the current game action to finish, then try quitting again.'));
    if (this.durable && !this.coordinatorUnavailable) {
      this.quitting = true;
      try { await this.durableCommand('quit'); } catch (error) {
        if ((error as Error).message !== GAME_UNAVAILABLE_MESSAGE) { this.quitting = false; throw error; }
      }
    }
    this.busy = true;
    this.quitting = true;
    this.mounted = false;
    this.roomHealthy = false;
    game.paused = true;
    try {
      this.disposeHeader();
      this.parallel?.dispose(); this.parallel = undefined; this.coordinatorUnavailable = false;
      clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
      clearTimeout(this.saveTimer); this.saveTimer = undefined;

      clearInterval(this.tickTimer);

      this.hostRelease?.(); this.hostRelease = undefined;
      if (this.api.local && game.session.live && !game.timing) await this.api.quit(game.session.id);
      // Another tab may have saved a different game while the request ran.
      const raw = localStorage.getItem(STREAM_SESSION_KEY);
      let saved: StreamGame | undefined;
      try { saved = raw ? JSON.parse(raw) as StreamGame : undefined; } catch { /* Leave unrelated corrupt data alone. */ }
      if (saved?.session?.id === game.session.id && saved.stage !== 'complete')
        localStorage.removeItem(STREAM_SESSION_KEY);
      if (this.game === game) this.game = null;
      this.saveWarning = false;
    } catch (error) {
      this.mounted = true; this.render();
      throw error;
    } finally {
      this.quitting = false;
      this.busy = false;
    }
  }
  private exit = (): void => {
    if (!this.game || this.game.stage === 'complete') { this.suspend(); this.hooks.home(); return; }
    confirmQuitGame(async () => { await this.quit(); this.hooks.home(); },
      'This ends the game for you and your chat. The unfinished game will not be added to results.');
  };
  async open(showCompleted = false): Promise<void> {
    this.disposeHeader();
    this.sharingPermissionFailed = false;
    this.setupCredentials = undefined;
    this.mounted = true;
    if (showCompleted && this.game?.stage === "complete") {
      this.finish();
      return;
    }
    const shell = this.hooks.shell();
    allowGuessrChangelog(false);
    shell.classList.add('stream-setup-shell');
    const main = el('section', '', 'card card-body rounded-9 stream-setup-card');
    shell.append(main);
    const heading = pageHeading(el("h1", "Chat vs Streamer", "twitch-mode-label"), action('Back', this.exit));
    main.append(heading);
    const accountStep = el('div'), playStep = el('div'), shareStep = el('div');
    accountStep.append(el('h2', 'Connect Twitch'));
    playStep.append(el('h2', 'Start new game'), streamingSetting('stream', value => { this.streaming = value; }).element);
    const timerRow = el('div', '', 'd-flex align-items-center gap-2');
    const timerSwitch = el('span', '', 'switch theme-primary'), automatic = el('input');
    automatic.type = 'checkbox'; automatic.id = 'stream-automatic-timer'; automatic.setAttribute('role', 'switch'); automatic.checked = this.timedRounds;
    const timerLabel = el('label', 'Automatic round timer'); timerLabel.htmlFor = automatic.id;
    timerSwitch.append(automatic); timerRow.append(timerSwitch, timerLabel);
    const lengthRow = el('div', '', 'stream-timer-settings'), seconds = el('input');
    seconds.type = 'number'; seconds.id = 'stream-round-seconds'; seconds.min = '15'; seconds.max = '600'; seconds.step = '1'; seconds.value = String(this.roundSeconds);
    const secondsLabel = el('label', 'Round length (seconds)'); secondsLabel.htmlFor = seconds.id;
    lengthRow.append(secondsLabel, seconds);
    const manualWarning = el('p', 'Without the timer, your submission closes chat’s current round.', 'form-text');
    const earlyHint = el('p', 'Timed rounds end early when the streamer and every chatter who joined before the round started have submitted.', 'form-text');
    const updateTimerSetting = () => {
      this.timedRounds = automatic.checked;
      const value = Number(seconds.value); if (validStreamSeconds(value) && value > 0) this.roundSeconds = value;
      seconds.disabled = !this.timedRounds; manualWarning.hidden = this.timedRounds;
      earlyHint.hidden = !this.timedRounds;
      try { localStorage.setItem('noitamap-guessr-round-timer', JSON.stringify({ automatic: this.timedRounds, seconds: this.roundSeconds, rounds: this.roundCount })); } catch { /* Optional preference. */ }
    };
    automatic.onchange = seconds.onchange = updateTimerSetting; updateTimerSetting();
    const gameLengthRow = el('label', '', 'stream-length-setting');
    const gameLength = el('select'); gameLength.className = 'form-select';
    for (const count of STREAM_ROUND_OPTIONS) {
      const option = el('option', () => tr('{{rounds}} rounds', { rounds: formatGuessrNumber(count), count }));
      option.value = String(count); gameLength.append(option);
    }
    gameLength.value = String(this.roundCount);
    gameLength.onchange = () => { const count = Number(gameLength.value); if (validStreamRoundCount(count)) this.roundCount = count; updateTimerSetting(); };
    gameLengthRow.append(el('span', 'Number of rounds'), gameLength);
    playStep.append(gameLengthRow, timerRow, lengthRow, manualWarning);
    playStep.append(earlyHint);
    shareStep.append(el('h2', 'Share game link in chat'));
    const sharingRow = el('div', '', 'd-flex align-items-center gap-2');
    const switchBox = el('span', '', 'switch theme-primary');
    const announcements = el('input'); announcements.type = 'checkbox'; announcements.id = 'stream-share-announcements';
    announcements.setAttribute('role', 'switch'); announcements.checked = this.shareAnnouncements;
    const label = el('label', 'Share game links as announcements'); label.htmlFor = announcements.id;
    switchBox.append(announcements); sharingRow.append(switchBox, label);
    const sharingHelp = el('p', 'The link is posted three times as normal messages, or once as an announcement.', 'form-text');
    sharingHelp.id = 'stream-sharing-help'; announcements.setAttribute('aria-describedby', sharingHelp.id);
    const permissionNote = el('p', 'First, allow NoitaGuessr to post messages in your Twitch chat.', 'form-text');
    permissionNote.id = 'stream-sharing-permission';
    let sharingReady = false;
    let startButton: HTMLButtonElement | undefined;
    const hasSharingPermission = () => this.canPostGameLink(this.shareAnnouncements);
    const refreshSharing = () => {
      const granted = hasSharingPermission();
      enableSharing.hidden = !sharingReady || granted;
      permissionNote.hidden = !sharingReady || granted;
      if (startButton) {
        startButton.disabled = this.busy || !sharingReady || !granted;
        this.updateStartPermissionHelp(startButton, sharingReady && !granted);
      }
    };
    const enableSharing = action('Enable sharing in chat', async () => {
      if (this.busy) return;
      this.busy = true; enableSharing.disabled = true; announcements.disabled = true;
      refreshSharing();
      try {
        if (this.api.local) await this.viewer!.connect({ posting: true, announcements: this.shareAnnouncements });
        else await this.connectAuth();
      } catch (error) { this.hooks.toast(tr((error as Error).message)); }
      finally {
        this.busy = false; enableSharing.disabled = false; announcements.disabled = false;
        if (main.isConnected) refreshSharing();
      }
    }, 'btn btn-solid theme-primary');
    enableSharing.id = 'stream-enable-sharing'; enableSharing.hidden = true; permissionNote.hidden = true;
    announcements.onchange = () => {
      this.shareAnnouncements = announcements.checked;
      try { localStorage.setItem(SHARE_ANNOUNCEMENTS_KEY, String(this.shareAnnouncements)); } catch { /* Optional preference. */ }
      if (this.game && this.game.stage !== 'complete') { this.game.shareAnnouncements = this.shareAnnouncements; this.save(); }
      refreshSharing();
    };
    shareStep.append(sharingRow, sharingHelp, permissionNote, enableSharing);
    main.append(instructionSteps(accountStep, shareStep, playStep));
    const setupActions = actionRow();
    playStep.append(setupActions);
    // A completed download remains available even if the host's current sign-in
    // can no longer start games. Only an unfinished game needs room recovery.
    if (this.game?.stage === 'complete') {
      setupActions.append(action('View saved results', () => this.resume()));
    }
    if (!this.api.available) {
      accountStep.append(el('p', 'Chat vs Streamer is not available on this site yet.'));
      return;
    }
    const loading = el(
      "p",
      this.api.local
        ? "Loading local stream mode…"
        : "Checking Pro and Twitch access…",
    );
    loading.setAttribute('role', 'status');
    const placeholders = loadingPlaceholders();
    accountStep.setAttribute('aria-busy', 'true');
    accountStep.append(loading, placeholders);
    try {
      if (this.api.local) {
        this.viewer ??= new TwitchViewer();
        await this.viewer.ready;
        if (!main.isConnected) return;
        sharingReady = this.viewer.getState().connected;
        refreshSharing();
      }
      if (!this.api.local) {
        const auth = await gameAuth();
        auth.registerLoginPreparation("guessr", () => {
          this.save();
          return { pane: "stream" };
        });
        if (!main.isConnected) return;
        if (auth.getState().authenticated && !auth.getState().isSubscriber) await auth.refreshMembership();
      if (!auth.getState().isSubscriber) {
          const { createProControls } = await import("../auth/pro-controls");
          if (!main.isConnected) return;
          bindText(loading, "The streamer needs Pro. Everyone in chat can use the free guess picker.");
          accountStep.append(
            createProControls({
              beforeLogin: this.save,
              idPrefix: "guessr-stream-",
              streamerMode: true,
            }),
          );
          return;
        }
        const state = auth.getState();
        if (state.provider !== 'twitch' && !state.linkedAccounts?.some(account => account.provider === 'twitch')) {
          loading.remove();
          accountStep.append(el('p', 'Connect your Twitch channel before hosting.'),
            action('Connect Twitch', () => auth.loginTwitch(), 'primary'));
          return;
        }
        try { this.setupCredentials = await auth.getTwitchChatSession() ?? undefined; } catch { this.setupCredentials = undefined; }
        if (!main.isConnected) return;
        sharingReady = true; refreshSharing();
      }
      if (this.game && this.game.stage !== "complete") {
        const clock = await this.api.clock();
        if (!main.isConnected) return;
        this.game.clockOffset = clock.now - Date.now();
        this.save();
      }
      loading.remove();
      if (this.api.local)
        accountStep.append(
          el(
            "p",
            () => this.viewer?.getState().connected
              ? tr('Local test connected to {{channel}}. You can test the streamer and a chatter in separate tabs with this account.', { channel: this.viewer.getState().login! })
              : tr('Connect Twitch to test real chat. Offline simulation is available below.'),
            "notice",
          ),
        );
      else accountStep.append(el('p', 'Connected'));
      if (this.game && this.game.stage !== 'complete')
        setupActions.append(
          action(
            "Continue Chat vs Streamer",
            () => this.resume(),
            "primary",
          ),
        );
      const startActions = this.api.local && !this.viewer?.getState().connected ? accountStep : setupActions;
      const needsConnection = this.api.local && !this.viewer?.getState().connected;
      const create = action(needsConnection ? 'Connect Twitch' : 'Start new game', async () => {
        if (needsConnection) return this.connectLocalTwitch();
        refreshSharing();
        if (create.disabled) return;
        const pending = this.start(); refreshSharing();
        await pending;
        if (main.isConnected) refreshSharing();
      }, this.game && this.game.stage !== 'complete' ? 'secondary' : 'primary');
      if (needsConnection) startActions.append(create);
      else {
        startButton = create; create.id = 'stream-create-game'; create.disabled = true;
        create.setAttribute('aria-describedby', permissionNote.id);
        const wrapper = el('span', '', 'control-help'); wrapper.append(create); startActions.append(wrapper);
        refreshSharing();
      }
      if (this.api.local) {
        const offline = el('details', '', 'stream-local-input');
        offline.append(el('summary', 'Offline testing'), action('Start simulated game', () => this.start(false)));
        main.append(offline);
      }
    } catch (error) {
      if (main.isConnected) {
        bindText(loading, (error as Error).message);
        if (!loading.isConnected) accountStep.append(loading);
        accountStep.append(action("Retry", () => this.open()));
      }
    } finally {
      placeholders.remove(); accountStep.removeAttribute('aria-busy');
    }
  }
  private async connectAuth(): Promise<void> {
    this.save();
    try {
      await (await gameAuth()).connectTwitchChat({ announcements: this.shareAnnouncements });
    } catch (error) {
      this.hooks.toast(localizedError(error));
    }
  }
  private async connectLocalTwitch(): Promise<void> {
    this.viewer ??= new TwitchViewer();
    try { await this.viewer.connect({ announcements: this.shareAnnouncements }); if (this.mounted) await this.open(false); }
    catch (error) { this.hooks.toast(tr((error as Error).message)); }
  }
  private async start(useTwitch = true): Promise<void> {
    if (this.busy) return;
    if (useTwitch && !this.canPostGameLink(this.shareAnnouncements)) {
      this.hooks.toast(tr('First, allow NoitaGuessr to post messages in your Twitch chat.')); return;
    }
    this.busy = true;
    try {
      if (useTwitch && this.timedRounds) {
        const input = document.getElementById('stream-round-seconds') as HTMLInputElement | null;
        const seconds = input ? Number(input.value) : this.roundSeconds;
        if (!validStreamSeconds(seconds) || seconds === 0) throw Error('Choose a round duration between 15 and 600 seconds.');
        this.roundSeconds = seconds;
      }
      if (this.api.local) {
        const identity = this.viewer?.getState();
        if (useTwitch && (!identity?.connected || !identity.login)) throw new Error(tr('Connect Twitch before starting a live test.'));
        this.api.setLocalChannel(useTwitch ? identity!.login! : undefined);
      }
      const session = await this.api.start(this.api.local ? undefined : 'parallel', this.roundCount, this.timedRounds ? this.roundSeconds : 0, this.streaming);
      if (session.transport === 'parallel' && !this.streaming && session.streaming !== false) throw Error('This timing option is not available on this site yet.');
      if (session.transport !== 'parallel') session.streaming = this.streaming;
      if (session.transport) await this.acquireHost(session.host.id);
      this.parallel?.dispose(); this.parallel = undefined;

      this.game = newStreamGame(session);
      this.shareStatus = ''; this.sharedUntil = 0;
      this.autoShareOnConnect = useTwitch;
      this.game.shareAnnouncements = this.shareAnnouncements;
      if (session.transport) {
        startStreamTiming(this.game, this.timedRounds ? this.roundSeconds : 0, session.serverNow, true);
      }
      this.roomHealthy = true;
      this.connectParallel(); this.startPulse();
      this.save();
      if (this.mounted) {
        this.render();
        this.connectGame();
      }
    } catch (error) {
      this.hooks.toast(localizedError(error));
    } finally {
      this.busy = false;
    }
  }
  private async acquireHost(id: string): Promise<void> {
    if (this.hostRelease || !navigator.locks) return;
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request('noitaguessr-host:' + id, { ifAvailable: true }, async lock => {
        if (!lock) { reject(Error('Another tab is hosting this game. Continue there.')); return; }
        await new Promise<void>(release => { this.hostRelease = release; resolve(); });
      }).catch(reject);
    });
  }
  private startTick(): void {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      const game = this.game;
      if (!game?.timing || !this.mounted) return;
      const now = streamTime(game);
      this.updateTimer();
      if (this.busy) return;
      if (this.durable) {
        if (document.querySelector('.stream-host-shell[data-starting]') && now >= game.timing.startsAt) this.render();
        const roundId = game.session.rounds[game.round].id;
        if (game.stage === 'guess' && game.timing.phase === 'play' && game.timing.deadline !== null
          && now >= game.timing.deadline && now <= game.timing.deadline + 2000 && this.parallelAutoRound !== roundId) {
          this.parallelAutoRound = roundId; void this.submit(true);
        }
        return;
      }
      if (shortenFinishedWindow(game, now)) { this.save(); this.updateTimer(); }
      if (game.stage === 'closing' && streamRevealAt(game, now) <= now) { void this.submit(true); return; }
      if (document.querySelector('.stream-host-shell[data-starting]') && now >= game.timing.startsAt && !game.paused) this.render();
      const revision = game.timing.revision;
      const next = streamTick(game, now);
      if (next === 'warmup-finished') {
        startHostWindow(game, now); this.save();  this.render();
      } else if (next === 'submit') void this.submit(true);
      else if (next === 'advance' || next === 'finish') void this.nextRound();
      else if (now - this.tickSavedAt >= 5000) { this.tickSavedAt = now; this.save(); }
    }, 250);
  }
  private updateTimer(): void {
    const game = this.game, timing = game?.timing;
    if (!game || !timing) return;
    // Absolute deadlines remain meaningful during a transport interruption.
    // Connection status has its own indicator; it must not replace the clock.
    const now = game.paused ? timing.suspendedAt ?? timing.lastActiveAt : this.durable && this.parallel?.connected() ? this.parallel.now() : streamTime(game);
    const starting = Math.max(0, Math.ceil((timing.startsAt - now) / 1000));
    const deadline = game.stage === 'reveal' ? Math.max(game.round === game.session.rounds.length - 1 ? now : timing.deadline ?? now, timing.resultsUntil ?? now)
      : timing.deadline ?? now;
    const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
    const clock = `${formatGuessrNumber(Math.floor(remaining / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(remaining % 60, { minimumIntegerDigits: 2 })}`;
    const label = game.paused ? tr('Reconnecting…') : timing.phase === 'lobby' ? tr('Not started') : starting ? tr('Starting in {{seconds}}', { seconds: formatGuessrNumber(starting) })
      : timing.deadline === null ? tr('Manual timing') : clock;
    for (const timer of document.querySelectorAll<HTMLElement>('#stream-round-timer, #stream-start-countdown, #stream-waiting-timer'))
      { if (timer.textContent !== label) timer.textContent = label;
        timer.dataset.clock = String(!game.paused && !starting && timing.deadline !== null);
        if (timer.id === 'stream-round-timer') timer.hidden = timing.phase === 'lobby'; }
    const waitingTimer = document.getElementById('stream-waiting-timer');
    if (waitingTimer) waitingTimer.dataset.clock = String(!game.paused && !starting && timing.deadline !== null);
    const next = document.getElementById('stream-auto-next');
    if (next) {
      const final = game.round === game.session.rounds.length - 1;
      const until = Math.max(final ? now : timing.deadline ?? now, timing.resultsUntil ?? now);
      const seconds = Math.max(0, Math.ceil((until - now) / 1000));
      const nextClock = `${formatGuessrNumber(Math.floor(seconds / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(seconds % 60, { minimumIntegerDigits: 2 })}`;
      bindText(next, final ? 'Results available in: {{time}}' : 'Next round in {{time}}', { time: nextClock });
    }
    const first = document.getElementById('stream-first-round') as HTMLButtonElement | null;
    if (first) first.disabled = game.paused || !!starting;
    const start = document.getElementById('stream-start-game') as HTMLButtonElement | null;
    if (start) {
      const missing = this.needsSharingApproval();
      start.disabled = game.paused || !this.roomHealthy || this.sharePending || this.busy || missing;
      this.updateStartPermissionHelp(start, missing);
      const approval = document.getElementById('stream-start-approval');
      if (approval) approval.hidden = !missing;
    }
    const activity = document.getElementById('stream-activity-message');
    if (activity) activity.style.visibility = Date.now() < this.activityUntil ? 'visible' : 'hidden';
    const shared = document.getElementById('stream-share-status');
    if (shared) shared.hidden = timing.phase !== 'lobby' && !this.sharePending && Date.now() >= this.shareFeedbackUntil;
    const bar = document.getElementById('stream-waiting-progress');
    if (bar) {
      const fraction = timing.seconds ? Math.max(0, Math.min(1, remaining / timing.seconds)) : 1;
      bar.style.inlineSize = `${fraction * 100}%`;
      bar.parentElement!.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
  }
  private updateLobby(force = false): void {
    if (!this.game) return;
    const players = Object.entries(this.game.joinedPlayers ?? {});
    const count = document.getElementById('stream-joined-count');
    if (count) bindText(count, 'Chatters joined: {{total}}', { total: formatGuessrNumber(players.length) + (this.game.joinedOverflow ? '+' : '') });
    const names = document.getElementById('stream-joined-names');
    if (names && (force || names.dataset.count !== String(players.length))) {
      names.dataset.count = String(players.length);
      names.replaceChildren(...players.slice(-10).map(([id, player]) => {
        const name = el('span', '', 'stream-player-name'); name.textContent = player.name;
        name.style.color = playerColor({ id, color: player.color }, this.game!.session.host.id); return name;
      }));
    }
  }
  private renderWarmup(main: HTMLElement): void {
    const section = el('section', '', 'game-panel stream-start-panel');
    section.append(el('span', 'Chat vs Streamer', 'badge-subtle theme-primary twitch-mode-label'));
    const count = el('strong', '', 'stream-joined-count'); count.id = 'stream-joined-count';
    const names = el('div', '', 'stream-joined-names'); names.id = 'stream-joined-names';
    if (this.game!.timing!.phase === 'lobby') {
      section.append(el('h2', 'Ready to start'), el('p', 'Share the game link, then start when your chat is ready.'));
      section.append(el('p', streamsAhead(this.game!.session) ? 'Other players guess each location before it appears on your stream.'
        : 'Everyone plays the same location at the same time.'));
      const start = action('Start game', () => {
        const game = this.game!;
        if (game.paused || !this.roomHealthy || this.sharePending || this.busy || this.needsSharingApproval()) return;
        if (this.durable) { void this.durableCommand('start').catch(e => this.hooks.toast(tr(e.message))); return; }
        beginStreamTiming(game, streamTime(game)); this.save();  this.render();
      }, 'primary');
      start.id = 'stream-start-game';
      const wrapper = el('span', '', 'control-help'); wrapper.append(start);
      const approval = el('div'); approval.id = 'stream-start-approval';
      const consent = action('Enable sharing in chat', async () => {
        if (this.busy) return;
        this.busy = true; consent.disabled = true; this.updateTimer();
        try {
          if (this.api.local) {
            await this.viewer!.connect({ posting: true, announcements: this.game?.shareAnnouncements === true });
            if (this.viewer!.canShare(this.game?.shareAnnouncements === true)) this.sharingPermissionFailed = false;
          }
          else await this.connectAuth();
        } catch (error) { this.hooks.toast(localizedError(error)); }
        finally { this.busy = false; consent.disabled = false; this.updateTimer(); this.updateShareButton(); }
      }, 'btn btn-solid theme-primary');
      approval.append(el('p', 'First, allow NoitaGuessr to post messages in your Twitch chat.', 'form-text'), consent);
      const controls = actionRow(); controls.classList.add('stream-lobby-actions');
      const share = document.getElementById('stream-share');
      if (share) controls.append(share);
      controls.append(wrapper);
      section.append(count, names, controls);
      const shared = document.getElementById('stream-share-status');
      if (shared) section.append(shared);
      section.append(approval); main.append(section); this.updateLobby(); this.updateTimer(); return;
    }
    section.classList.add('stream-warmup');
    section.append(el('h2', () => tr('Chat is playing round {{round}}', { round: formatGuessrNumber(1) })));
    const time = el('output', '', 'stream-waiting-timer'); time.id = 'stream-waiting-timer';
    const progress = el('div', '', 'progress theme-primary'); progress.setAttribute('role', 'progressbar');
    bindAttribute(progress, 'aria-label', 'Your first round starts when chat finishes this round.');
    progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
    const bar = el('div', '', 'progress-bar'); bar.id = 'stream-waiting-progress'; progress.append(bar);
    section.append(time, progress, el('p', 'Your first round starts when chat finishes this round.'), count, names,
      el('p', 'Chat submits their guesses before the streamer sees the location.'));
    if (!this.game!.timing!.seconds) {
      const start = action('Start first round', () => {
        const game = this.game!;
        if (game.paused || streamTime(game) < game.timing!.startsAt) return;
        if (this.durable) { void this.durableCommand('advance').catch(e => this.hooks.toast(tr(e.message))); return; }
        startHostWindow(game, streamTime(game)); this.save();  this.render();
      }, 'primary');
      start.id = 'stream-first-round'; section.append(start);
    }
    main.append(section); this.updateLobby();
  }
  private connectGame(): void {
    this.connectParallel();
    if (!this.mounted || !this.game || this.game.stage === 'complete') return;
    if (this.api.local && !this.durable) { this.roomHealthy = true; this.status = 'live'; this.updateStatus(); }
    if (this.autoShareOnConnect && (this.parallel?.connected() || this.api.local) && this.game.timing?.phase === 'lobby') {
      this.autoShareOnConnect = false; void this.shareGameLink(true);
    }
  }
  private connectionState(): RoomConnection {
    if (this.durable) return this.parallel?.state() ?? 'connecting';
    if (this.api.local && !this.game?.session.localChat || this.roomHealthy && this.status === 'live') return 'connected';
    if (navigator.onLine === false) return 'offline';
    return this.status === 'connecting' ? 'connecting' : this.status === 'reconnecting' ? 'retrying' : 'stopped';
  }
  private connectionLabel(): string {
    const state = this.connectionState();
    return state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : state === 'offline' ? 'Network issues'
      : state === 'retrying' ? 'Reconnecting…' : 'Disconnected';
  }
  private updateStatus(): void {
    if (this.mounted) {
      const state = this.connectionState();
      updateGameConnection(state === 'retrying' ? 'reconnecting' : state === 'stopped' ? 'disconnected' : state,
        this.parallelDetail || this.connectionLabel());
    }
    const reconnect = document.getElementById('stream-reconnect') as HTMLButtonElement | null;
    if (reconnect) {
      const needsGameRecovery = !this.roomHealthy || !!this.game?.paused;
      reconnect.hidden = this.status !== 'auth-required' && !(this.parallel?.state() === 'stopped' && this.parallelDetail === 'Sign in with Twitch to play.');
      if (this.api.local && !this.game?.session.localChat && !needsGameRecovery) reconnect.hidden = true;
      bindText(reconnect, 'Authorize Twitch');
    }
    const count = document.getElementById("stream-guess-count");
    if (count && this.game) {
      const round = this.game.timing?.chatRound ?? this.game.round;
      const total = this.game.submittedCounts?.[round] ?? this.game.participants.filter(p => p.id !== this.game!.session.host.id && p.guesses[round]).length;
      if (this.game.timing?.chatRound === null) bindText(count, 'Chatters have finished all rounds.', { rounds: formatGuessrNumber(this.game.session.rounds.length) });
      else bindText(count, 'Chat round {{round}}: {{total}} submitted', { round: formatGuessrNumber(round + 1), total: formatGuessrNumber(total) });
      count.hidden = this.game.timing?.phase === 'lobby';
    }
    this.updateShareButton();
  }
  private updateShareButton(): void {
    const button = document.getElementById('stream-share') as HTMLButtonElement | null;
    if (!button) return;
    const posted = Date.now() < this.sharedUntil;
    clearTimeout(this.shareTimer);
    if (posted) this.shareTimer = setTimeout(() => this.updateShareButton(), this.sharedUntil - Date.now());
    button.disabled = this.sharePending || posted || this.status === 'connecting' || this.status === 'reconnecting';
    button.dataset.posted = String(posted);
    shareButtonLabel(button, this.sharePending ? 'Posting…' : posted ? 'Posted in chat'
      : this.canPostGameLink() ? 'Share game link in chat' : 'Copy game link');
    const confirmation = document.getElementById('stream-share-status');
    if (confirmation) {
      bindText(confirmation, this.sharePending ? 'Posting…' : this.shareStatus);
      confirmation.hidden = this.game?.timing?.phase !== 'lobby' && !this.sharePending && Date.now() >= this.shareFeedbackUntil;
    }
  }
  private updateStartPermissionHelp(button: HTMLButtonElement, missing: boolean): void {
    const wrapper = button.parentElement!;
    if (missing) {
      wrapper.tabIndex = 0;
      this.startPermissionHelp ??= hoverHelp(wrapper, () => tr('First, allow NoitaGuessr to post messages in your Twitch chat.'), button);
    } else {
      this.startPermissionHelp?.dispose(); this.startPermissionHelp = undefined;
      wrapper.removeAttribute('tabindex'); wrapper.removeAttribute('aria-description'); button.removeAttribute('aria-description');
    }
  }
  private needsSharingApproval(): boolean {
    return (!this.api.local || this.game?.session.localChat === true) && !this.canPostGameLink();
  }
  private canPostGameLink(announcements = this.game?.shareAnnouncements === true): boolean {
    return !this.sharingPermissionFailed && (this.api.local ? !!this.viewer?.canShare(announcements)
      : canShareGameLink(this.setupCredentials, announcements));
  }
  private async shareGameLink(automatic = false): Promise<boolean> {
    const game = this.game;
    if (!game || this.coordinatorUnavailable || this.quitting || this.sharePending || !automatic && Date.now() < this.sharedUntil) return false;
    if (!this.canPostGameLink()) {
      if (!automatic && this.shareNotice) await copy(this.pickerUrl(), this.hooks.toast, this.shareNotice);
      else { this.shareStatus = 'Sharing permission is unavailable. You can copy the game link.'; this.updateShareButton(); }
      return false;
    }
    this.sharePending = true; this.updateShareButton();
    try {
      const message = tr('Join NoitaGuessr: {{url}}', { url: this.pickerUrl() });
      const posts = game.shareAnnouncements ? 1 : 3;
      const alreadySent = automatic ? Math.max(0, Math.min(posts, game.initialShareCount ?? 0)) : 0;
      if (automatic && Date.now() < this.sharedUntil) await new Promise(resolve => setTimeout(resolve, this.sharedUntil - Date.now()));
      for (let index = alreadySent; index < posts; index++) {
        if (this.game !== game || !this.mounted || this.quitting || this.coordinatorUnavailable) return false;
        if (this.api.local) await this.viewer!.postGameLink(game.session.host.login, message, game.shareAnnouncements === true);
        else await postTwitchGameLink(this.setupCredentials, game.session.host.id, message, game.shareAnnouncements === true);
        if (automatic) { game.initialShareCount = index + 1; this.save(); }
        if (index + 1 < posts) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      this.sharedUntil = Date.now() + 2000;
      this.shareFeedbackUntil = game.timing?.phase === 'lobby' ? 0 : Date.now() + 5000;
      this.shareStatus = 'Game link shared in chat.';
      return true;
    } catch (error) {
      this.shareFeedbackUntil = game.timing?.phase === 'lobby' ? 0 : Date.now() + 10000;
      if (error instanceof TwitchAnnouncementError && error.permissionRequired) {
        this.sharingPermissionFailed = true;
        this.shareStatus = 'Sharing permission is unavailable. You can copy the game link.';
      } else this.shareStatus = (error as Error).message;
      return false;
    } finally { this.sharePending = false; this.updateShareButton(); }
  }
  private viewerImageRoot(): string {
    return this.game?.session.imageRoot || import.meta.env.VITE_GUESSR_IMAGE_ROOT || (this.api.local
      ? '/guessr-images/images'
      : 'https://guessr-tiles.sage-data.xyz/images');
  }
  private pickerUrl(): string {
    const url = guessRouteUrl("stream-picker", location.origin);
    if (!this.game) return url.href;
    return liveRoomLink(location.origin, this.game.session.host.login, this.game.session.id, this.game.session.transport);
  }
  private updateProStatus(room: LiveRoomView): void {
    if (!this.game) return;
    this.game.session.hostProVerifiedUntil = room.hostPro === 'active' ? room.hostProVerifiedUntil : undefined;
    this.proStatus?.update(room);
  }
  private startPulse(): void {
    if (this.game?.timing) { this.startTick(); return; }
    clearTimeout(this.pulseTimer);
    const game = this.game;
    if (!this.api.local || !game?.session.live || game.stage === 'complete' || !this.mounted) return;
    // Exactly one host request per minute, independent of audience size.
    this.pulseTimer = setTimeout(async () => {
      if (!this.mounted || this.game !== game) return;
      try {
        const room = await this.api.pulse(game.session.id);
        if (this.game !== game || !this.mounted) return;
        this.updateProStatus(room);
        const advanced = reconcileLiveRound(game, room);
        // Repair an old viewer tab's accidental pause, while keeping the host's
        // own Pause setting authoritative. This adds a call only on mismatch.
        if (room.phase === 'guess' && room.paused !== game.paused)
          await this.api.pause(game.session.id, game.paused);
        if (advanced) this.save();
        const recovered = !this.roomHealthy;
        this.roomHealthy = true;
        if (recovered || advanced) this.render();
      } catch (error) {
        if (this.game !== game || !this.mounted) return;
        if (this.roomHealthy) {
          this.roomHealthy = false;
          this.hooks.toast(tr((error as Error).message));
          this.render();
        }
      }
      this.startPulse();
    }, 60_000);
  }
  private async resume(): Promise<void> {
    if (!this.game || this.busy) return;
    if (this.durable) { this.connectParallel(); this.roomHealthy = !!this.parallel?.connected(); this.startTick(); this.render(); this.connectGame(); return; }
    if (this.game.stage === "complete") { this.finish(); return; }
    this.busy = true;
    try {
      if (this.game.timing) {
        await this.acquireHost(this.game.session.host.id);

        this.game.paused = false;
      } else if (this.api.local && this.game.session.live) {
        const room = await this.api.pulse(this.game.session.id);
        this.updateProStatus(room);
        reconcileLiveRound(this.game, room);
        if (this.game.stage === 'guess')
          await this.api.pause(this.game.session.id, false);
      }
      if (this.game.stage === 'guess' && !this.game.timing) this.game.paused = false;
      this.game.shareAnnouncements = this.shareAnnouncements;
      this.roomHealthy = true; this.save(); this.startPulse(); this.busy = false; this.render(); this.connectGame();
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.busy = false; }
  }
  private async nextRound(): Promise<void> {
    if (!this.game || this.busy) return;
    if (this.durable) { await this.durableCommand('advance'); return; }
    this.busy = true;
    const game = this.game;
    try {
      if (this.api.local && !game.timing) await this.api.advance(game.session.id, game.session.rounds[game.round].id);
      advanceStreamRound(game); this.roomHealthy = true; this.save();
      this.busy = false; this.render();
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.busy = false; }
  }
  private waitingForGuesses(): string {
    const game = this.game!;
    return streamRevealAt(game, streamTime(game)) > streamTime(game) && !streamsAhead(game.session)
      ? 'Your guess is locked. Waiting for the other players.'
      : this.durable ? 'Waiting for confirmation' : 'Round closed. Chat guesses and your submission are saved.';
  }
  /** Accepting a guess changes controls, not the two live map surfaces. */
  private lockSubmittedView(): boolean {
    const game = this.game!, view = this.playView;
    if (!this.durable || game.stage !== 'closing' || game.reveals[game.round] || !view?.main.isConnected
      || view.gameId !== game.session.id || view.round !== game.round) return false;
    const submit = view.main.querySelector<HTMLButtonElement>('#confirm-guess');
    if (!submit) return false;
    this.hooks.lockGuess(true);
    for (const controls of view.main.querySelectorAll<HTMLElement>('.clue-controls')) {
      controls.inert = true;
      for (const button of controls.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
    }
    submit.disabled = true; updateSubmit(submit, 'Guess received', 'received');
    const hint = view.main.querySelector('.action-hint-label');
    if (hint) bindText(hint, this.waitingForGuesses());
    this.updateStatus(); this.updateTimer();
    return true;
  }
  render(): void {
    if (!this.game) {
      void this.open();
      return;
    }
    this.mounted = true;
    if (this.game.stage === "complete") {
      this.finish();
      return;
    }
    if (this.coordinatorUnavailable) {
      this.disposeHeader();
      const main = this.hooks.shell(); main.classList.add('stream-setup-shell');
      const panel = el('section', '', 'game-panel stream-start-panel');
      panel.append(el('h2', 'Game ended'), el('p', GAME_UNAVAILABLE_MESSAGE), action('Start new game', async () => { await this.quit(); await this.open(); }, 'primary'));
      main.append(panel); moveGameExit(main, action('Exit game', this.exit, 'btn btn-outline theme-secondary'));
      updateGameConnection('disconnected', GAME_UNAVAILABLE_MESSAGE);
      return;
    }
    if (this.lockSubmittedView()) return;
    const game = this.game,
      index = game.round,
      reveal = game.reveals[index];
    this.disposeHeader();
    this.proStatus = streamerProStatus({ local: this.api.local });
    this.proStatus.update({ gameId: game.session.id, hostPro: 'active', hostProVerifiedUntil: game.session.hostProVerifiedUntil });
    const main = this.hooks.shell(true);
    allowGuessrChangelog(false);
    main.classList.add('stream-host-shell');
    const banner = el("div", "", "stream-banner stream-toolbar");
    const navigation = el('div', '', 'stream-toolbar-navigation');
    moveGameExit(main, action('Exit game', this.exit, 'btn btn-sm btn-outline theme-secondary'));
    const phase = el('div', '', 'stream-toolbar-round');
    const roundIndicator = el('strong');
    if (game.timing?.phase === 'lobby') bindText(roundIndicator, 'Ready to start');
    else if (game.timing?.phase === 'warmup') bindText(roundIndicator, 'Chat goes first');
    else showRoundProgress(roundIndicator, game.session.rounds.length, index + 1, game.reveals.length);
    phase.append(roundIndicator);
    if (game.timing) { const timer = el('span', '', 'stream-round-timer'); timer.id = 'stream-round-timer'; phase.append(timer); }
    const commands = el('div', '', 'stream-toolbar-actions');
    banner.append(navigation, phase, commands);
    const count = el("span", '', 'stream-guess-count');
    count.id = "stream-guess-count";
    const identity = el('span', '', 'stream-host-identity');
    const name = el('span', '', 'stream-name');
    const historyLink = el('a', () => game.session.host.login, 'stream-channel-link');
    historyLink.href = guessRouteUrl('history', location.origin, { channel: game.session.host.login }).href;
    historyLink.target = '_blank'; historyLink.rel = 'noopener noreferrer';
    bindAttribute(historyLink, 'aria-label', '{{player}}’s results', { player: game.session.host.login });
    const hostName = el('strong'); hostName.append(historyLink);
    name.append(hostName, this.proStatus.badge); identity.append(name);
    identity.append(el('span', 'Chat vs Streamer', 'stream-mode-label'));
    navigation.append(identity);
    if (!this.api.local || game.session.localChat) {
      const share = action('Share game link in chat', () => this.shareGameLink(), 'btn btn-sm btn-outline theme-secondary stream-share-button');
      share.id = 'stream-share'; share.setAttribute('aria-live', 'polite');
      this.shareNotice = buttonNotice(share);
      commands.append(share);
    }
    const reconnect = action('Reconnect', () => {
      if (this.status === 'auth-required' || this.parallel?.state() === 'stopped') return this.api.local ? this.connectLocalTwitch() : this.connectAuth();
      if (!this.roomHealthy || game.paused) return this.resume();

      this.connectGame();
    }, 'btn btn-sm btn-outline theme-secondary');
    reconnect.id = 'stream-reconnect'; commands.append(reconnect);
    const activity = el('div', '', 'stream-activity');
    const recent = el('span', '', 'stream-activity-message'); recent.id = 'stream-activity-message'; recent.setAttribute('role', 'status');
    if (Date.now() < this.activityUntil) bindText(recent, '{{player}} submitted a guess', { player: this.recentGuesser });
    const shared = el('span', this.shareStatus, 'stream-share-status'); shared.id = 'stream-share-status'; shared.setAttribute('role', 'status');
    activity.append(count, recent, shared); main.append(banner, activity);
    this.updateStatus();
    if (game.timing && game.timing.phase !== 'play') { this.renderWarmup(main); this.updateTimer(); return; }
    if (game.timing && reveal) {
      const actions = el('div', '', 'game-actions stream-host-actions');
      const next = action(index === game.session.rounds.length - 1 ? 'View results' : 'Next round',
        () => this.nextRound(), 'primary');
      if (game.timing.seconds) { next.id = 'stream-auto-next'; next.disabled = true; }
      actions.append(next);
      this.hooks.cleanupClue(streamRoundResults(main, game, index, actions));
      this.updateTimer(); return;
    }
    const host = game.participants.find((p) => p.id === game.session.host.id)!;
    const submitted = host.guesses[index];
    const { clue } = this.hooks.panels(
      main,
      reveal ? (submitted?.point ?? null) : game.guess,
      !!reveal || game.stage !== "guess" || game.paused || !this.roomHealthy || !hostMayGuess(game, streamTime(game)),
      (point) => {
        if (hostMayGuess(game, streamTime(game)) && this.roomHealthy) {
          game.guess = point;
          this.save();
        }
      },
      !!reveal,
      game.session.config,
    );
    updateRoundIndicators(main, game.clue, reveal?.area.difficultyTier ?? game.session.rounds[index].difficultyTier);
    if (reveal || game.stage === "closing") {
      const viewport = new ClueViewport(clue, game.session.rounds[index].clue);
      this.hooks.cleanupClue(() => viewport.destroy());
      void viewport
        .show(reveal ? { dx: 0, dy: 0, level: 6 } : game.clue)
        .catch(() =>
          this.hooks.toast(
            tr("Clue image could not load. Reopen the round to retry."),
          ),
        );
    } else if (!game.paused)
      this.hooks.cleanupClue(
        attachClueControls(
          clue,
          game.session.rounds[index].clue,
          game.clue,
          256,
          this.save,
          { compact: true, difficultyTier: game.session.rounds[index].difficultyTier },
        ),
      );
    clue.classList.toggle("paused", game.paused && !reveal);
    fitClueToPanel(clue);
    if (game.timing && streamTime(game) < game.timing.startsAt) {
      const grid = main.querySelector<HTMLElement>('.game-grid');
      if (grid) {
        grid.inert = true;
        const countdown = el('div', '', 'stream-countdown'); countdown.id = 'stream-start-countdown';
        grid.append(countdown); main.dataset.starting = 'true';
      }
    }
    const actions = el("div", "", "game-actions stream-host-actions");
    if (reveal) {
      const scored = streamStandings([host], game.reveals)[0].rounds[index];
      this.hooks.markers(submitted?.point ?? null, reveal.answer);
      this.hooks.result(
        main,
        reveal.area.label,
        scored.distance,
        `/?${game.session.dataset ? `m=dy&ds=1&se=${game.session.dataset.seed}` : 'm=r'}&x=${reveal.answer.x}&y=${reveal.answer.y}&z=850`,
        scored.score,
        scored.difficultyTier,
      );
      actions.append(
        el("p", "Your guess is blue. The location is green."),
        action(
          index + 1 === game.session.rounds.length ? "View results" : "Next round",
          () => this.nextRound(),
          "primary",
        ),
      );
      if (game.timing?.seconds) {
        const next = actions.querySelector<HTMLButtonElement>('button')!;
        next.id = 'stream-auto-next'; next.disabled = true;
      }
    } else if (game.stage === "closing") {
      const accepted = action('Guess received', () => {}, 'primary'); accepted.id = 'confirm-guess'; accepted.disabled = true; actions.append(accepted);
      const waiting = streamRevealAt(game, streamTime(game)) > streamTime(game);
      if (!this.durable && !waiting) actions.append(action("Retry reveal", () => this.submit(), "primary"));
    } else {
      const submit = action(
        "Submit guess",
        () => this.submit(),
        "primary",
      );
      submit.id = "confirm-guess";
      submit.disabled = !game.guess || !hostMayGuess(game, streamTime(game)) || !this.roomHealthy;
      actions.append(submit);
    }
    if (!reveal) {
      const hint = el('p', '', 'action-hint submit-label'), label = el('span', '', 'action-hint-label'); hint.append(label);
      const currentHint = game.stage === 'closing' ? this.waitingForGuesses() : game.paused
        ? 'Paused: chat guesses are not being accepted.'
        : game.timing?.seconds ? 'Your guess locks when submitted. Chat keeps its full timer.' : 'Submitting closes chat guesses for this round.';
      bindText(label, currentHint);
      for (const key of [currentHint, 'Pin placed. Ready when you are.', 'Your guess is locked. Waiting for the other players.',
        'Waiting for confirmation', 'Round closed. Chat guesses and your submission are saved.']) {
        const sizer = el('span', '', 'label-sizer'); sizer.setAttribute('aria-hidden', 'true'); bindAttribute(sizer, 'data-label', key); hint.append(sizer);
      }
      actions.prepend(hint);
    }
    const mapPanel = main.querySelector('.game-panel--map');
    if (mapPanel) {
      const toolbar = mapPanel.querySelector('.map-bar'), submit = actions.querySelector('#confirm-guess');
      if (toolbar && submit) {
        toolbar.classList.add('guess-map-toolbar'); toolbar.append(submit);
        updateSubmit(submit as HTMLButtonElement, game.stage === 'closing' ? 'Guess received' : 'Submit guess', game.stage === 'closing' ? 'received' : 'ready');
        this.clearSubmit = submitHelp(submit as HTMLButtonElement, () => game.stage === 'closing' ? 'Guess received' : this.busy ? 'Sending…' : !this.roomHealthy ? 'Reconnecting…' : !game.guess ? 'Place a pin first' : 'Submit guess');
      }
      mapPanel.insertBefore(actions, mapPanel.querySelector('.map-board'));
    } else main.append(actions);
    if (!reveal) this.playView = { main, gameId: game.session.id, round: index };
    this.updateTimer();
    if (this.api.local && !reveal && game.stage === "guess")
      this.localInput(main);
  }
  private localInput(main: HTMLElement): void {
    const details = el("details", "", "stream-local-input");
    details.append(
      el("summary", "Simulate a viewer guess (local testing only)"),
    );
    const form = el("form"),
      user = el("input"),
      command = el("input"),
      send = el("button", "Receive simulated message"),
      output = el("span");
    bindAttribute(user, "placeholder", "Twitch user ID");
    user.value = "1234";
    bindAttribute(user, "aria-label", "Simulated Twitch user ID");
    command.placeholder = `!noitaguessr_guess ${this.game!.round + 1} X Y`;
    bindAttribute(command, "aria-label", "Simulated guess command");
    command.className = "stream-command";
    send.type = "submit";
    form.append(user, command, send, output);
    form.onsubmit = (event) => {
      event.preventDefault();
      const id = user.value.trim();
      const parsed = parseGuessCommand(command.value, { rounds: this.game!.session.rounds.length, bounds: this.game!.session.config.bounds });
      const result = acceptStreamGuess(this.game!, {
        player: { id, login: "viewer_" + id, name: "Viewer " + id },
        id: crypto.randomUUID(),
        text: parsed && /^\d{1,30}$/.test(id) ? formatGuessCommand(parsed.round, parsed, parsed.maximum,
          parsed.roundId ?? this.game!.session.rounds[this.game!.round].id, { userId: id }) : command.value,
        sentAt: streamTime(this.game!),
      });
      bindText(output, ({ accepted: 'Guess accepted', invalid: 'Invalid guess', duplicate: 'Duplicate guess',
        closed: 'Round closed', old: 'Guess is for an earlier round', future: 'Guess is for a later round',
        host: 'The streamer submits from the streamer controls' })[result]);
      this.save();
      this.updateStatus();
    };
    details.append(form);
    main.append(details);
  }
  private async submit(timedOut = false): Promise<void> {
    if (
      !this.game ||
      this.busy ||
      (this.game.stage === "guess" && (this.game.paused || !this.durable && !this.roomHealthy || !timedOut && !this.game.guess))
    )
      return;
    this.busy = true;
    const send = document.getElementById('confirm-guess') as HTMLButtonElement | null;
    if (send) { send.disabled = true; updateSubmit(send, 'Sending…', 'waiting'); }
    try {
      if (this.durable) {
        const game = this.game, nonce = crypto.getRandomValues(new Uint8Array(8));
        const id = Array.from(nonce, n => n.toString(16).padStart(2, '0')).join('');
        const roundId = game.session.rounds[game.round].id, maximum = maximumScore(game.clue);
        const durable = this.parallel!.command({ type: 'host-guess', id, roundId, point: game.guess, maximum });
        await durable; return;
      }
      const wasClosing = this.game.stage === 'closing';
      closeStreamRound(this.game, this.game.guess);
      shortenFinishedWindow(this.game, streamTime(this.game));
      this.save();
      if (!wasClosing) this.render();
      const game = this.game;
      if (game.timing && streamRevealAt(game, streamTime(game)) > streamTime(game)) return;
      if (this.game !== game) return;
      const reveal = await this.api.reveal(
        game.session.rounds[game.round].token,
        game.timing ? undefined : game.participants.map(player => ({
          player: { id: player.id, login: player.login, name: player.name },
          guess: player.guesses[game.round]?.point ?? null,
          maximum: player.guesses[game.round]?.maximum ?? 5000,
        })),
      );
      revealStreamRound(game, reveal);
      if (game.timing) { game.timing.revision++;   }
      this.save();
      if (this.mounted) this.render();
    } catch (error) {
      this.hooks.toast(tr((error as Error).message));
    } finally {
      this.busy = false;
      if (send?.isConnected && this.game?.stage === 'guess') {
        send.disabled = !this.game.guess || !hostMayGuess(this.game, streamTime(this.game)) || !this.roomHealthy;
        updateSubmit(send, 'Submit guess');
      }
    }
  }
  private finish(): void {
    this.disposeHeader();
    if (!this.game) return;
    if (this.durable && !this.game.published) this.connectParallel();
    history.replaceState(null, '', guessRouteUrl('stream-result', location.href, { result: this.game.session.id }));
    clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
    clearInterval(this.tickTimer);
    const result = streamResult(this.game),
      main = this.hooks.shell();
    allowGuessrChangelog(false);
    const entry: ArchivedStreamResult = { result, published: !!this.game.published,
      ...(!this.game.published && this.game.session.token ? { pendingToken: this.game.session.token } : {}),
      ...(this.game.session.localChat ? { localChannel: this.game.session.host.login } : {}) };
    const view = streamResultsView(result, undefined, this.exit, this.hooks.config);
    this.hooks.cleanupClue(view.destroy);
    main.append(view);
    this.resultPublication(view, entry, this.game);
    main.append(actionRow(action('Start another game', async () => {
      // Do not replace the singleton host session until its retry credential is
      // durable, or publication has already been confirmed.
      const saved = await this.archive.get(result.id).catch(() => undefined);
      if (!entry.published && !saved?.published && !saved?.pendingToken && this.game?.session.transport !== 'parallel') {
        this.hooks.toast(tr('This browser could not save the result. Download a copy before closing this page.'));
        return;
      }
      await this.open(false);
    })));
  }
  private resultPublication(view: HTMLElement, entry: ArchivedStreamResult, game?: StreamGame): void {
    const panel = el('div', '', 'stream-banner stream-publication'), message = el('p');
    message.id = 'stream-publish-message'; message.setAttribute('role', 'status');
    const shareResult = action('Share results in chat', () => this.shareResultLink(), 'btn btn-outline theme-secondary');
    shareResult.id = 'stream-share-result'; shareResult.hidden = !game;
    const copy = copyAction('Copy result link', () => guessRouteUrl('stream-result', location.origin, { result: entry.result.id }).href, this.hooks.toast);
    const retry = action('Retry publishing', () => { void publish(); });
    const hostName = streamHostName(entry.result.host, entry.result.players.find(player => player.id === entry.result.host.id));
    const historyLink = el('a', () => tr('{{player}}’s results', { player: hostName }), 'btn btn-outline theme-secondary');
    historyLink.href = guessRouteUrl('history', location.origin, { channel: entry.result.host.login }).href;
    const actions = actionRow(copy, retry, shareResult, historyLink);
    panel.append(message, actions);
    view.querySelector('.finish-hero')!.after(panel);
    let storageWarning = '';
    const update = (key?: string) => {
      copy.disabled = !entry.published; shareResult.disabled = !entry.published;
      retry.hidden = entry.published || !entry.pendingToken && game?.session.transport !== 'parallel';
      bindText(message, () => [key ? tr(key) : tr(entry.published
        ? this.api.local ? 'Result saved to the local test server.' : 'Results published.'
        : game?.session.transport === 'parallel' ? 'Not published yet. Retrying automatically.' : storageWarning ? 'Not published. Retry publishing to make the result available to everyone.' : 'Saved on this device. Not published yet.'), storageWarning && tr(storageWarning), game?.session.transport === 'parallel' && !entry.published && this.publicationError ? tr(this.publicationError) : ''].filter(Boolean).join(' '));
    };
    const save = async () => {
      try {
        await this.archive.save(entry);
        if (game) clearCompletedHostTokens(game);
        const saved = await this.archive.get(entry.result.id);
        if (saved) { Object.assign(entry, saved); if (!saved.pendingToken) delete entry.pendingToken; }
        storageWarning = '';
      }
      catch (error) { storageWarning = (error as Error).message; }
    };
    const publish = async () => {
      if (game?.session.transport === 'parallel') { await this.durableCommand('publish'); return; }
      retry.disabled = true; update('Publishing the completed result…');
      try {
        await this.publish(entry, game); entry.published = true; delete entry.pendingToken;
        await save(); update();
      } catch (error) {
        bindText(message, () => [tr('Not published. Retry publishing to make the result available to everyone.'),
          tr((error as Error).message), storageWarning && tr(storageWarning)].filter(Boolean).join(' '));
      } finally { retry.disabled = false; copy.disabled = !entry.published; retry.hidden = entry.published || !entry.pendingToken; }
    };
    update(entry.published ? undefined : game ? 'Publishing the completed result…' : 'Loading results…');
    void save().then(() => {
      if (game && !entry.published && game.session.transport !== 'parallel') return publish();
      update(); if (game?.published) { void this.shareResultLink(true); this.finishBroadcast(game); }
    });
  }
  private async shareResultLink(automatic = false): Promise<void> {
    const game = this.game;
    if (!game?.published || this.sharePending || automatic && game.resultShareAttempted || !automatic && Date.now() < this.sharedUntil) return;
    this.sharePending = true;
    const control = document.getElementById('stream-share-result') as HTMLButtonElement | null;
    if (control) { control.disabled = true; bindText(control, 'Posting…'); }
    try {
      if (automatic) { game.resultShareAttempted = true; this.save(); }
      const message = tr('Latest NoitaGuessr game results: {{url}}', { url: guessRouteUrl('stream-result', location.origin, { result: game.session.id }).href });
      const posts = game.shareAnnouncements ? 1 : 3;
      const credentials = this.api.local ? undefined : await (await gameAuth()).getTwitchChatSession();
      for (let i = automatic ? game.resultShareCount ?? 0 : 0; i < posts; i++) {
        if (this.api.local) await this.viewer!.postGameLink(game.session.host.login, message, !!game.shareAnnouncements);
        else await postTwitchGameLink(credentials ?? undefined, game.session.host.id, message, !!game.shareAnnouncements);
        game.resultShareCount = i + 1; this.save();
        if (i + 1 < posts) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      this.sharedUntil = Date.now() + 2000;
      if (control) bindText(control, 'Posted in chat');
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally {
      this.sharePending = false;
      setTimeout(() => { if (control?.isConnected) { control.disabled = false; bindText(control, 'Share results in chat'); } }, 2000);
    }
  }
  private finishBroadcast(game: StreamGame): void {
    if (this.game !== game || !game.published) return;
    this.parallel?.dispose(); this.parallel = undefined; clearInterval(this.tickTimer);
  }

  private publish(entry: ArchivedStreamResult, game?: StreamGame): Promise<void> {
    const id = entry.result.id;
    const active = this.publications.get(id);
    if (active) return active;
    if (entry.published) return Promise.resolve();
    if (!entry.pendingToken) return Promise.reject(new Error('Publish the result first, or share the downloaded file.'));
    const pending = (async () => {
      const api = this.api.local ? new StreamApi() : this.api;
      if (api.local) api.setLocalChannel(entry.localChannel);
      const confirmation = await api.publish({ token: entry.pendingToken!, finishedAt: entry.result.finishedAt, players: entry.result.players, positions: entry.result.positions });
      if (!confirmation.published || confirmation.id !== id) throw new Error('The result was not saved. Please retry publishing.');
      entry.published = true; delete entry.pendingToken;
      if (game) {
        game.published = true;
        if (game.timing) game.timing.revision++;
        // Publishing an older result must never overwrite a newer host session.
        if (this.game === game) { this.save(); void this.shareResultLink(true); }
      }
    })().finally(() => {
      this.publications.delete(id);
      if (game) this.finishBroadcast(game);
    });
    this.publications.set(id, pending);
    return pending;
  }
  async publicResult(id: string): Promise<void> {
    this.suspend();
    if (this.game?.session.id === id && this.game.stage === 'complete') {
      if (!this.game.published) try { await this.api.result(id); this.game.published = true; this.save(); } catch {}
      this.finish(); return;
    }
    const main = this.hooks.shell(),
      loading = el("p", "Loading results…");
    const heading = pageHeading(el('h1', 'Game results'), action('Back', this.exit));
    main.append(heading, loading);
    try {
      let entry = await this.archive.get(id);
      if (entry?.result.mode === 'pvp' && !entry.published && navigator.onLine !== false) try {
        entry = { result: await this.api.result(id), published: true };
        await this.archive.save(entry);
      } catch { /* The saved complete result stays readable without a connection. */ }
      if (!entry) entry = { result: await this.api.result(id), published: true };
      if (!main.isConnected) return;
      loading.remove(); heading.remove();
      const viewerId = this.viewer?.getState().userId ?? savedTwitchViewerId();
      const view = streamResultsView(entry.result, viewerId, this.exit, this.hooks.config);
      this.hooks.cleanupClue(view.destroy);
      main.append(view); this.resultPublication(view, entry);
      allowGuessrChangelog(false);

    } catch (error) {
      if (main.isConnected) bindText(loading, (error as Error).message);
    }
  }
  picker(): void {
    this.suspend();
    const url = guessRouteUrl('stream-picker', location.href);
    window.history.replaceState(null, "", url);
    const main = this.hooks.shell(true);
    void (async () => {
      try {
        const viewer = this.api.local ? this.viewer ?? new TwitchViewer() : await pvpViewer('player');
        if (!main.isConnected) { if (viewer !== this.viewer) viewer.dispose(); return; }
        if (this.viewer !== viewer) this.viewer?.dispose(); this.viewer = viewer;
        this.hooks.cleanupClue(mountStreamPicker(main, this.hooks.config, viewer, this.viewerImageRoot(), this.hooks.home));
      } catch (error) { if (main.isConnected) main.append(el('p', (error as Error).message, 'error')); }
    })();
  }
}
