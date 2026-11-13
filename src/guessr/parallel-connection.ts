import type { ParallelAuthorization, ParallelClientMessage, ParallelServerMessage, ParallelSubmission } from './parallel-types';
import type { RoomConnection } from './live-room-types';

type Command = Extract<ParallelClientMessage, { id: string }>;
export class ParallelConnection {
  private socket?: WebSocket;
  private closed = false;
  private ready = false;
  private failures = 0;
  private authFailures = 0;
  private completed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongDeadline?: ReturnType<typeof setTimeout>;
  private refreshAuth?: ReturnType<typeof setTimeout>;
  private lastMessage = 0;
  private outbox = new Map<string, ParallelSubmission>();
  private relays = new Map<string, Extract<ParallelClientMessage, { type: 'relay' }>['message']>();
  private commands = new Map<string, { message: Command; resolve(): void; reject(error: Error): void }>();
  private hostPending?: Extract<Command, { type: 'host-guess' }>;
  private offset = 0;
  private status: RoomConnection = 'connecting';
  private storageKey: string;
  private online = () => { if (!this.closed && !this.ready) this.connect(); };
  constructor(private origin: string, readonly gameId: string, readonly identity: string,
    private authorize: () => Promise<ParallelAuthorization>,
    private events: { message(value: ParallelServerMessage): void; status(value: RoomConnection, detail: string): void }) {
    this.storageKey = `noitaguessr-socket:${gameId}:${identity}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey + ':pending') ?? '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(-10)) if (item?.roundId && /^[a-f0-9]{16}$/.test(item.nonce)) this.outbox.set(item.roundId, item);
    } catch { /* Pending sends are optional recovery data, never credentials. */ }
    if (identity.startsWith('host:')) try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey + ':host-guess') ?? 'null');
      if (saved?.type === 'host-guess' && /^[a-f0-9]{16}$/.test(saved.id) && /^[a-f0-9-]{36}$/.test(saved.roundId)
        && Number.isInteger(saved.maximum) && saved.maximum >= 0 && saved.maximum <= 5000
        && (saved.point === null || Number.isFinite(saved.point?.x) && Number.isFinite(saved.point?.y))) this.hostPending = saved;
    } catch {}
    window.addEventListener('online', this.online);
    this.connect();
  }
  now(): number { return Date.now() + this.offset; }
  connected(): boolean { return this.ready; }
  state(): RoomConnection { return this.status; }
  private update(status: RoomConnection, detail = '') { this.status = status; this.events.status(status, detail); }
  private persist(): void {
    try { localStorage.setItem(this.storageKey + ':pending', JSON.stringify([...this.outbox.values()])); } catch {}
  }
  private send(message: ParallelClientMessage): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  submit(submission: ParallelSubmission): void {
    this.outbox.set(submission.roundId, submission); this.persist();
    this.send({ type: 'guess', submission });
  }
  relay(message: Extract<ParallelClientMessage, { type: 'relay' }>['message']): void {
    if (!this.send({ type: 'relay', message }) && this.relays.size < 5000) this.relays.set(message.id, message);
  }
  recover(): void { this.send({ type: 'recover' }); }
  command(message: Command): Promise<void> {
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
    if (this.closed) return;
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
        if (current()) socket.send(JSON.stringify({ type: 'authorize', ...authorization }));
      })().catch(() => { if (current()) socket.close(4001, 'Authorization required'); });
    };
    socket.onmessage = event => {
      if (!current() || typeof event.data !== 'string') return;
      this.lastMessage = Date.now();
      clearTimeout(this.pongDeadline);
      if (event.data === 'pong') return;
      if (event.data.length > 3 * 1024 * 1024) { socket.close(1009); return; }
      let message: ParallelServerMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      if ('now' in message && Number.isFinite(message.now)) this.offset = message.now - Date.now();
      if (message.type === 'published') this.completed = true;
      if (message.type === 'authorized') {
        clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.refreshAuth);
        this.ready = true; this.failures = 0; this.authFailures = 0;
        try { sessionStorage.setItem(this.storageKey, JSON.stringify({ ticket: message.ticket, expiresAt: message.expiresAt })); } catch {}
        this.update('connected');
        for (const submission of this.outbox.values()) this.send({ type: 'guess', submission });
        for (const command of this.commands.values()) this.send(command.message);
        if (this.hostPending && !this.commands.has(this.hostPending.id)) this.send(this.hostPending);
        for (const message of this.relays.values()) this.send({ type: 'relay', message }); this.relays.clear();
        this.heartbeat = setInterval(() => {
          if (!current()) return;
          socket.send('ping');
          clearTimeout(this.pongDeadline);
          this.pongDeadline = setTimeout(() => { if (current()) socket.close(); }, 5000);
        }, 10000);
        this.refreshAuth = setTimeout(() => {
          void this.authorize().then(auth => { if (current()) socket.send(JSON.stringify({ type: 'authorize', ...auth })); })
            .catch(() => { if (current()) socket.close(4001, 'Authorization required'); });
        }, Math.max(1000, message.expiresAt - Date.now() - 60000));
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
      this.ready = false; clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
      if (event.code === 1000 && this.completed) { this.update('connected', 'Game finished'); return; }
      if (event.code === 4002) { this.update('stopped', 'Another tab is hosting this game. Continue there.'); return; }
      if (event.code === 4001) {
        try { sessionStorage.removeItem(this.storageKey); } catch {}
        if (++this.authFailures > 1) { this.update('stopped', 'Sign in with Twitch to play.'); return; }
      }
      this.update(navigator.onLine === false ? 'offline' : 'retrying', navigator.onLine === false ? 'Network issues' : 'Reconnecting…');
      const attempt = this.failures++;
      const backoff = attempt < 6 ? Math.min(15000, 750 * 2 ** Math.min(attempt, 5)) : attempt < 10 ? 60000 : 300000;
      this.timer = setTimeout(() => this.connect(), backoff + Math.random() * 500);
    };
  }
  retry(): void { if (!this.ready) { this.authFailures = 0; this.connect(); } }
  dispose(): void {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.pongDeadline); clearTimeout(this.refreshAuth);
    window.removeEventListener('online', this.online); this.socket?.close();
    for (const pending of this.commands.values()) pending.reject(Error('Connection closed')); this.commands.clear();
  }
}
