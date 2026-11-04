import { StreamBroadcaster, guessReceiptKey, STREAM_RECEIPT_BATCH, type GuessRejectionReason } from './stream-wire';
import { readChatEnvelope } from './chat-envelope';
import type { StreamGame } from './stream-types';
import type { StreamChatMessage } from './stream-state';
import type { LiveRoomView } from './live-room-types';
import { encodeViewerClue } from './viewer-clue';
import { gameIdFromCode } from './routes';
import { twitchColor } from './player-color';

/** Host-owned broadcast state; no response or connection per chatter. */
export class StreamBroadcastHost {
  private publisher: StreamBroadcaster;
  private pending = new Map<number, Set<string>>();
  private rejected = new Map<number, Set<string>>();
  private rejectionReasons = new Map<string, GuessRejectionReason>();
  private receipts = new Map<number, Set<string>>();
  private sendingReceipts = new Set<string>();
  private clues = new Map<number, string>();
  private timer?: ReturnType<typeof setInterval>;
  private lastSnapshot = 0;
  private lastFullSnapshot = 0;
  private lastState = '';
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private requestedReveals = new Set<number>();
  private requests = new Map<string, number>();
  private stopped = false;
  private publisherDisposed = false;
  private completing?: Promise<void>;
  private preparations = new Set<Promise<void>>();
  constructor(private game: StreamGame, private imageRoot: string, private send: (message: string) => Promise<unknown>,
    private failed: (error: unknown) => void, private save: () => void, private joined: () => void = () => {}) {
    this.publisher = new StreamBroadcaster(game.session.id, send, failed, game.session.host.id);
    for (const [round, keys] of Object.entries(game.receipts ?? {})) this.receipts.set(Number(round), new Set(keys));
  }
  async start(): Promise<void> {
    // Recover the latest durable guesses if a reload happened before hashing a receipt.
    for (let round = 0; round < this.game.session.rounds.length; round++) {
      await Promise.all(this.game.participants.filter(p => p.id !== this.game.session.host.id && p.guesses[round]?.nonce)
        .map(p => this.remember(round, p.id, p.guesses[round]!.nonce!, false)));
    }
    if (this.stopped) return;
    this.publishState();
    this.timer = setInterval(() => this.flushReceipts(), 2000);
  }
  private clue(round: number): string {
    let clue = this.clues.get(round);
    if (!clue) {
      clue = encodeViewerClue({ source: this.game.session.rounds[round].clue, round: round + 1,
        camera: { dx: 0, dy: 0, level: 0 }, assistance: { widest: 0, travelSpent: 0 }, version: this.game.session.version },
      { imageRoot: this.imageRoot, version: this.game.session.version });
      this.clues.set(round, clue);
    }
    return clue;
  }
  snapshot(): LiveRoomView {
    const game = this.game, timing = game.timing!;
    const round = timing.chatRound ?? game.session.rounds.length - 1;
    const window = timing.windows[round];
    return { schema: 1, channel: game.session.host.login, hostId: game.session.host.id, hostPro: 'active',
      gameId: game.session.id, revision: timing.revision, phase: timing.phase === 'lobby' ? 'waiting' : game.stage === 'complete' ? 'complete' : window?.closed ? 'reveal' : 'guess',
      online: !game.paused, paused: game.paused, round: round + 1, roundId: game.session.rounds[round].id,
      clue: timing.phase === 'lobby' ? null : this.clue(round), expiresAt: game.session.expiresAt,
      ...(game.published ? { resultId: game.session.id } : {}),
      timing: { phase: timing.phase, startsAt: window?.opensAt ?? timing.startsAt,
        deadline: timing.chatRound === null ? null : window?.closesAt ?? timing.deadline,
        chatRound: timing.chatRound === null ? null : timing.chatRound + 1,
        hostRound: game.round + 1, seconds: timing.seconds,
        ...(timing.early ? { early: true } : {}),
        revealed: game.reveals.reduce((mask, reveal, i) => reveal ? mask | 1 << i : mask, 0) } };
  }
  publishState(full = true, resync = false): void {
    if (this.stopped) return;
    const state = this.snapshot(); if (!full) state.clue = null;
    const signature = JSON.stringify(state);
    if (!resync && signature === this.lastState) return;
    this.lastState = signature;
    this.lastSnapshot = Date.now();
    if (full) { this.lastFullSnapshot = this.lastSnapshot; clearTimeout(this.resyncTimer); this.resyncTimer = undefined; }
    this.prepare(this.publisher.offer('state', { type: 'state', state, ...(resync ? { event: 'sync' as const } : {}) }, 0));
  }
  publishReveal(round: number): void {
    const reveal = this.game.reveals[round];
    if (this.stopped || !reveal || this.publisher.has(`reveal-${round}`)) return;
    this.prepare(this.publisher.offer(`reveal-${round}`, { type: 'reveal', round, reveal }, 1));
  }
  private prepare(job: Promise<void>): void {
    this.preparations.add(job);
    void job.catch(this.failed).finally(() => this.preparations.delete(job));
  }
  async remember(round: number, userId: string, nonce: string, enqueue = true): Promise<void> {
    const key = await guessReceiptKey(this.game.session.rounds[round].id, userId, nonce);
    if (this.stopped) return;
    const receipts = this.receipts.get(round) ?? new Set<string>();
    if (!receipts.has(key)) {
      receipts.add(key);
      this.game.receipts ??= {}; (this.game.receipts[round] ??= []).push(key);
    }
    this.receipts.set(round, receipts);
    if (enqueue) { const pending = this.pending.get(round) ?? new Set<string>(); pending.add(key); this.pending.set(round, pending); }
  }
  async reject(round: number, userId: string, nonce: string, reason: GuessRejectionReason): Promise<void> {
    const key = await guessReceiptKey(this.game.session.rounds[round].id, userId, nonce);
    if (this.stopped || this.completing) return;
    const queue = this.rejected.get(round) ?? new Set<string>();
    if (queue.size >= 4096) return;
    queue.add(key); this.rejected.set(round, queue); this.rejectionReasons.set(key, reason);
  }
  private flushReceipts(): void {
    if (![...this.pending.values(), ...this.rejected.values()].some(set => set.size)) return;
    this.save();
    for (const [queue, rejected] of [[this.pending, false], [this.rejected, true]] as const)
      for (const [round, pending] of queue) {
        const queueKey = `receipts-${round}-${rejected}`;
        if (!pending.size || this.sendingReceipts.has(queueKey)) continue;
        const reason = rejected ? this.rejectionReasons.get(pending.values().next().value!) ?? 'unreceived' : undefined;
        const keys = [...pending].filter(key => !rejected || (this.rejectionReasons.get(key) ?? 'unreceived') === reason).slice(0, STREAM_RECEIPT_BATCH);
        this.sendingReceipts.add(queueKey);
        this.prepare(this.publisher.offer(queueKey, { type: 'receipts', round, keys, ...(rejected ? { rejected, reason } : {}) }, 2, () => {
          keys.forEach(key => { pending.delete(key); this.rejectionReasons.delete(key); }); this.sendingReceipts.delete(queueKey);
        }, () => { keys.forEach(key => pending.delete(key)); this.sendingReceipts.delete(queueKey); })
          .catch(error => { keys.forEach(key => pending.delete(key)); this.sendingReceipts.delete(queueKey); throw error; }));
      }
  }
  receiveRequest(message: StreamChatMessage): void {
    if (this.stopped || this.completing || typeof message.text !== 'string' || message.text.length > 500) return;
    const hidden = readChatEnvelope(message.text);
    let text = hidden?.[0] === 78 && hidden[1] === 71 && hidden[2] === 82 ? new TextDecoder().decode(hidden.subarray(3)) : message.text;
    const request = /^(?:NoitaGuessr|NG) ([0-9a-z]{26}|-) player-(?:join|sync) ([a-z0-9_]{1,25}) need=([0-9a-f]{1,3})(?: receipts=(.+))?$/.exec(text);
    if (request) text = `!noitaguessr_sync ${request[2]} ${request[1]} ${request[3]}${request[4] ? ' ' + request[4] : ''}`;
    const match = /^!noitaguessr_sync ([a-z0-9_]{1,25}) ([0-9a-z]{26}|-) ([0-9a-f]{1,3})(?: ([0-9]:[0-9a-f]{16}(?:,[0-9]:[0-9a-f]{16}){0,9}))?$/.exec(text);
    if (!match || match[1] !== this.game.session.host.login || match[2] !== '-' && gameIdFromCode(match[2]) !== this.game.session.id) return;
    if (message.player.id !== this.game.session.host.id) {
      this.game.joinedPlayers ??= {};
      if (!this.game.joinedPlayers[message.player.id] && !this.game.joinedOverflow && Object.keys(this.game.joinedPlayers).length < 3000) {
        this.game.joinedPlayers[message.player.id] = { login: message.player.login, name: message.player.name,
          ...(twitchColor(message.player.color) ? { color: twitchColor(message.player.color) } : {}) };
        this.joined();
      } else if (!this.game.joinedPlayers[message.player.id] && !this.game.joinedOverflow) {
        this.game.joinedOverflow = true; this.joined();
      } else if (this.game.joinedPlayers[message.player.id]) {
        const player = this.game.joinedPlayers[message.player.id], color = twitchColor(message.player.color);
        if (player.name !== message.player.name || color && color !== player.color) {
          player.name = message.player.name;
          if (color) player.color = color;
          this.joined();
        }
      }
    }
    const now = Date.now(), previous = this.requests.get(message.player.id) ?? 0;
    if (now - previous < 5000) return;
    if (this.requests.size >= 3000) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(message.player.id, now);
    // A join/refresh storm still produces one shared snapshot at most every 5s.
    // A viewer joining halfway through a packet needs a complete following
    // snapshot. The broadcaster finishes the in-flight packet before this one.
    if (Date.now() - this.lastFullSnapshot >= 5000) this.publishState(true, true);
    else if (!this.resyncTimer) this.resyncTimer = setTimeout(() => this.publishState(true, true), this.lastFullSnapshot + 5000 - Date.now());
    const missing = parseInt(match[3], 16);
    const participant = missing ? this.game.participants.find(p => p.id === message.player.id) : undefined;
    for (let round = 0; round < this.game.reveals.length; round++) if (missing & 1 << round) {
      if (!participant?.guesses[round] || this.requestedReveals.has(round)) continue;
      this.requestedReveals.add(round); this.publishReveal(round);
      setTimeout(() => this.requestedReveals.delete(round), 15_000);
    }
    for (const entry of match[4]?.split(',') ?? []) {
      const round = Number(entry[0]), key = entry.slice(2);
      if (this.receipts.get(round)?.has(key)) {
        const pending = this.pending.get(round) ?? new Set<string>();
        if (pending.size < 4096) pending.add(key); this.pending.set(round, pending);
      } else {
        const window = this.game.timing!.windows[round];
        if (window?.closed && window.closesAt !== null && message.sentAt > window.closesAt + 5000) {
          const keys = this.rejected.get(round) ?? new Set<string>(); if (keys.size < 4096) keys.add(key); this.rejected.set(round, keys);
        }
      }
    }
    // The fixed batch timer handles both receipt kinds; requests never cause a
    // per-chatter send or synchronous serialization of the whole host roster.
  }
  dispose(): void { this.stopped = true; clearInterval(this.timer); clearTimeout(this.resyncTimer); this.publisher.dispose(); this.publisherDisposed = true; }
  /** Send the final bounded queue once, then stop. No post-game heartbeat or resync replies. */
  complete(): Promise<void> {
    if (this.completing) return this.completing;
    clearInterval(this.timer); clearTimeout(this.resyncTimer);
    this.publishState();
    this.completing = (async () => {
      do {
        this.flushReceipts();
        await Promise.allSettled([...this.preparations]);
        await this.publisher.drain();
      } while (!this.stopped && [...this.pending.values(), ...this.rejected.values()].some(set => set.size));
      this.dispose();
    })();
    return this.completing;
  }
  /** Best-effort shared closure, without a per-viewer request or a durable write. */
  close(quit = false): Promise<void> {
    if (this.publisherDisposed) {
      this.publisher = new StreamBroadcaster(this.game.session.id, this.send, this.failed, this.game.session.host.id);
      this.publisherDisposed = false;
    }
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.resyncTimer);
    this.game.timing!.revision++;
    const state = this.snapshot();
    state.online = false; state.paused = true; state.clue = null;
    if (quit) { state.phase = 'waiting'; state.ended = true; }
    return new Promise((resolve, reject) => {
      const done = (error?: unknown) => { clearTimeout(timeout); this.dispose(); if (quit && error) reject(error); else resolve(); };
      const failed = () => done(Error('Twitch could not send the game update.'));
      const timeout = setTimeout(failed, 35_000);
      void this.publisher.offer('termination', { type: 'state', state }, -1, () => done(), failed).catch(done);
    });
  }
}
