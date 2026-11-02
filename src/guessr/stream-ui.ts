import "./stream.css";
import { gameAuth } from "./api";
import { attachClueControls } from "./clue-view";
import { ClueViewport } from "./clue-viewport";
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
import { TwitchChatConnection, type TwitchChatStatus } from "./twitch-chat";
import { TwitchViewer } from "./twitch-viewer";
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
  constructor(private hooks: StreamUIHooks) {
    const pane = readGuessRoute(new URL(location.href)).pane;
    // A chatter tab may share browser storage with the host. It must never
    // restore, save or pause that private host session.
    if (pane === 'stream-picker' || pane === 'stream-result') return;
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
    this.proStatus?.dispose(); this.proStatus = undefined;
    const wasHosting = this.mounted;
    this.mounted = false;
    clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    this.chat?.stop();
    this.chat = undefined;
    this.stopLocalChat?.(); this.stopLocalChat = undefined;
    if (wasHosting && this.game?.stage === "guess") {
      this.game.paused = true;
      if (this.game.session.live)
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
      this.proStatus?.dispose(); this.proStatus = undefined;
      clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
      clearTimeout(this.saveTimer); this.saveTimer = undefined;
      this.chat?.stop(); this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
      if (game.session.live) await this.api.quit(game.session.id);
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
    this.proStatus?.dispose(); this.proStatus = undefined;
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
    playStep.append(el('h2', 'Start new game'), el('p', 'Choose locations with your chat. Your own submission closes each round. There is no countdown.'));
    shareStep.append(el('h2', 'Copy game link'), el('p', () => tr('Start a game, then click “{{copyLink}}” and paste the link into Twitch chat. Viewers use the same NoitaGuessr link for every round.', { copyLink: tr('Copy game link') })));
    main.append(instructionSteps(accountStep, playStep, shareStep));
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
        if (!credentials) {
          bindText(loading, "Connect your Twitch channel so this browser can receive your chat’s guesses.");
          accountStep.append(
            action("Connect Twitch chat", () => this.connectAuth(), "primary"),
          );
          return;
        }
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
      await (await gameAuth()).connectTwitchChat();
    } catch (error) {
      this.hooks.toast(tr((error as Error).message));
    }
  }
  private async connectLocalTwitch(): Promise<void> {
    this.viewer ??= new TwitchViewer();
    try { await this.viewer.connect(); if (this.mounted) await this.open(false); }
    catch (error) { this.hooks.toast(tr((error as Error).message)); }
  }
  private async start(useTwitch = true): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.api.local) {
        const identity = this.viewer?.getState();
        if (useTwitch && (!identity?.connected || !identity.login)) throw new Error(tr('Connect Twitch before starting a live test.'));
        this.api.setLocalChannel(useTwitch ? identity!.login! : undefined);
      }
      const session = await this.api.start();
      this.chat?.stop();
      this.chat = undefined;
      this.stopLocalChat?.(); this.stopLocalChat = undefined;
      this.game = newStreamGame(session);
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
      this.stopLocalChat = this.viewer.watchChat(this.game.session.host.login, {
        message: this.receiveChat,
        status: (status, detail) => { this.status = status; this.statusDetail = detail; this.updateStatus(); },
      });
      return;
    }
    this.chat = new TwitchChatConnection({
      userId: this.game.session.host.id,
      credentials: async () => (await gameAuth()).getTwitchChatSession(),
      status: (status, detail) => {
        this.status = status;
        this.statusDetail = detail;
        this.updateStatus();
      },
      message: this.receiveChat,
    });
    this.chat.start();
  }
  private receiveChat = (message: StreamChatMessage): void => {
    if (!this.game || !this.roomHealthy) return;
    if (acceptStreamGuess(this.game, message) === 'accepted') {
      this.saveTimer ??= setTimeout(this.save, 250);
      this.updateStatus();
    }
  };
  private updateStatus(): void {
    const status = document.getElementById("stream-chat-status");
    if (status) {
      bindText(status, () => tr(this.api.local && !this.game?.session.localChat
        ? "Local simulated chat"
        : this.statusDetail));
      status.dataset.status = this.status;
    }
    const count = document.getElementById("stream-guess-count");
    if (count && this.game) {
      const total = this.game.participants.filter(p => p.id !== this.game!.session.host.id && p.guesses[this.game!.round]).length;
      bindText(count, () => tr('{{total}} chat guesses this round', { count: total, total: formatGuessrNumber(total) }));
    }
  }
  private viewerImageRoot(): string {
    return import.meta.env.VITE_GUESSR_IMAGE_ROOT || (this.api.local
      ? '/guessr-images/images'
      : 'https://guessr-tiles.sage-data.xyz/images');
  }
  private pickerUrl(): string {
    const url = guessRouteUrl("stream-picker", location.origin);
    if (!this.game) return url.href;
    return liveRoomLink(location.origin, this.game.session.host.login);
  }
  private updateProStatus(room: LiveRoomView): void {
    if (!this.game) return;
    this.game.session.hostProVerifiedUntil = room.hostPro === 'active' ? room.hostProVerifiedUntil : undefined;
    this.proStatus?.update(room);
  }
  private startPulse(): void {
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
      if (this.game.session.live) {
        const room = await this.api.pulse(this.game.session.id);
        this.updateProStatus(room);
        reconcileLiveRound(this.game, room);
        if (this.game.stage === 'guess')
          await this.api.pause(this.game.session.id, false);
      }
      if (this.game.stage === 'guess') this.game.paused = false;
      this.roomHealthy = true; this.save(); this.startPulse(); this.busy = false; this.render(); this.connectChat();
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.busy = false; }
  }
  private async togglePause(): Promise<void> {
    if (!this.game || this.busy) return;
    this.busy = true;
    const game = this.game, wasPaused = game.paused;
    // Stop accepting locally immediately; resume only after the room acknowledges.
    game.paused = true;
    try {
      await this.api.pause(game.session.id, !wasPaused);
      game.paused = !wasPaused; this.roomHealthy = true;
    } catch (error) { this.hooks.toast(tr((error as Error).message)); }
    finally { this.save(); this.busy = false; this.render(); }
  }
  private async nextRound(): Promise<void> {
    if (!this.game || this.busy) return;
    this.busy = true;
    const game = this.game;
    try {
      await this.api.advance(game.session.id, game.session.rounds[game.round].id);
      advanceStreamRound(game); this.roomHealthy = true; this.save();
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
    this.proStatus?.dispose();
    this.proStatus = streamerProStatus({ local: this.api.local });
    this.proStatus.update({ gameId: game.session.id, hostPro: 'active', hostProVerifiedUntil: game.session.hostProVerifiedUntil });
    const main = this.hooks.shell(true);
    main.append(
      this.hooks.hud({
        label: "Chat vs Streamer",
        twitch: true,
        badge: "pro",
        round: index + 1,
        total: game.session.rounds.length,
        score: 0,
        exit: this.exit,
      }),
    );
    const banner = el("div", "", "stream-banner"),
      details = el("p");
    const count = el("strong");
    count.id = "stream-guess-count";
    const status = el("span", "", "stream-status");
    status.id = "stream-chat-status";
    const identity = el('span', '', 'stream-host-identity');
    identity.append(el('strong', () => game.session.host.login), this.proStatus.badge);
    details.append(identity, count, status);
    banner.append(
      details,
      copyAction("Copy game link", () => this.pickerUrl(), this.hooks.toast),
    );
    if (!this.api.local || game.session.localChat)
      banner.append(
        action("Reconnect chat", () => {
          this.chat?.stop();
          this.chat = undefined;
          this.stopLocalChat?.(); this.stopLocalChat = undefined;
          this.connectChat();
        }),
        action("Connect Twitch", () => this.api.local ? this.connectLocalTwitch() : this.connectAuth()),
      );
    main.append(banner);
    if (!this.roomHealthy)
      banner.append(action("Reconnect live room", () => this.resume(), "primary"));
    this.updateStatus();
    const host = game.participants.find((p) => p.id === game.session.host.id)!;
    const submitted = host.guesses[index];
    const { clue, bar } = this.hooks.panels(
      main,
      reveal ? (submitted?.point ?? null) : game.guess,
      !!reveal || game.stage !== "guess" || game.paused || !this.roomHealthy,
      (point) => {
        if (game.stage === "guess" && !game.paused && this.roomHealthy) {
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
        ),
      );
    clue.classList.toggle("paused", game.paused && !reveal);
    if (!reveal && game.stage === "guess")
      bar.append(
        action(
          game.paused ? "Resume" : "Pause",
          () => this.togglePause(),
          "small",
        ),
      );
    const actions = el("div", "", "game-actions");
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
    } else if (game.stage === "closing") {
      actions.append(
        el("p", "Round closed. Chat guesses and your submission are saved."),
        action("Retry reveal", () => this.submit(false), "primary"),
      );
    } else {
      const submit = action(
        "Submit guess",
        () => this.submit(false),
        "primary",
      );
      submit.id = "confirm-guess";
      submit.disabled = !game.guess || game.paused || !this.roomHealthy;
      const skip = action("Skip round", () => this.submit(true));
      bindAttribute(skip, "title", "Close this round and score zero for your own guess");
      skip.disabled = game.paused || !this.roomHealthy;
      actions.append(
        skip,
        el(
          "p",
          game.paused
            ? "Paused: chat guesses are not being accepted."
            : "Submitting closes chat guesses for this round.",
          "action-hint",
        ),
        submit,
      );
    }
    main.append(actions);
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
        text: parsed ? formatGuessCommand(parsed.round, parsed, parsed.maximum, parsed.roundId ?? this.game!.session.rounds[this.game!.round].id) : command.value,
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
  private async submit(skip: boolean): Promise<void> {
    if (
      !this.game ||
      this.busy ||
      (this.game.stage === "guess" && !skip && !this.game.guess)
    )
      return;
    this.busy = true;
    try {
      closeStreamRound(this.game, skip ? null : this.game.guess);
      this.save();
      this.render();
      const game = this.game;
      const reveal = await this.api.reveal(
        game.session.rounds[game.round].token,
        game.participants.map(player => ({
          player: { id: player.id, login: player.login, name: player.name },
          guess: player.guesses[game.round]?.point ?? null,
          maximum: player.guesses[game.round]?.maximum ?? 5000,
        })),
      );
      revealStreamRound(game, reveal);
      this.save();
      if (this.mounted) this.render();
    } catch (error) {
      this.hooks.toast(tr((error as Error).message));
    } finally {
      this.busy = false;
    }
  }
  private finish(): void {
    this.proStatus?.dispose(); this.proStatus = undefined;
    if (!this.game) return;
    clearTimeout(this.pulseTimer); this.pulseTimer = undefined;
    this.chat?.stop();
    this.chat = undefined;
    this.stopLocalChat?.(); this.stopLocalChat = undefined;
    const result = streamResult(this.game),
      main = this.hooks.shell();
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
    const main = this.hooks.shell(),
      loading = el("p", "Loading results…");
    const heading = pageHeading(el('h1', 'Game results'), action('Back', this.exit));
    main.append(heading, loading);
    try {
      const result = await this.api.result(id);
      if (!main.isConnected) return;
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
    this.hooks.cleanupClue(mountStreamPicker(main, this.hooks.config, this.viewer, this.viewerImageRoot()));
  }
}
