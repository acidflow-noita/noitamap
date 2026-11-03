import { StreamBroadcaster, guessReceiptKey } from './stream-wire';
import type { StreamGame } from './stream-types';
import type { StreamChatMessage } from './stream-state';
import type { LiveRoomView } from './live-room-types';
import { encodeViewerClue } from './viewer-clue';
import { gameCode } from './routes';

/** Host-owned broadcast state; no response or connection per chatter. */
export class StreamBroadcastHost {
  private publisher: StreamBroadcaster;
  private pending = new Map<number, Set<string>>();
  private rejected = new Map<number, Set<string>>();
  private receipts = new Map<number, Set<string>>();
  private sendingReceipts = new Set<string>();
  private clues = new Map<number, string>();
  private timer?: ReturnType<typeof setInterval>;
  private lastSnapshot = 0;
  private lastFullSnapshot = 0;
  private resyncTimer?: ReturnType<typeof setTimeout>;
  private requestedReveals = new Set<number>();
  private requests = new Map<string, number>();
  private stopped = false;
  constructor(private game: StreamGame, private imageRoot: string, send: (message: string) => Promise<unknown>,
    private failed: (error: unknown) => void, private save: () => void) {
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
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSnapshot >= 15_000) this.publishState(false);
      this.flushReceipts();
    }, 2000);
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
      gameId: game.session.id, revision: timing.revision, phase: game.stage === 'complete' ? 'complete' : window?.closed ? 'reveal' : 'guess',
      online: !game.paused, paused: game.paused, round: round + 1, roundId: game.session.rounds[round].id,
      clue: this.clue(round), expiresAt: game.session.expiresAt,
      ...(game.published ? { resultId: game.session.id } : {}),
      timing: { phase: timing.phase, startsAt: timing.startsAt, deadline: timing.deadline,
        hostRound: game.round + 1, seconds: timing.seconds,
        revealed: game.reveals.reduce((mask, reveal, i) => reveal ? mask | 1 << i : mask, 0) } };
  }
  publishState(full = true): void {
    if (this.stopped) return;
    this.lastSnapshot = Date.now();
    if (full) { this.lastFullSnapshot = this.lastSnapshot; clearTimeout(this.resyncTimer); this.resyncTimer = undefined; }
    const state = this.snapshot(); if (!full) state.clue = null;
    void this.publisher.offer('state', { type: 'state', state }, 0).catch(this.failed);
  }
  publishReveal(round: number): void {
    const reveal = this.game.reveals[round];
    if (this.stopped || !reveal || this.publisher.has(`reveal-${round}`)) return;
    void this.publisher.offer(`reveal-${round}`, { type: 'reveal', round, reveal }, 1).catch(this.failed);
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
  private flushReceipts(): void {
    if (![...this.pending.values(), ...this.rejected.values()].some(set => set.size)) return;
    this.save();
    for (const [queue, rejected] of [[this.pending, false], [this.rejected, true]] as const)
      for (const [round, pending] of queue) {
        const queueKey = `receipts-${round}-${rejected}`;
        if (!pending.size || this.sendingReceipts.has(queueKey)) continue;
        const keys = [...pending].slice(0, 35); this.sendingReceipts.add(queueKey);
        void this.publisher.offer(queueKey, { type: 'receipts', round, keys, ...(rejected ? { rejected } : {}) }, 2, () => {
          keys.forEach(key => pending.delete(key)); this.sendingReceipts.delete(queueKey);
        }, () => this.sendingReceipts.delete(queueKey)).catch(error => { this.sendingReceipts.delete(queueKey); this.failed(error); });
      }
  }
  receiveRequest(message: StreamChatMessage): void {
    if (this.stopped || typeof message.text !== 'string' || message.text.length > 500) return;
    const match = /^!noitaguessr_sync ([a-z0-9_]{1,25}) ([0-9a-z]{26}|-) ([0-9a-f]{1,3})(?: ([0-9]:[0-9a-f]{16}(?:,[0-9]:[0-9a-f]{16}){0,9}))?$/.exec(message.text);
    if (!match || match[1] !== this.game.session.host.login || match[2] !== '-' && match[2] !== gameCode(this.game.session.id)) return;
    const now = Date.now(), previous = this.requests.get(message.player.id) ?? 0;
    if (now - previous < 5000) return;
    if (this.requests.size >= 3000) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(message.player.id, now);
    // A join/refresh storm still produces one shared snapshot at most every 5s.
    if (Date.now() - this.lastFullSnapshot >= 5000) this.publishState();
    else if (!this.resyncTimer) this.resyncTimer = setTimeout(() => this.publishState(), this.lastFullSnapshot + 5000 - Date.now());
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
  dispose(): void { this.stopped = true; clearInterval(this.timer); clearTimeout(this.resyncTimer); this.publisher.dispose(); }
  /** Best-effort shared closure, without a per-viewer request or a durable write. */
  close(quit = false): Promise<void> {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.resyncTimer);
    this.game.timing!.revision++;
    const state = this.snapshot();
    state.online = false; state.paused = true; state.clue = null;
    if (quit) state.phase = 'waiting';
    return new Promise(resolve => {
      const done = () => { clearTimeout(timeout); this.dispose(); resolve(); };
      const timeout = setTimeout(done, 10_000);
      void this.publisher.offer('state', { type: 'state', state }, 0, done, done).catch(done);
    });
  }
}
