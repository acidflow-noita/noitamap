import type { StreamChatMessage } from "./stream-state";
import { canShareGameLink, postTwitchGameLink } from './twitch-announcement';

export interface TwitchChatCredentials {
  accessToken: string;
  clientId: string;
  userId: string;
  login: string;
  expiresAt: number;
  scopes?: string[];
}
export type TwitchChatStatus =
  "connecting" | "live" | "reconnecting" | "offline" | "auth-required" | "channel-not-found";
export interface TwitchSocket {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number): void;
}
export interface TwitchChatOptions {
  userId: string;
  broadcasterId?: string;
  broadcasterLogin?: string;
  credentials: () => Promise<TwitchChatCredentials | null>;
  message: (message: StreamChatMessage) => void;
  status: (status: TwitchChatStatus, detail: string) => void;
  remove?: (kind: 'all' | 'user' | 'message', id?: string) => void;
  socket?: (url: string) => TwitchSocket;
  fetch?: typeof fetch;
}
const ENDPOINT = "wss://eventsub.wss.twitch.tv/ws";

/** Read-only channel subscriptions. Browser WebSocket handles ping/pong.
 * A server-directed handoff keeps the old connection alive until welcome and
 * carries subscriptions over. A lost socket creates a new subscription; Twitch
 * does not replay the messages missed in that interval. */
