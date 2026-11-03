import "./stream.css";
import { gameAuth } from "./api";
import { attachClueControls } from "./clue-view";
import { ClueViewport } from "./clue-viewport";
import { fitClueToPanel } from './clue-stage';
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
import { downloadStreamResult, streamResultsView } from "./stream-results";
import {
  STREAM_ROUNDS,
  STREAM_SESSION_KEY,
  type StreamGame,
  type StreamResult,
} from "./stream-types";
import { TwitchChatConnection, type TwitchChatStatus, type TwitchChatCredentials } from "./twitch-chat";
import { TwitchViewer } from "./twitch-viewer";
import { TwitchAnnouncementError, canShareGameLink } from './twitch-announcement';
import { hoverHelp } from './hover-help';
import { GUESSR_TRANSPORT_CHANNEL } from './chat-transport';
import { mountStreamPicker } from "./stream-picker";
import { liveRoomLink } from "./live-room-game";
import { buttonNotice } from './button-notice';
import { guessRouteUrl, readGuessRoute } from './routes';
import { formatGuessCommand, parseGuessCommand } from './guess-command';
import { streamerProStatus } from './streamer-pro-status';
import { instructionSteps } from './stepper';
import { pageHeading } from './page-heading';
import { loadingPlaceholders } from './loading-placeholders';
import type { LiveRoomView } from './live-room-types';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, tr } from './i18n';
import { StreamBroadcastHost } from './stream-broadcast-host';
import { startStreamTiming, beginStreamTiming, startHostWindow, streamTick, hostMayGuess, suspendStreamTiming, resumeStreamTiming, validStreamSeconds, STREAM_DELIVERY_GRACE_MS } from './stream-timing';
import { streamRoundResults } from './stream-round-results';

const SHARE_ANNOUNCEMENTS_KEY = 'noitamap-guessr-share-announcements';

