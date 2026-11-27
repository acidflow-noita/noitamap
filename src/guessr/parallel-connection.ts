import { localizedError } from './messages';
import { gameFetch, acceptStartAvailability } from './quota-state';
import type { ParallelAuthorization, ParallelClientMessage, ParallelServerMessage, ParallelSubmission } from './parallel-types';
import type { RoomConnection } from './live-room-types';
import { connectionDiagnostic } from './connection-diagnostics';
import { GAME_PROTOCOL } from './game-protocol';
import { GAME_UNAVAILABLE_MESSAGE } from './stream-lifetime';
import { ClueReplayOutbox } from './clue-replay-outbox';
import type { ClueReplay, ReplayLoader } from './clue-replay';
import type { Camera } from './clue-camera';

type Command = Extract<ParallelClientMessage, { id: string }>;
function authorizationCloseCode(error: unknown): number {
  const value = error as { code?: string; status?: number } | null;
  return value?.status === 401 || value?.status === 403
    || ['expired', 'validation', 'disconnected'].includes(value?.code ?? '') ? 4001 : 1013;
}
export class ParallelConnection {
  private socket?: WebSocket;
  private closed = false;
  private ready = false;
  private failures = 0;
  private authFailures = 0;
  private completed = false;
  private unavailable = false;
  private checkedAvailabilityAt = -Infinity;
  private availabilityRequest?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongDeadline?: ReturnType<typeof setTimeout>;
  private refreshAuth?: ReturnType<typeof setTimeout>;
  private probe?: () => void;
  private outbox = new Map<string, ParallelSubmission>();
  private revisions = new Map<string, number>();
  private commands = new Map<string, { message: Command; resolve(): void; reject(error: Error): void }>();
  private hostPending?: Extract<Command, { type: 'host-guess' }>;
  private replayEnabled = false;
  private replayOutbox: ClueReplayOutbox;
  private replayReads = new Map<string, { finish(value: ClueReplay | null): void; fail(): void }>();
  private flushReplay = () => { if (this.replayEnabled) this.replayOutbox.flush(); };
  private offset = 0;
  private status: RoomConnection = 'connecting';
  private storageKey: string;
  private online = () => { if (!this.closed && !this.ready) this.connect(); };
  private visibility = () => {
    clearTimeout(this.pongDeadline);
    if (document.visibilityState === 'hidden') this.flushReplay();
    if (document.visibilityState === 'visible' && this.ready) this.probe?.();
  };
  constructor(private origin: string, readonly gameId: string, readonly identity: string,
    private authorize: () => Promise<ParallelAuthorization>,
    private events: { message(value: ParallelServerMessage): void; status(value: RoomConnection, detail: string): void }) {
    this.storageKey = `noitaguessr-socket-v${GAME_PROTOCOL}:${gameId}:${identity}`;
    this.replayOutbox = new ClueReplayOutbox(this.storageKey + ':clues', m => this.send(m));
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey + ':pending') ?? '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(-10)) if (item?.roundId && /^[a-f0-9]{16}$/.test(item.nonce)
        && Number.isSafeInteger(item.revision) && item.revision > 0 && item.revision <= 0xffffffff) {
        this.outbox.set(item.roundId, item); this.revisions.set(item.roundId, item.revision);
      }
    } catch { /* Pending sends are optional recovery data, never credentials. */ }
    if (identity.startsWith('host:')) try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey + ':host-guess') ?? 'null');
      if (saved?.type === 'host-guess' && /^[a-f0-9]{16}$/.test(saved.id) && /^[a-f0-9-]{36}$/.test(saved.roundId)
        && Number.isInteger(saved.maximum) && saved.maximum >= 0 && saved.maximum <= 5000
        && (saved.point === null || Number.isFinite(saved.point?.x) && Number.isFinite(saved.point?.y))) this.hostPending = saved;
    } catch {}
    window.addEventListener('online', this.online);
    window.addEventListener('pagehide', this.flushReplay);
    document.addEventListener('visibilitychange', this.visibility);
    this.connect();
  }
  now(): number { return Date.now() + this.offset; }
  connected(): boolean { return this.ready; }
  state(): RoomConnection { return this.status; }
  recordCamera(roundId: string, camera: Camera, action?: import('./clue-replay').CameraAction): void {
    if (this.replayEnabled && !this.closed && !this.completed) this.replayOutbox.record(roundId, camera, this.now(), action);
  }
  readReplay: ReplayLoader = (round, player, signal) => {
    if (!this.replayEnabled) return Promise.resolve(null);
    if (!this.connected() || signal.aborted) return Promise.reject(Error('Connection unavailable. Reconnecting…'));
    const request = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', fail); this.replayReads.delete(request); };
      const fail = () => { cleanup(); reject(Error('Connection unavailable. Reconnecting…')); };
      const timer = setTimeout(fail, 10000);
      this.replayReads.set(request, { finish: value => { cleanup(); resolve(value); }, fail });
      signal.addEventListener('abort', fail, { once: true });
      if (!this.send({ type: 'clue-read', request, round, player })) fail();
    });
  };
  private update(status: RoomConnection, detail = '') { this.status = status; this.events.status(status, detail); }
  private persist(): void {
    try { localStorage.setItem(this.storageKey + ':pending', JSON.stringify([...this.outbox.values()])); } catch {}
  }
  private send(message: ParallelClientMessage): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  submit(submission: ParallelSubmission): void {
    if ((this.outbox.get(submission.roundId)?.revision ?? 0) > submission.revision) return;
    this.flushReplay();
    this.revisions.set(submission.roundId, Math.max(submission.revision, this.revisions.get(submission.roundId) ?? 0));
    this.outbox.set(submission.roundId, submission); this.persist();
    this.send({ type: 'guess', submission });
  }
  nextRevision(roundId: string): number {
    const next = (this.revisions.get(roundId) ?? 0) + 1; this.revisions.set(roundId, next); return next;
  }
  recover(): void { this.send({ type: 'recover' }); }
  command(message: Command): Promise<void> {
    if (this.unavailable) return Promise.reject(Error(GAME_UNAVAILABLE_MESSAGE));
    if (message.type === 'host-guess' || message.type === 'quit' || message.type === 'advance') this.flushReplay();
    if (message.type === 'host-guess') {
      this.hostPending = message;
      try { localStorage.setItem(this.storageKey + ':host-guess', JSON.stringify(message)); } catch {}
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.commands.delete(message.id); reject(Error('Connection unavailable. Reconnecting…')); }, 30000);
      this.commands.set(message.id, { message, resolve: () => { clearTimeout(timeout); resolve(); }, reject: e => { clearTimeout(timeout); reject(e); } });
      this.send(message);
    });
  }
  private connect(): void {
    if (this.closed || this.unavailable) return;
    clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
    const old = this.socket; this.socket = undefined; old?.close(); this.ready = false;
    if (navigator.onLine === false) { this.update('offline', 'Network issues'); return; }
    this.update(this.failures ? 'retrying' : 'connecting', this.failures ? 'Reconnecting…' : 'Connecting…');
    const url = new URL(`/api/streams/live/${this.gameId}/socket`, this.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    const current = () => !this.closed && this.socket === socket;
    this.timer = setTimeout(() => { if (current() && !this.ready) socket.close(); }, 25000);
    socket.onopen = () => {
      void (async () => {
        let resume: { ticket: string; expiresAt: number } | null = null;
        try { resume = JSON.parse(sessionStorage.getItem(this.storageKey) ?? 'null'); } catch {}
        const authorization = resume && resume.expiresAt > Date.now() + 60000 ? { role: 'resume' as const, ticket: resume.ticket } : await this.authorize();
        if (current()) socket.send(JSON.stringify({ type: 'authorize', protocol: GAME_PROTOCOL, ...authorization }));
      })().catch(error => { if (current()) socket.close(authorizationCloseCode(error), 'Authorization unavailable'); });
    };
    socket.onmessage = event => {
      if (!current() || typeof event.data !== 'string') return;
      clearTimeout(this.pongDeadline);
      if (event.data === 'pong') return;
      if (event.data.length > 3 * 1024 * 1024) { socket.close(1009); return; }
      let message: ParallelServerMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      if ('now' in message && Number.isFinite(message.now)) this.offset = message.now - Date.now();
      if (message.type === 'error' && message.code === 'play-capacity') {
        if (message.scope !== 'game-size') acceptStartAvailability(message.scope,message.resetAt);
        this.unavailable = true;
        this.update('stopped',localizedError(Object.assign(new Error(message.message),{resetAt:message.resetAt})));
        socket.close(4003,'New players paused'); return;
      }
      if (message.type === 'error' && message.code === 'capacity') {
        this.update('stopped', message.message); socket.close(4003, 'Invitation unavailable'); return;
      }
      if (message.type === 'published') {
        this.replayOutbox.clear();
        this.completed = true; clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
      }
      if (message.type === 'authorized') {
        for (const [round, revision] of Object.entries(message.acceptedRevisions ?? {}))
          this.revisions.set(round, Math.max(revision, this.revisions.get(round) ?? 0));
        connectionDiagnostic({ event: 'connected', transport: 'coordinator', code: this.ready ? 'reauthorized' : 'authorized' });
        clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.refreshAuth);
        this.ready = true; this.failures = 0; this.authFailures = 0;
        this.replayEnabled = message.clueReplays === true;
        if (this.replayEnabled) this.replayOutbox.reconnect();
        try { sessionStorage.setItem(this.storageKey, JSON.stringify({ ticket: message.ticket, expiresAt: message.expiresAt })); } catch {}
        this.update('connected');
        for (const submission of this.outbox.values()) this.send({ type: 'guess', submission });
        for (const command of this.commands.values()) this.send(command.message);
        if (this.hostPending && !this.commands.has(this.hostPending.id)) this.send(this.hostPending);
        this.probe = () => {
          if (!current() || document.visibilityState === 'hidden') return;
          socket.send('ping');
          clearTimeout(this.pongDeadline);
          const expected = performance.now() + 5000;
          this.pongDeadline = setTimeout(() => {
            if (!current() || document.visibilityState === 'hidden') return;
            // Background throttling or a blocked main thread is not evidence
            // that the socket failed. Give queued network events a fresh probe.
            if (performance.now() > expected + 2000) { this.probe?.(); return; }
            connectionDiagnostic({ event: 'keepalive-timeout', transport: 'coordinator' });
            socket.close();
          }, 5000);
        };
        this.heartbeat = setInterval(this.probe, 10000);
        this.refreshAuth = setTimeout(() => {
          void this.authorize().then(auth => { if (current()) socket.send(JSON.stringify({ type: 'authorize', protocol: GAME_PROTOCOL, ...auth })); })
            .catch(error => { if (current()) socket.close(authorizationCloseCode(error), 'Authorization unavailable'); });
        }, Math.max(1000, message.expiresAt - this.now() - 60000));
      } else if (message.type === 'clue-ack') {
        this.replayOutbox.acknowledge(message.roundId, message.through); return;
      } else if (message.type === 'clue-replay') {
        this.replayReads.get(message.request)?.finish(message.replay); return;
      } else if (message.type === 'receipt') {
        const pending = this.outbox.get(message.roundId);
        if (pending?.nonce === message.nonce) { this.outbox.delete(message.roundId); this.persist(); }
      } else if (message.type === 'command') {
        const command = this.commands.get(message.id); this.commands.delete(message.id);
        if (this.hostPending?.id === message.id || command?.message.type === 'quit' && message.accepted) {
          this.hostPending = undefined; try { localStorage.removeItem(this.storageKey + ':host-guess'); } catch {}
        }
        if (message.accepted) command?.resolve(); else command?.reject(Error('This action could not be saved.'));
      }
      this.events.message(message);
    };
    socket.onerror = () => { if (current()) socket.close(); };
    socket.onclose = event => {
      if (!current()) return;
      for (const read of this.replayReads.values()) read.fail();
      connectionDiagnostic({ event: 'socket-close', transport: 'coordinator', status: event.code });
      this.ready = false; clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
      if (this.unavailable) return;
      if (this.completed) { this.update('connected', 'Game finished'); return; }
      if (event.code === 4002) { this.update('stopped', 'This game is open in another tab. Continue there.'); return; }
      if (event.code === 4003) { this.update('stopped', 'This invitation is not available.'); return; }
      if (event.code === 4004) { this.update('stopped', 'Reload this page to use the updated game connection.'); return; }
      if (event.code === 4001) {
        try { sessionStorage.removeItem(this.storageKey); } catch {}
        if (++this.authFailures > 1) { this.update('stopped', 'Sign in with Twitch to play.'); return; }
      }
      this.update(navigator.onLine === false ? 'offline' : 'retrying', navigator.onLine === false ? 'Network issues' : 'Reconnecting…');
      if (navigator.onLine !== false) void this.checkAvailability();
      const attempt = this.failures++;
      const backoff = attempt < 6 ? Math.min(15000, 750 * 2 ** Math.min(attempt, 5)) : attempt < 10 ? 60000 : 300000;
      this.timer = setTimeout(() => this.connect(), backoff + Math.random() * 500);
    };
  }
  /** Browsers hide an upgrade's HTTP status. Check only after a failed socket,
   * at most once per minute, and stop only on the coordinator's explicit 404. */
  private async checkAvailability(): Promise<void> {
    if (this.closed || this.ready || this.unavailable || this.availabilityRequest || Date.now() - this.checkedAvailabilityAt < 60000) return;
    this.checkedAvailabilityAt = Date.now();
    const controller = this.availabilityRequest = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await gameFetch(new URL(`/api/streams/live/${this.gameId}/socket`, this.origin), {
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (response.status !== 404) { await response.body?.cancel(); return; }
      if ((await response.text()).trim() !== 'Game unavailable' || this.closed || this.ready) return;
      this.unavailable = true;
      clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
      for (const command of this.commands.values()) command.reject(Error(GAME_UNAVAILABLE_MESSAGE));
      this.commands.clear();
      this.update('stopped', GAME_UNAVAILABLE_MESSAGE);
      this.socket?.close();
    } catch { /* A failed probe is not proof that the game is gone. */ }
    finally { clearTimeout(timeout); if (this.availabilityRequest === controller) this.availabilityRequest = undefined; }
  }
  retry(): void { if (!this.ready) { this.authFailures = 0; this.connect(); } }
  dispose(): void {
    this.flushReplay();
    this.replayOutbox.dispose();
    for (const read of this.replayReads.values()) read.fail();
    window.removeEventListener('pagehide', this.flushReplay);
    this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
    this.availabilityRequest?.abort();
    window.removeEventListener('online', this.online); this.socket?.close();
    document.removeEventListener('visibilitychange', this.visibility);
    for (const pending of this.commands.values()) pending.reject(Error('Connection closed')); this.commands.clear();
  }
}