export class TwitchChatConnection {
  private active?: TwitchSocket;
  private candidate?: TwitchSocket;
  private credentials?: TwitchChatCredentials;
  private watchdogs = new Map<TwitchSocket, ReturnType<typeof setTimeout>>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private epoch = 0;
  private retries = 0;
  private seen = new Set<string>();
  private broadcasterId?: string;
  constructor(private options: TwitchChatOptions) {
    this.broadcasterId = options.broadcasterId ?? (options.broadcasterLogin ? undefined : options.userId);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.fresh(false);
  }
  canShare(announcements: boolean): boolean { return canShareGameLink(this.credentials, announcements); }
  postGameLink(hostId: string, message: string, announcements: boolean): Promise<void> {
    return postTwitchGameLink(this.credentials, hostId, message, announcements, this.options.fetch ?? fetch);
  }
  stop(): void {
    this.stopped = true;
    this.epoch++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    this.closeSockets();
    this.options.status(
      "offline",
      "Chat disconnected.",
    );
  }
  private closeSockets(): void {
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
    this.watchdogs.clear();
    const sockets = [this.active, this.candidate];
    this.active = this.candidate = undefined;
    for (const socket of sockets)
      if (socket) {
        socket.onclose = null;
        socket.close(1000);
      }
  }
  private async fresh(gap: boolean): Promise<void> {
    const epoch = ++this.epoch;
    this.closeSockets();
    clearTimeout(this.refreshTimer);
    this.options.status(
      gap ? "reconnecting" : "connecting",
      gap
        ? "Reconnecting to chat. Messages missed while disconnected are not replayed; viewers should resend after reconnection."
        : "Connecting to Twitch chat…",
    );
    try {
      const credentials = await this.options.credentials();
      if (this.stopped || epoch !== this.epoch) return;
      if (
        !credentials ||
        credentials.userId !== this.options.userId ||
        credentials.expiresAt <= Date.now() + 5000
      ) {
        this.authRequired();
        return;
      }
      this.credentials = credentials;
      if (!this.broadcasterId) {
        const login = this.options.broadcasterLogin;
        if (!login || !/^[a-z0-9_]{1,25}$/.test(login)) throw Error('Invalid chat channel');
        const response = await (this.options.fetch ?? fetch)('https://api.twitch.tv/helix/users?login=' + login, {
          headers: { 'Client-Id': credentials.clientId, Authorization: 'Bearer ' + credentials.accessToken },
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000),
        });
        if (this.stopped || epoch !== this.epoch) return;
        if (response.status === 401 || response.status === 403) { this.authRequired(); return; }
        if (!response.ok) throw Error('Channel lookup failed');
        const value = await response.json() as { data?: { id?: unknown; login?: unknown }[] };
        if (this.stopped || epoch !== this.epoch) return;
        const channel = value.data?.length === 1 ? value.data[0] : undefined;
        if (!channel || channel.login !== login || typeof channel.id !== 'string' || !/^\d{1,30}$/.test(channel.id)) {
          this.stop(); this.options.status('channel-not-found', 'Could not connect to chat.'); return;
        }
        this.broadcasterId = channel.id;
      }
      this.connect(ENDPOINT, false, epoch);
      this.scheduleValidation(credentials, epoch);
    } catch {
      if (!this.stopped && epoch === this.epoch) this.retry();
    }
  }
  private scheduleValidation(
    credentials: TwitchChatCredentials,
    epoch: number,
  ): void {
    clearTimeout(this.refreshTimer);
    // Twitch requires token validation at least hourly. A still-valid token
    // needs no socket interruption; changed credentials establish a fresh session.
    this.refreshTimer = setTimeout(
      () =>
        void (async () => {
          try {
            const next = await this.options.credentials();
            if (this.stopped || this.epoch !== epoch) return;
            if (
              !next ||
              next.userId !== this.options.userId ||
              next.expiresAt <= Date.now() + 5000
            ) {
              this.authRequired();
              return;
            }
            if (next.accessToken !== credentials.accessToken) {
              await this.fresh(true);
              return;
            }
            this.credentials = next;
            this.scheduleValidation(next, epoch);
          } catch {
            if (!this.stopped && this.epoch === epoch) this.retry();
          }
        })(),
      Math.min(
        3600000,
        Math.max(1000, credentials.expiresAt - Date.now() - 30000),
      ),
    );
  }
  private connect(url: string, handoff: boolean, epoch: number): void {
    let socket: TwitchSocket;
    try {
      socket = (this.options.socket ?? ((target) => new WebSocket(target)))(
        url,
      );
    } catch {
      this.retry();
      return;
    }
    if (handoff) this.candidate = socket;
    else this.active = socket;
    let heartbeat = 15000,
      welcomed = false;
    const watch = () => {
      clearTimeout(this.watchdogs.get(socket));
      this.watchdogs.set(
        socket,
        setTimeout(() => {
          if (this.stopped || epoch !== this.epoch) return;
          socket.close(4000);
          this.retry();
        }, heartbeat),
      );
    };
    watch();
    socket.onmessage = (event) => {
      if (
        this.stopped ||
        epoch !== this.epoch ||
        typeof event.data !== "string"
      )
        return;
      let value: Record<string, any>;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!value?.metadata || !value?.payload) return;
      const type = value.metadata.message_type;
      if (type === "session_welcome") {
        if (welcomed) return;
        welcomed = true;
        const session = value.payload.session;
        if (!session || typeof session.id !== "string") {
          this.retry();
          return;
        }
        const timeout = session.keepalive_timeout_seconds;
        if (typeof timeout === "number" && timeout > 0)
          heartbeat = timeout * 1000 + 2000;
        watch();
        if (handoff) {
          const previous = this.active;
          this.active = socket;
          this.candidate = undefined;
          if (previous) {
            clearTimeout(this.watchdogs.get(previous));
            this.watchdogs.delete(previous);
            previous.onclose = null;
            previous.close(1000);
          }
          this.live();
        } else void this.subscribe(session.id, socket, epoch);
        return;
      }
      watch();
      if (type === "session_reconnect") {
        if (this.candidate) return;
        const target = value.payload.session?.reconnect_url;
        try {
          if (typeof target !== "string") throw Error();
          const safe = new URL(target);
          if (
            safe.protocol !== "wss:" ||
            safe.hostname !== "eventsub.wss.twitch.tv" ||
            safe.username ||
            safe.password
          )
            throw Error();
          this.options.status(
            "reconnecting",
            "Twitch is moving the connection; chat remains active during the handoff.",
          );
          this.connect(target, true, epoch);
        } catch {
          this.retry();
        }
        return;
      }
      if (type === "revocation") {
        this.authRequired();
        return;
      }
      if (
        type !== "notification" ||
        !['channel.chat.message', ...(this.options.remove ? ['channel.chat.clear', 'channel.chat.clear_user_messages', 'channel.chat.message_delete'] : [])]
          .includes(value.payload.subscription?.type)
      )
        return;
      const id = value.metadata.message_id;
      if (typeof id !== "string" || this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 10000)
        this.seen.delete(this.seen.values().next().value!);
      const chat = value.payload.event;
      const broadcasterId = this.broadcasterId;
      if (!chat || chat.broadcaster_user_id !== broadcasterId
        || chat.source_broadcaster_user_id && chat.source_broadcaster_user_id !== broadcasterId) return;
      const subscription = value.payload.subscription.type;
      if (subscription === 'channel.chat.clear') { this.options.remove?.('all'); return; }
      if (subscription === 'channel.chat.clear_user_messages') {
        if (typeof chat.target_user_id === 'string') this.options.remove?.('user', chat.target_user_id);
        return;
      }
      if (subscription === 'channel.chat.message_delete') {
        if (typeof chat.message_id === 'string') this.options.remove?.('message', chat.message_id);
        return;
      }
      if (
        typeof chat.chatter_user_id !== "string" ||
        typeof chat.chatter_user_login !== "string" ||
        typeof chat.chatter_user_name !== "string" ||
        typeof chat.message?.text !== "string" ||
        typeof chat.message_id !== "string"
      )
        return;
      this.options.message({
        id: chat.message_id,
        text: chat.message.text,
        sentAt: Date.parse(value.metadata.message_timestamp),
        player: {
          id: chat.chatter_user_id,
          login: chat.chatter_user_login,
          name: chat.chatter_user_name,
        },
      });
    };
    socket.onclose = () => {
      clearTimeout(this.watchdogs.get(socket));
      this.watchdogs.delete(socket);
      if (this.stopped || epoch !== this.epoch) return;
      if (socket === this.active && this.candidate) {
        this.active = undefined;
        return;
      }
      if (socket === this.active || socket === this.candidate) this.retry();
    };
    socket.onerror = () => {
      /* The close event or watchdog drives reconnection. */
    };
  }
  private async subscribe(
    sessionId: string,
    socket: TwitchSocket,
    epoch: number,
  ): Promise<void> {
    const credentials = this.credentials!;
    try {
      const types = ['channel.chat.message', ...(this.options.remove
        ? ['channel.chat.clear', 'channel.chat.clear_user_messages', 'channel.chat.message_delete'] : [])];
      for (const type of types) {
      const response = await (this.options.fetch ?? fetch)(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          method: "POST",
          headers: {
            "Client-Id": credentials.clientId,
            Authorization: "Bearer " + credentials.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type,
            version: "1",
            condition: {
              broadcaster_user_id: this.broadcasterId,
              user_id: credentials.userId,
            },
            transport: { method: "websocket", session_id: sessionId },
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (this.stopped || epoch !== this.epoch || this.active !== socket)
        return;
      if (response.status === 401 || response.status === 403) {
        this.authRequired();
        return;
      }
      if (response.status !== 202) throw Error();
      }
      this.live();
    } catch {
      if (!this.stopped && epoch === this.epoch) this.retry();
    }
  }
  private live(): void {
    this.retries = 0;
    this.options.status(
      "live",
      "Chat connected. Latest valid guess received before you submit counts.",
    );
  }
  private retry(): void {
    if (this.stopped) return;
    this.epoch++;
    this.closeSockets();
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    this.options.status(
      "reconnecting",
      "Chat interrupted. Missed messages are not replayed; viewers should resend after reconnection.",
    );
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5));
    this.retryTimer = setTimeout(() => void this.fresh(true), delay);
  }
  private authRequired(): void {
    this.stop();
    this.options.status(
      "auth-required",
      "Reconnect Twitch to allow reading chat for this channel.",
    );
  }
}