export interface StreamUIHooks {
  config: ImageGameConfig;
  shell(game?: boolean): HTMLElement;
  panels(
    main: HTMLElement,
    guess: Point | null,
    locked: boolean,
    pick: (point: Point) => void,
  ): { clue: HTMLElement; bar: HTMLElement };
  cleanupClue(cleanup: () => void): void;
  markers(guess: Point | null, answer?: Point): void;
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
  private chat?: TwitchChatConnection;
  private viewer?: TwitchViewer;
  private stopLocalChat?: () => void;
  private status: TwitchChatStatus = "offline";
  private statusDetail = "Chat disconnected.";
  private busy = false;
  private quitting = false;
  private mounted = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private registeredAuth = false;
  private saveWarning = false;
  private pulseTimer?: ReturnType<typeof setTimeout>;
  private roomHealthy = true;
  private proStatus?: ReturnType<typeof streamerProStatus>;
  private statusHelp?: ReturnType<typeof hoverHelp>;
  private shareNotice?: ReturnType<typeof buttonNotice>;
  private sharePending = false;
  private sharedUntil = 0;
  private shareStatus = '';
  private autoShareOnConnect = false;
  private shareTimer?: ReturnType<typeof setTimeout>;
  private shareAnnouncements = false;
  private sharingPermissionFailed = false;
  private setupCredentials?: TwitchChatCredentials;
  private broadcast?: StreamBroadcastHost;
  private tickTimer?: ReturnType<typeof setInterval>;
  private tickSavedAt = 0;
  private timedRounds = true;
  private roundSeconds = 90;
  private hostRelease?: () => void;
  private activityUntil = 0;
  private guessNoticeTimer?: ReturnType<typeof setTimeout>;
  private recentGuesser = '';
  private disposeHeader(): void {
    this.proStatus?.dispose(); this.proStatus = undefined;
    this.statusHelp?.dispose(); this.statusHelp = undefined;
    this.shareNotice?.dispose(); this.shareNotice = undefined;
    clearTimeout(this.guessNoticeTimer); this.guessNoticeTimer = undefined;
    clearTimeout(this.shareTimer);
  }
  constructor(private hooks: StreamUIHooks) {
    const pane = readGuessRoute(new URL(location.href)).pane;
    // A chatter tab may share browser storage with the host. It must never
    // restore, save or pause that private host session.
    if (pane === 'stream-picker' || pane === 'stream-result') return;
    try { this.shareAnnouncements = localStorage.getItem(SHARE_ANNOUNCEMENTS_KEY) === 'true'; } catch { /* Optional preference. */ }
    try {
      const settings = JSON.parse(localStorage.getItem('noitamap-guessr-round-timer') ?? 'null');
      if (settings && validStreamSeconds(settings.seconds) && settings.seconds > 0) this.roundSeconds = settings.seconds;
      if (typeof settings?.automatic === 'boolean') this.timedRounds = settings.automatic;
    } catch { /* Use the default 90-second timer. */ }
    try {
      const saved = JSON.parse(
        localStorage.getItem(STREAM_SESSION_KEY) || "null",
      ) as StreamGame;
      if (
        saved?.schema === 1 &&
        saved.session?.version === hooks.config.version &&
        typeof saved.session.token === "string" &&
        /^[a-f0-9-]{36}$/.test(saved.session.id) &&
        saved.session.rounds?.length === STREAM_ROUNDS &&
        (saved.session.live || saved.stage === "complete") &&
        Number.isInteger(saved.round) &&
        saved.round >= 0 &&
        saved.round < saved.session.rounds.length &&
        ["guess", "closing", "reveal", "complete"].includes(saved.stage) &&
        Array.isArray(saved.participants) &&
        Array.isArray(saved.reveals) &&
        saved.reveals.length <= saved.session.rounds.length &&
        supportedCamera(saved.session.rounds[saved.round].clue, saved.clue)
      ) {
        this.game = saved;
        if ((saved.initialShareCount ?? 0) >= (saved.shareAnnouncements ? 1 : 3)) this.shareStatus = 'Game link shared in chat.';
        if (typeof saved.shareAnnouncements === 'boolean') this.shareAnnouncements = saved.shareAnnouncements;
        if (this.api.local) this.api.setLocalChannel(saved.session.localChat ? saved.session.host.login : undefined);
        if (!Number.isFinite(saved.clockOffset)) saved.clockOffset = 0;
        // An interrupted host must explicitly resume before accepting messages.
        if (saved.stage === "guess") saved.paused = true;
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
    this.mounted = false;
    clearInterval(this.tickTimer);
    if (this.game?.timing && wasHosting && this.game.stage !== 'complete') {
      suspendStreamTiming(this.game, streamTime(this.game)); void this.broadcast?.close();
    } else this.broadcast?.dispose();
    this.broadcast = undefined;
    this.hostRelease?.(); this.hostRelease = undefined;
    clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    this.chat?.stop();
    this.chat = undefined;
    this.stopLocalChat?.(); this.stopLocalChat = undefined;
    if (wasHosting && this.game?.stage === "guess") {
      if (this.game.timing) suspendStreamTiming(this.game, streamTime(this.game));
      else this.game.paused = true;
      if (this.game.session.live && !this.game.timing)
        void this.api.pause(this.game.session.id, true).catch(() => {});
    }
    if (wasHosting) this.save();
  }
  /** Called after confirmation. Failure leaves recovery data for an idempotent retry. */
  async quit(): Promise<void> {
    const game = this.game;
    if (!game || game.stage === 'complete') return;
    if (this.busy) throw new Error(tr('Wait for the current game action to finish, then try quitting again.'));
    this.busy = true;
    this.quitting = true;
    this.mounted = false;
    this.roomHealthy = false;
    game.paused = true;
    try {
      this.disposeHeader();
      clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
      clearTimeout(this.saveTimer); this.saveTimer = undefined;
      this.chat?.stop(); this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
      clearInterval(this.tickTimer);
      if (this.broadcast) await this.broadcast.close(true);
      this.broadcast = undefined;
      this.hostRelease?.(); this.hostRelease = undefined;
      if (game.session.live && !game.timing) await this.api.quit(game.session.id);
      // Another tab may have saved a different game while the request ran.
      const raw = localStorage.getItem(STREAM_SESSION_KEY);
      let saved: StreamGame | undefined;
      try { saved = raw ? JSON.parse(raw) as StreamGame : undefined; } catch { /* Leave unrelated corrupt data alone. */ }
      if (saved?.session?.id === game.session.id && saved.stage !== 'complete')
        localStorage.removeItem(STREAM_SESSION_KEY);
      if (this.game === game) this.game = null;
      this.saveWarning = false;
    } finally {
      this.quitting = false;
      this.busy = false;
    }
  }
  private exit = (): void => {
    this.suspend();
    this.hooks.home();
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
    shell.classList.add('stream-setup-shell');
    const main = el('section', '', 'card card-body rounded-9 stream-setup-card');
    shell.append(main);
    const heading = pageHeading(el("h1", "Chat vs Streamer", "twitch-mode-label"), action('Back', this.exit));
    main.append(heading);
    const accountStep = el('div'), playStep = el('div'), shareStep = el('div');
    accountStep.append(el('h2', 'Connect Twitch'));
    playStep.append(el('h2', 'Start new game'), el('p', 'Chat submits their guesses before the streamer plays that location. This prevents cheating from the stream.'));
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
    const updateTimerSetting = () => {
      this.timedRounds = automatic.checked;
      const value = Number(seconds.value); if (validStreamSeconds(value) && value > 0) this.roundSeconds = value;
      seconds.disabled = !this.timedRounds; manualWarning.hidden = this.timedRounds;
      try { localStorage.setItem('noitamap-guessr-round-timer', JSON.stringify({ automatic: this.timedRounds, seconds: this.roundSeconds })); } catch { /* Optional preference. */ }
    };
    automatic.onchange = seconds.onchange = updateTimerSetting; updateTimerSetting();
    playStep.append(timerRow, lengthRow, manualWarning);
    shareStep.append(el('h2', 'Share game link in chat'));
    const sharingRow = el('div', '', 'd-flex align-items-center gap-2');
    const switchBox = el('span', '', 'switch theme-primary');
    const announcements = el('input'); announcements.type = 'checkbox'; announcements.id = 'stream-share-announcements';
    announcements.setAttribute('role', 'switch'); announcements.checked = this.shareAnnouncements;
    const label = el('label', 'Share game links as announcements'); label.htmlFor = announcements.id;
    switchBox.append(announcements); sharingRow.append(switchBox, label);
    const sharingHelp = el('p', 'The link is posted three times as normal messages, or once as an announcement.', 'form-text');
    sharingHelp.id = 'stream-sharing-help'; announcements.setAttribute('aria-describedby', sharingHelp.id);
    const permissionNote = el('p', 'Sharing permission is optional. Without it, you can copy the link.', 'form-text');
    let sharingReady = false;
    const hasSharingPermission = () => this.api.local ? !!this.viewer?.canShare(this.shareAnnouncements)
      : canShareGameLink(this.setupCredentials, this.shareAnnouncements);
    const refreshSharing = () => {
      const granted = hasSharingPermission();
      enableSharing.hidden = !sharingReady || granted;
      permissionNote.hidden = !sharingReady || granted;
    };
    const enableSharing = action('Enable sharing in chat', async () => {
      if (this.busy) return;
      this.busy = true; enableSharing.disabled = true; announcements.disabled = true;
      try {
        if (this.api.local) await this.viewer!.connect({ announcements: this.shareAnnouncements });
        else await this.connectAuth();
      } catch (error) { this.hooks.toast(tr((error as Error).message)); }
      finally {
        this.busy = false; enableSharing.disabled = false; announcements.disabled = false;
        if (main.isConnected) refreshSharing();
      }
    }, 'btn btn-sm btn-outline theme-secondary');
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
        if (!this.registeredAuth) {
          auth.registerLoginPreparation("guessr", () => {
            this.save();
            return { pane: "stream" };
          });
          this.registeredAuth = true;
        }
        if (!main.isConnected) return;
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
        const credentials = await auth.getTwitchChatSession();
        if (!main.isConnected) return;
        if (!credentials || !credentials.scopes?.includes('user:write:chat')) {
          loading.remove();
          accountStep.append(
            el('p', 'Connect Twitch to receive guesses and send round updates.'),
            action("Connect Twitch", () => this.connectAuth(), "primary"),
          );
          return;
        }
        this.setupCredentials = credentials;
        sharingReady = true; refreshSharing();
        if (this.game && this.game.stage !== 'complete' && this.game.session.host.id !== credentials.userId) {
          bindText(loading, 'The saved game belongs to {{channel}}. Sign in to that channel to resume, or start a new game.', { channel: this.game.session.host.login });
          setupActions.append(action("Start new game", () => this.start(), "primary"));
          return;
        }
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
      startActions.append(
        action(
          this.api.local && !this.viewer?.getState().connected ? 'Connect Twitch' : 'Start new game',
          () => this.api.local && !this.viewer?.getState().connected ? this.connectLocalTwitch() : this.start(),
          this.game && this.game.stage !== 'complete' ? "secondary" : "primary",
        ),
      );
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
      this.hooks.toast(tr((error as Error).message));
    }
  }
  private async connectLocalTwitch(): Promise<void> {
    this.viewer ??= new TwitchViewer();
    try { await this.viewer.connect({ announcements: this.shareAnnouncements }); if (this.mounted) await this.open(false); }
    catch (error) { this.hooks.toast(tr((error as Error).message)); }
  }
  private async start(useTwitch = true): Promise<void> {
    if (this.busy) return;
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
      const session = await this.api.start(useTwitch ? 'twitch' : undefined);
      if (session.transport === 'twitch') await this.acquireHost(session.host.id);
      this.broadcast?.dispose(); this.broadcast = undefined;
      this.chat?.stop();
      this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
      this.game = newStreamGame(session);
      this.shareStatus = ''; this.sharedUntil = 0;
      this.autoShareOnConnect = useTwitch;
      this.game.shareAnnouncements = this.shareAnnouncements;
      if (session.transport === 'twitch') {
        startStreamTiming(this.game, this.timedRounds ? this.roundSeconds : 0, session.serverNow, true);
        suspendStreamTiming(this.game, streamTime(this.game));
      }
      this.roomHealthy = true;
      this.startPulse();
      this.save();
      if (this.mounted) {
        this.render();
        this.connectChat();
      }
    } catch (error) {
      this.hooks.toast(tr((error as Error).message));
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
  private transportChanged(status: TwitchChatStatus, detail: string): void {
    this.status = status; this.statusDetail = detail;
    const game = this.game;
    if (game?.timing && this.mounted) {
      if (status === 'live') {
        const needsRender = game.paused || !this.broadcast;
        this.roomHealthy = true;
        if (game.paused) resumeStreamTiming(game, streamTime(game));
        if (!this.broadcast) {
          const failed = (error: unknown) => {
            if (this.game !== game || !this.mounted) return;
            suspendStreamTiming(game, streamTime(game));
            this.roomHealthy = false;
            this.broadcast?.dispose(); this.broadcast = undefined;
            console.warn('[NoitaGuessr] Broadcast failed:', error);
            this.save(); this.render(); this.hooks.toast(tr('Twitch could not send the game update.'));
          };
          const viewer = this.viewer, receiver = this.chat;
          this.broadcast = new StreamBroadcastHost(game, this.viewerImageRoot(), text => this.api.local
            ? viewer!.sendMessage(GUESSR_TRANSPORT_CHANNEL, text) : receiver!.sendTransport(text), failed, this.save);
          void this.broadcast.start().catch(failed);
        } else this.broadcast.publishState();
        this.save(); if (needsRender) this.render(); this.startTick();
        if (this.autoShareOnConnect && game.timing.phase === 'lobby') {
          this.autoShareOnConnect = false;
          void this.shareGameLink(true);
        }
      } else if (!game.paused) {
        suspendStreamTiming(game, streamTime(game)); this.save(); this.broadcast?.publishState(); this.render();
      }
    }
    this.updateStatus();
  }
  private startTick(): void {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      const game = this.game;
      if (!game?.timing || !this.mounted) return;
      const now = streamTime(game);
      this.updateTimer();
      if (this.busy) return;
      if (document.querySelector('.stream-host-shell[data-starting]') && now >= game.timing.startsAt && !game.paused) this.render();
      const next = streamTick(game, now);
      if (next === 'warmup-finished') {
        startHostWindow(game, now); this.save(); this.broadcast?.publishState(); this.render();
      } else if (next === 'submit') void this.submit(true);
      else if (next === 'advance' || next === 'finish') void this.nextRound();
      else if (now - this.tickSavedAt >= 5000) { this.tickSavedAt = now; this.save(); }
    }, 250);
  }
  private updateTimer(): void {
    const game = this.game, timing = game?.timing;
    if (!game || !timing) return;
    const now = game.paused ? timing.suspendedAt ?? timing.lastActiveAt : streamTime(game);
    const starting = Math.max(0, Math.ceil((timing.startsAt - now) / 1000));
    const remaining = Math.max(0, Math.ceil(((timing.deadline ?? now) - now) / 1000));
    const clock = `${formatGuessrNumber(Math.floor(remaining / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(remaining % 60, { minimumIntegerDigits: 2 })}`;
    const label = game.paused ? tr('Reconnecting…') : timing.phase === 'lobby' ? tr('Not started') : starting ? tr('Starting in {{seconds}}', { seconds: formatGuessrNumber(starting) })
      : timing.deadline === null ? tr('Manual timing') : clock;
    for (const timer of document.querySelectorAll<HTMLElement>('#stream-round-timer, #stream-start-countdown'))
      if (timer.textContent !== label) timer.textContent = label;
    const next = document.getElementById('stream-auto-next');
    if (next) {
      const final = game.round === game.session.rounds.length - 1;
      const until = Math.max(final ? now : timing.deadline ?? now, timing.resultsUntil ?? now);
      const seconds = Math.max(0, Math.ceil((until - now) / 1000));
      const nextClock = `${formatGuessrNumber(Math.floor(seconds / 60), { minimumIntegerDigits: 2 })}:${formatGuessrNumber(seconds % 60, { minimumIntegerDigits: 2 })}`;
      bindText(next, () => final ? `${tr('View results')}: ${nextClock}` : tr('Next round in {{time}}', { time: nextClock }));
    }
    const first = document.getElementById('stream-first-round') as HTMLButtonElement | null;
    if (first) first.disabled = game.paused || !!starting;
    const start = document.getElementById('stream-start-game') as HTMLButtonElement | null;
    if (start) start.disabled = game.paused || !this.roomHealthy || this.sharePending;
    const activity = document.getElementById('stream-activity-message');
    if (activity) activity.style.visibility = Date.now() < this.activityUntil ? 'visible' : 'hidden';
  }
  private renderWarmup(main: HTMLElement): void {
    const section = el('section', '', 'card card-body rounded-9 stream-start-panel');
    if (this.game!.timing!.phase === 'lobby') {
      section.append(el('h2', 'Ready to start'), el('p', 'Share the game link, then start when your chat is ready.'));
      const start = action('Start game', () => {
        const game = this.game!;
        if (game.paused || !this.roomHealthy || this.sharePending) return;
        beginStreamTiming(game, streamTime(game)); this.save(); this.broadcast?.publishState(); this.render();
      }, 'primary');
      start.id = 'stream-start-game'; section.append(start); main.append(section); return;
    }
    section.classList.add('stream-warmup');
    section.append(el('h2', 'Chat goes first'), el('p', 'Chat is playing round 1.'));
    section.append(el('p', 'Your first round starts when chat finishes this round.'),
      el('p', 'Chat submits their guesses before the streamer plays that location. This prevents cheating from the stream.', 'fine-print'));
    if (!this.game!.timing!.seconds) {
      const start = action('Start first round', () => {
        const game = this.game!;
        if (game.paused || streamTime(game) < game.timing!.startsAt) return;
        startHostWindow(game, streamTime(game)); this.save(); this.broadcast?.publishState(); this.render();
      }, 'primary');
      start.id = 'stream-first-round'; section.append(start);
    }
    main.append(section);
  }
  private connectChat(): void {
    if (
      this.chat || this.stopLocalChat ||
      !this.game ||
      this.game.stage === "complete" ||
      !this.mounted
    )
      return;
    if (this.api.local) {
      if (!this.game.session.localChat) return;
      this.viewer ??= new TwitchViewer();
      this.stopLocalChat = this.viewer.watchChat(GUESSR_TRANSPORT_CHANNEL, {
        message: this.receiveChat,
        status: (status, detail) => this.transportChanged(status, detail),
      });
      return;
    }
    this.chat = new TwitchChatConnection({
      userId: this.game.session.host.id,
      broadcasterLogin: GUESSR_TRANSPORT_CHANNEL,
      credentials: async () => (await gameAuth()).getTwitchChatSession(),
      status: (status, detail) => {
        this.transportChanged(status, detail);
      },
      message: this.receiveChat,
    });
    this.chat.start();
  }
  private receiveChat = (message: StreamChatMessage): void => {
    if (!this.game || !this.roomHealthy) return;
    this.broadcast?.receiveRequest(message);
    if (acceptStreamGuess(this.game, message) === 'accepted') {
      this.recentGuesser = message.player.name;
      this.guessNoticeTimer ??= setTimeout(() => {
        this.guessNoticeTimer = undefined;
        this.activityUntil = Date.now() + 6000;
        const activity = document.getElementById('stream-activity-message');
        if (activity) { bindText(activity, '{{player}} submitted a guess', { player: this.recentGuesser }); activity.style.visibility = 'visible'; }
      }, 1000);
      const command = parseGuessCommand(message.text, { rounds: this.game.session.rounds.length, bounds: this.game.session.config.bounds });
      if (command?.nonce) void this.broadcast?.remember(command.round - 1, message.player.id, command.nonce);
      this.saveTimer ??= setTimeout(this.save, 250);
      this.updateStatus();
    }
  };
  private updateStatus(): void {
    const status = document.getElementById("stream-chat-status");
    if (status) {
      const connected = this.roomHealthy && (this.api.local && !this.game?.session.localChat || this.status === 'live');
      status.dataset.connection = connected ? 'connected' : this.status === 'reconnecting' ? 'reconnecting'
        : this.status === 'connecting' ? 'connecting' : 'disconnected';
      bindAttribute(status, 'aria-label', connected ? 'Connected' : this.status === 'reconnecting' ? 'Reconnecting…'
        : this.status === 'connecting' ? 'Connecting…' : 'Disconnected');
      this.statusHelp?.update();
    }
    const reconnect = document.getElementById('stream-reconnect') as HTMLButtonElement | null;
    if (reconnect) {
      const needsGameRecovery = !this.roomHealthy || !!this.game?.paused;
      reconnect.hidden = !needsGameRecovery && !['offline', 'auth-required', 'channel-not-found'].includes(this.status);
      if (this.api.local && !this.game?.session.localChat && !needsGameRecovery) reconnect.hidden = true;
      bindText(reconnect, this.status === 'auth-required' ? 'Authorize Twitch' : 'Reconnect');
    }
    const count = document.getElementById("stream-guess-count");
    if (count && this.game) {
      const round = this.game.timing?.chatRound ?? this.game.round;
      const total = this.game.participants.filter(p => p.id !== this.game!.session.host.id && p.guesses[round]).length;
      bindText(count, 'Guesses: {{total}}', { total: formatGuessrNumber(total) });
      const label = document.getElementById('stream-chat-round');
      if (label) bindText(label, 'Chat round {{round}}', { round: formatGuessrNumber(round + 1) });
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
    bindText(button, this.sharePending ? 'Posting…' : posted ? 'Posted in chat'
      : this.canPostGameLink() ? 'Share game link in chat' : 'Copy game link');
    const confirmation = document.getElementById('stream-share-status');
    if (confirmation) bindText(confirmation, this.sharePending ? 'Posting…' : this.shareStatus);
  }
  private canPostGameLink(): boolean {
    const announcements = this.game?.shareAnnouncements === true;
    return !this.sharingPermissionFailed && (this.api.local ? !!this.viewer?.canShare(announcements)
      : !!this.chat?.canShare(announcements));
  }
  private async shareGameLink(automatic = false): Promise<boolean> {
    const game = this.game;
    if (!game || this.sharePending || !automatic && Date.now() < this.sharedUntil) return false;
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
        if (this.game !== game || !this.mounted) return false;
        if (this.api.local) await this.viewer!.postGameLink(game.session.host.login, message, game.shareAnnouncements === true);
        else await this.chat!.postGameLink(game.session.host.id, message, game.shareAnnouncements === true);
        if (automatic) { game.initialShareCount = index + 1; this.save(); }
        if (index + 1 < posts) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      this.sharedUntil = Date.now() + 2000;
      this.shareStatus = 'Game link shared in chat.';
      return true;
    } catch (error) {
      if (error instanceof TwitchAnnouncementError && error.permissionRequired) {
        this.sharingPermissionFailed = true;
        this.shareStatus = 'Sharing permission is unavailable. You can copy the game link.';
      } else this.shareStatus = (error as Error).message;
      return false;
    } finally { this.sharePending = false; this.updateShareButton(); }
  }
  private viewerImageRoot(): string {
    return import.meta.env.VITE_GUESSR_IMAGE_ROOT || (this.api.local
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
    if (!game?.session.live || game.stage === 'complete' || !this.mounted) return;
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
    if (this.game.stage === "complete") { this.finish(); return; }
    this.busy = true;
    try {
      if (this.game.timing) {
        await this.acquireHost(this.game.session.host.id);
        this.broadcast?.dispose(); this.broadcast = undefined;
        this.chat?.stop(); this.chat = undefined;
        this.stopLocalChat?.(); this.stopLocalChat = undefined;
        // Keep recovery paused until the Twitch receiver is actually connected.
        this.game.paused = true;
      } else if (this.game.session.live) {
        const room = await this.api.pulse(this.game.session.id);
        this.updateProStatus(room);
        reconcileLiveRound(this.game, room);
        if (this.game.stage === 'guess')
          await this.api.pause(this.game.session.id, false);
      }
      if (this.game.stage === 'guess' && !this.game.timing) this.game.paused = false;
      this.game.shareAnnouncements = this.shareAnnouncements;
      this.roomHealthy = true; this.save(); this.startPulse(); this.busy = false; this.render(); this.connectChat();
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.busy = false; }
  }
  private async nextRound(): Promise<void> {
    if (!this.game || this.busy) return;
    this.busy = true;
    const game = this.game;
    try {
      if (!game.timing) await this.api.advance(game.session.id, game.session.rounds[game.round].id);
      advanceStreamRound(game); this.roomHealthy = true; this.save();
      if (game.stage !== 'complete') this.broadcast?.publishState();
      this.busy = false; this.render();
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.busy = false; }
  }
  render(review?: number): void {
    if (!this.game) {
      void this.open();
      return;
    }
    this.mounted = true;
    if (this.game.stage === "complete" && review === undefined) {
      this.finish();
      return;
    }
    const game = this.game,
      index = review ?? game.round,
      reveal = game.reveals[index];
    this.disposeHeader();
    this.proStatus = streamerProStatus({ local: this.api.local });
    this.proStatus.update({ gameId: game.session.id, hostPro: 'active', hostProVerifiedUntil: game.session.hostProVerifiedUntil });
    const main = this.hooks.shell(true);
    main.classList.add('stream-host-shell');
    const banner = el("div", "", "stream-banner stream-toolbar");
    const navigation = el('div', '', 'stream-toolbar-navigation');
    navigation.append(action('Exit game', this.exit, 'btn btn-sm btn-outline theme-secondary'));
    const phase = el('div', '', 'stream-toolbar-round');
    phase.append(el('strong', () => game.timing?.phase === 'lobby' ? tr('Ready to start') : game.timing?.phase === 'warmup'
      ? tr('Chat round {{round}}', { round: formatGuessrNumber(1) })
      : tr('Round {{value1}} / {{value2}}', { value1: formatGuessrNumber(index + 1), value2: formatGuessrNumber(game.session.rounds.length) })));
    if (game.timing) { const timer = el('span', '', 'stream-round-timer'); timer.id = 'stream-round-timer'; phase.append(timer); }
    const commands = el('div', '', 'stream-toolbar-actions');
    banner.append(navigation, phase, commands);
    const count = el("span", '', 'stream-guess-count');
    count.id = "stream-guess-count";
    const status = el("span", "", "stream-chat-state");
    status.id = "stream-chat-status";
    status.tabIndex = 0; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    this.statusHelp = hoverHelp(status, () => tr(this.api.local && !game.session.localChat ? 'Local simulated chat'
      : this.status === 'live' ? 'Receiving guesses from Twitch.' : this.statusDetail));
    const identity = el('span', '', 'stream-host-identity');
    const name = el('span', '', 'stream-name');
    name.append(el('strong', () => game.session.host.login), this.proStatus.badge); identity.append(name);
    navigation.append(status, identity);
    if (!this.api.local || game.session.localChat) {
      const share = action('Share game link in chat', () => this.shareGameLink(), 'btn btn-sm btn-outline theme-secondary stream-share-button');
      share.id = 'stream-share'; share.setAttribute('aria-live', 'polite');
      this.shareNotice = buttonNotice(share);
      commands.append(share);
    }
    const reconnect = action('Reconnect', () => {
      if (this.status === 'auth-required') return this.api.local ? this.connectLocalTwitch() : this.connectAuth();
      if (!this.roomHealthy || game.paused) return this.resume();
      this.chat?.stop(); this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined; this.connectChat();
    }, 'btn btn-sm btn-outline theme-secondary');
    reconnect.id = 'stream-reconnect'; commands.append(reconnect);
    const activity = el('div', '', 'stream-activity');
    const chatRound = el('span'); chatRound.id = 'stream-chat-round';
    const recent = el('span', '', 'stream-activity-message'); recent.id = 'stream-activity-message'; recent.setAttribute('role', 'status');
    if (Date.now() < this.activityUntil) bindText(recent, '{{player}} submitted a guess', { player: this.recentGuesser });
    const shared = el('span', this.shareStatus, 'stream-share-status'); shared.id = 'stream-share-status'; shared.setAttribute('role', 'status');
    activity.append(chatRound, count, recent, shared); main.append(banner, activity);
    this.updateStatus();
    if (game.timing && game.timing.phase !== 'play') { this.renderWarmup(main); this.updateTimer(); return; }
    if (game.timing && reveal) {
      const actions = el('div', '', 'game-actions stream-host-actions');
      const next = action(review === undefined ? index === game.session.rounds.length - 1 ? 'View results' : 'Next round' : 'Back to results',
        () => review === undefined ? this.nextRound() : this.render(), 'primary');
      if (game.timing.seconds && review === undefined) { next.id = 'stream-auto-next'; next.disabled = true; }
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
    );
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
          { compact: true },
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
        `/?m=r&x=${reveal.answer.x}&y=${reveal.answer.y}&z=850`,
        scored.score,
        scored.difficultyTier,
      );
      actions.append(
        el("p", "Your guess is blue. The location is green."),
        action(
          review !== undefined
            ? "Back to results"
            : index + 1 === game.session.rounds.length
              ? "View results"
              : "Next round",
          () => {
            if (review === undefined) void this.nextRound();
            else this.render();
          },
          "primary",
        ),
      );
      if (game.timing?.seconds && review === undefined) {
        const next = actions.querySelector<HTMLButtonElement>('button')!;
        next.id = 'stream-auto-next'; next.disabled = true;
      }
    } else if (game.stage === "closing") {
      actions.append(
        el("p", "Round closed. Chat guesses and your submission are saved."),
        action("Retry reveal", () => this.submit(), "primary"),
      );
    } else {
      const submit = action(
        "Submit guess",
        () => this.submit(),
        "primary",
      );
      submit.id = "confirm-guess";
      submit.disabled = !game.guess || !hostMayGuess(game, streamTime(game)) || !this.roomHealthy;
      actions.append(
        el(
          "p",
          game.paused
            ? "Paused: chat guesses are not being accepted."
            : game.timing?.seconds ? 'Your guess locks when submitted. Chat keeps its full timer.' : "Submitting closes chat guesses for this round.",
          "action-hint",
        ),
        submit,
      );
    }
    (main.querySelector('.game-panel--map') ?? main).append(actions);
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
      (this.game.stage === "guess" && (this.game.paused || !this.roomHealthy || !timedOut && !this.game.guess))
    )
      return;
    this.busy = true;
    try {
      closeStreamRound(this.game, this.game.guess);
      this.save();
      this.render();
      const game = this.game;
      const closed = game.timing?.windows[game.round]?.closesAt;
      const grace = closed === null || closed === undefined ? 0 : Math.max(0, closed + STREAM_DELIVERY_GRACE_MS - streamTime(game));
      if (grace) await new Promise(resolve => setTimeout(resolve, grace));
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
      if (game.timing) { game.timing.revision++; this.broadcast?.publishState(); this.broadcast?.publishReveal(game.round); }
      this.save();
      if (this.mounted) this.render();
    } catch (error) {
      this.hooks.toast(tr((error as Error).message));
    } finally {
      this.busy = false;
    }
  }
  private finish(): void {
    this.disposeHeader();
    if (!this.game) return;
    history.replaceState(null, '', guessRouteUrl('stream-result', location.href, { result: this.game.session.id }));
    clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
    clearInterval(this.tickTimer);
    if (!this.game.timing) {
      this.chat?.stop(); this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
    }
    const result = streamResult(this.game),
      main = this.hooks.shell();
    // Public result data only. A result-page refresh must not restore or pause
    // a private host session, and should still work if publication is unavailable.
    try { localStorage.setItem('noitamap-guessr-result:' + result.id, JSON.stringify(result)); } catch { /* Downloads remain available. */ }
    main.append(streamResultsView(result, undefined, this.exit));
    const rounds = el("div", "", "stream-round-links");
    result.rounds.forEach((round, i) =>
      rounds.append(
        action(
          () => tr('Review {{round}}: {{location}}', { round: formatGuessrNumber(i + 1), location: guessrGameTerm(round.name) }),
          () => this.render(i),
          "small secondary",
        ),
      ),
    );
    main.append(rounds);
    this.downloadActions(main, result);
    const publish = el("div", "", "stream-banner"),
      message = el("p");
    message.id = "stream-publish-message";
    bindText(message, this.game.published
      ? "Results published."
      : "Publishing the completed result…");
    publish.append(
      message,
      copyAction("Copy result link", () => {
        if (!this.game?.published) {
          throw new Error(tr("Publish the result first, or share the downloaded file."));
        }
        return guessRouteUrl("stream-result", location.origin, { result: result.id }).href;
      }, this.hooks.toast),
      action("Retry publishing", () => this.publish()),
    );
    main.append(publish);
    main.append(actionRow(
      action("Start another game", () => this.open(false)),
    ));
    if (!this.game.published) void this.publish();
    else this.finishBroadcast(this.game);
  }
  private finishBroadcast(game: StreamGame): void {
    const broadcast = this.broadcast;
    if (!broadcast) return;
    void broadcast.complete().finally(() => {
      if (this.game !== game || this.broadcast !== broadcast) return;
      this.broadcast = undefined; this.chat?.stop(); this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
      this.hostRelease?.(); this.hostRelease = undefined;
    });
  }
  private async publish(): Promise<void> {
    if (
      !this.game ||
      this.game.stage !== "complete" ||
      this.busy ||
      this.game.published
    )
      return;
    const game = this.game;
    this.busy = true;
    try {
      await this.api.publish({
        token: game.session.token,
        finishedAt: game.finishedAt!,
        players: streamResult(game).players,
      });
      game.published = true;
      if (game.timing) game.timing.revision++;
      this.save();
      const status = document.getElementById("stream-publish-message");
      if (status)
        bindText(status, this.api.local
          ? "Result saved to the local test server."
          : "Results published.");
    } catch (error) {
      const status = document.getElementById("stream-publish-message");
      if (status)
        bindText(status, () => tr('{{error}} Download a complete copy below, or retry later.', { error: tr((error as Error).message) }));
    } finally {
      this.busy = false;
      this.finishBroadcast(game);
    }
  }
  private downloadActions(main: HTMLElement, result: StreamResult): void {
    const actions = el("div", "", "stream-actions");
    actions.append(
      action(
        "Save results as a web page",
        () => downloadStreamResult(result, "html"),
        "primary",
      ),
    );
    const more = el('details');
    more.append(el('summary', 'More download options'),
      action('Export scores (JSON)', () => downloadStreamResult(result, 'json')),
      el('p', 'Game data for spreadsheets, scripts, or other tools.', 'fine-print'));
    main.append(actions,
      el('p', 'Open the saved web page in a browser to search and sort every player’s scores offline.', 'fine-print'),
      more);
  }
  async publicResult(id: string): Promise<void> {
    this.suspend();
    if (this.game?.session.id === id && this.game.stage === 'complete') { this.finish(); return; }
    const main = this.hooks.shell(),
      loading = el("p", "Loading results…");
    const heading = pageHeading(el('h1', 'Game results'), action('Back', this.exit));
    main.append(heading, loading);
    try {
      let cached: StreamResult | undefined;
      try {
        const raw = localStorage.getItem('noitamap-guessr-result:' + id);
        const value = raw && raw.length <= 2_000_000 ? JSON.parse(raw) as StreamResult : null;
        if (value?.schema === 1 && value.id === id && value.rounds?.length === STREAM_ROUNDS && value.players?.length
          && value.players.every(player => player.rounds?.length === STREAM_ROUNDS)) cached = value;
      } catch { /* Fall through to the published result. */ }
      const result = cached ?? await this.api.result(id);
      if (!main.isConnected) return;
      if (!cached) try { localStorage.setItem('noitamap-guessr-result:' + id, JSON.stringify(result)); } catch { /* Optional immutable result cache. */ }
      loading.remove(); heading.remove();
      main.append(streamResultsView(result, undefined, this.exit));
      this.downloadActions(main, result);
    } catch (error) {
      if (main.isConnected) bindText(loading, (error as Error).message);
    }
  }
  picker(): void {
    this.suspend();
    const url = guessRouteUrl('stream-picker', location.href);
    window.history.replaceState(null, "", url);
    const main = this.hooks.shell(true);
    this.viewer ??= new TwitchViewer();
    this.hooks.cleanupClue(mountStreamPicker(main, this.hooks.config, this.viewer, this.viewerImageRoot(), this.hooks.home));
  }
}
