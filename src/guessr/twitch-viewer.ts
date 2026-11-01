import { formatGuessCommand } from './guess-command';
import type { Point } from './rules';
import { STREAM_ROUNDS } from './stream-types';
import { TwitchChatConnection, type TwitchChatOptions } from './twitch-chat';
import { tr } from './i18n';

/** Keep transport state in source English so an open view can change language. */
export function twitchMessageText(source: string): string {
  const droppedPrefix = 'Twitch did not send this message: ';
  return source.startsWith(droppedPrefix)
    ? tr('Twitch did not send this message: {{reason}}', { reason: source.slice(droppedPrefix.length) })
    : source ? tr(source) : '';
}

/** Public application identifier, shared with the existing Noitamap Twitch app.
 * Override only through trusted build/application configuration, never a URL. */
export const DEFAULT_TWITCH_CLIENT_ID = '9wmgerb87z6v5i8yb1q5ggy2ya2khj';
export const TWITCH_VIEWER_CALLBACK = '/guess/twitch-callback.html';
export const TWITCH_VIEWER_MESSAGE = 'noitamap-twitch-viewer-oauth';
const SCOPES = ['user:read:chat', 'user:write:chat'];
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const USERS_URL = 'https://api.twitch.tv/helix/users';
const SEND_URL = 'https://api.twitch.tv/helix/chat/messages';
const VALIDATE_INTERVAL = 60 * 60 * 1000;
const AUTH_TIMEOUT = 5 * 60 * 1000;
const STORAGE_KEY = 'noitamap-guessr-twitch-v1:';

export interface TwitchViewerState {
  connected: boolean;
  connecting: boolean;
  restoring?: boolean;
  sending: boolean;
  userId: string | null;
  login: string | null;
  expiresAt: number | null;
  error: string | null;
}
export type TwitchViewerErrorCode = 'configuration' | 'popup' | 'denied' | 'expired' | 'validation'
  | 'disconnected' | 'busy' | 'invalid-guess' | 'invalid-message' | 'channel' | 'channel-not-found' | 'forbidden' | 'rate-limit' | 'dropped' | 'uncertain';
export class TwitchViewerError extends Error {
  constructor(public readonly code: TwitchViewerErrorCode, message: string) { super(message); this.name = 'TwitchViewerError'; }
}
export interface TwitchViewerPopup { readonly closed: boolean; close(): void }
export interface TwitchViewerOptions {
  clientId?: string;
  /** Dependency injection for unit tests; the default calls only Twitch APIs. */
  fetch?: typeof fetch;
  popup?: (url: string, name: string, features: string) => TwitchViewerPopup | null;
  socket?: TwitchChatOptions['socket'];
}
interface Credentials { token: string; userId: string; login: string; expiresAt: number; checkedAt: number }
interface PendingAuth {
  state: string;
  popup: TwitchViewerPopup;
  consumed: boolean;
  promise: Promise<TwitchViewerState>;
  resolve(value: TwitchViewerState): void;
  reject(error: Error): void;
  cleanup(): void;
}
const emptyState = (): TwitchViewerState => ({ connected: false, connecting: false, sending: false,
  userId: null, login: null, expiresAt: null, error: null });

/** Viewer-only browser OAuth. No Noitamap auth, Worker calls or queued
 * messages. connect() grants permission; sendGuess() is a separate user action. */
export class TwitchViewer {
  readonly configured: boolean;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly ready: Promise<void>;
  #credentials: Credentials | null = null;
  private state = emptyState();
  private listeners = new Set<(state: TwitchViewerState) => void>();
  private pending: PendingAuth | null = null;
  private validation: Promise<Credentials> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private controllers = new Set<AbortController>();
  private channels = new Map<string, string>();
  private chats = new Set<() => void>();
  private disposed = false;
  private generation = 0;

  constructor(private options: TwitchViewerOptions = {}) {
    this.clientId = options.clientId ?? import.meta.env.VITE_GUESSR_TWITCH_CLIENT_ID ?? DEFAULT_TWITCH_CLIENT_ID;
    this.redirectUri = new URL(TWITCH_VIEWER_CALLBACK, window.location.origin).href;
    this.configured = /^[a-zA-Z0-9]{1,128}$/.test(this.clientId)
      && (location.protocol === 'https:' || location.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
    this.ready = this.restoreSaved();
  }

  private forgetSaved(): void {
    try { localStorage.removeItem(STORAGE_KEY + this.clientId); } catch { /* Storage can be unavailable. */ }
  }
  private remember(credentials: Credentials): void {
    try { localStorage.setItem(STORAGE_KEY + this.clientId, JSON.stringify(credentials)); }
    catch { /* A blocked/full store still permits this tab to use Twitch. */ }
  }
  private async restoreSaved(): Promise<void> {
    if (!this.configured) return;
    let saved: Credentials;
    try {
      const raw = localStorage.getItem(STORAGE_KEY + this.clientId);
      if (!raw) return;
      if (raw.length > 4096) throw Error();
      saved = JSON.parse(raw);
      if (!saved || typeof saved.token !== 'string' || !/^[a-zA-Z0-9]{1,2048}$/.test(saved.token)
        || typeof saved.userId !== 'string' || !/^\d{1,30}$/.test(saved.userId)
        || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= Date.now() + 5000) throw Error();
    } catch { this.forgetSaved(); return; }
    const generation = this.generation;
    this.update({ connecting: true, restoring: true });
    try {
      const credentials = await this.validateToken(saved.token, saved.userId);
      if (this.disposed || generation !== this.generation) return;
      this.#credentials = credentials;
      this.remember(credentials);
      this.update({ connected: true, userId: credentials.userId, login: credentials.login,
        expiresAt: credentials.expiresAt, error: null });
      this.scheduleValidation();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (error instanceof TwitchViewerError && ['expired', 'validation'].includes(error.code)) this.forgetSaved();
      this.update({ error: 'Could not restore Twitch access. Please sign in again.' });
    } finally {
      if (generation === this.generation) this.update({ connecting: false, restoring: false });
    }
  }

  getState(): TwitchViewerState { return { ...this.state }; }
  subscribe(listener: (state: TwitchViewerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => { this.listeners.delete(listener); };
  }
  private update(changes: Partial<TwitchViewerState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.getState());
  }

  /** Call directly from the Connect button so the browser permits the popup. */
  connect(): Promise<TwitchViewerState> {
    if (this.disposed) return Promise.reject(new TwitchViewerError('disconnected', 'This Twitch connection is closed.'));
    if (!this.configured) return Promise.reject(new TwitchViewerError('configuration', 'Twitch chat sending is not configured on this site.'));
    if (this.state.sending) return Promise.reject(new TwitchViewerError('busy', 'Wait for the current guess to finish sending.'));
    if (this.pending) return this.pending.promise;
    if (this.state.restoring) return this.ready.then(() => {
      if (this.state.connected) return this.getState();
      throw new TwitchViewerError('expired', 'Please sign in to Twitch again.');
    });
    if (this.#credentials && this.#credentials.expiresAt > Date.now() + 5000) return Promise.resolve(this.getState());
    this.clearCredentials();
    const generation = ++this.generation;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
    authorize.search = new URLSearchParams({ response_type: 'token', client_id: this.clientId,
      redirect_uri: this.redirectUri, scope: SCOPES.join(' '), state, force_verify: 'true' }).toString();
    let popup: TwitchViewerPopup | null;
    try { popup = (this.options.popup ?? ((url, name, features) => window.open(url, name, features)))(
      authorize.href, 'noitamap-twitch-' + state, 'popup,width=520,height=720'); }
    catch { popup = null; }
    if (!popup) {
      const error = new TwitchViewerError('popup', 'Allow the Twitch sign-in popup, then click Connect again.');
      this.update({ error: error.message });
      return Promise.reject(error);
    }
    let resolve!: PendingAuth['resolve'], reject!: PendingAuth['reject'];
    const promise = new Promise<TwitchViewerState>((yes, no) => { resolve = yes; reject = no; });
    const onMessage = (event: MessageEvent) => {
      const pending = this.pending;
      if (!pending || pending.consumed || event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== TWITCH_VIEWER_MESSAGE || data.state !== state) return;
      pending.consumed = true;
      pending.cleanup();
      void (async () => {
        try {
          if (typeof data.error === 'string' && data.error) throw new TwitchViewerError('denied',
            data.error === 'access_denied' ? 'Twitch connection was cancelled. No guess was sent.' : 'Twitch could not complete sign-in. Please connect again.');
          if (typeof data.accessToken !== 'string' || !/^[a-zA-Z0-9]{1,2048}$/.test(data.accessToken))
            throw new TwitchViewerError('validation', 'Twitch returned an invalid sign-in response.');
          const credentials = await this.validateToken(data.accessToken);
          if (this.disposed || generation !== this.generation || this.pending !== pending) return;
          this.#credentials = credentials;
          this.remember(credentials);
          this.pending = null;
          this.update({ connected: true, connecting: false, userId: credentials.userId,
            login: credentials.login, expiresAt: credentials.expiresAt, error: null });
          this.scheduleValidation();
          pending.resolve(this.getState());
        } catch (error) {
          if (this.pending !== pending) return;
          this.pending = null;
          const failure = error instanceof TwitchViewerError ? error : new TwitchViewerError('validation', 'Could not verify Twitch sign-in. Please connect again.');
          this.clearCredentials();
          this.update({ connecting: false, error: failure.message });
          pending.reject(failure);
        }
      })();
    };
    const cancel = (message: string) => {
      if (!this.pending || this.pending.state !== state || this.pending.consumed) return;
      const pending = this.pending;
      this.pending = null;
      pending.cleanup();
      this.update({ connecting: false, error: message });
      pending.reject(new TwitchViewerError('popup', message));
    };
    const closedTimer = setInterval(() => { if (popup.closed) cancel('Twitch sign-in was closed. No guess was sent.'); }, 250);
    const timeout = setTimeout(() => cancel('Twitch sign-in expired. Click Connect to try again.'), AUTH_TIMEOUT);
    this.pending = { state, popup, consumed: false, promise, resolve, reject, cleanup: () => {
      clearInterval(closedTimer); clearTimeout(timeout); window.removeEventListener('message', onMessage);
      try { popup.close(); } catch { /* Cross-origin popup may already be closed. */ }
    } };
    window.addEventListener('message', onMessage);
    this.update({ connecting: true, error: null });
    return promise;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await (this.options.fetch ?? fetch)(url, { ...init, credentials: 'omit', cache: 'no-store',
        referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    } finally { this.controllers.delete(controller); }
  }
  private async validateToken(token: string, expectedUserId?: string): Promise<Credentials> {
    const response = await this.request(VALIDATE_URL, { headers: { Authorization: 'OAuth ' + token } });
    if (!response.ok) throw new TwitchViewerError(response.status === 401 ? 'expired' : 'validation',
      response.status === 401 ? 'Twitch sign-in expired. Connect again before sending.' : 'Twitch could not verify your sign-in. Please connect again.');
    const value = await response.json() as { client_id?: unknown; user_id?: unknown; login?: unknown; scopes?: unknown; expires_in?: unknown };
    if (value.client_id !== this.clientId || typeof value.user_id !== 'string' || !/^\d{1,30}$/.test(value.user_id)
      || expectedUserId !== undefined && value.user_id !== expectedUserId
      || typeof value.login !== 'string' || !/^[a-z0-9_]{1,25}$/.test(value.login)
      || !Array.isArray(value.scopes) || !SCOPES.every(scope => (value.scopes as unknown[]).includes(scope))
      || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 5
      || !Number.isSafeInteger(Date.now() + value.expires_in * 1000))
      throw new TwitchViewerError('validation', 'Twitch sign-in did not match this app, account, or chat permission. Connect again.');
    return { token, userId: value.user_id, login: value.login, checkedAt: Date.now(), expiresAt: Date.now() + value.expires_in * 1000 };
  }
  private refreshValidation(): Promise<Credentials> {
    if (this.validation) return this.validation;
    const previous = this.#credentials, generation = this.generation;
    if (!previous) return Promise.reject(new TwitchViewerError('disconnected', 'Connect Twitch before sending a guess.'));
    const job = this.validateToken(previous.token, previous.userId).then(credentials => {
      if (generation !== this.generation || this.disposed) throw new TwitchViewerError('disconnected', 'The Twitch connection changed.');
      this.#credentials = credentials;
      this.remember(credentials);
      this.update({ connected: true, login: credentials.login, expiresAt: credentials.expiresAt, error: null });
      this.scheduleValidation();
      return credentials;
    }).catch(error => {
      if (generation === this.generation) {
        this.clearCredentials();
        this.update({ error: error instanceof TwitchViewerError ? error.message : 'Could not verify Twitch access. Connect again before sending.' });
      }
      throw error;
    }).finally(() => { if (this.validation === job) this.validation = null; });
    this.validation = job;
    return job;
  }
  private scheduleValidation(): void {
    clearTimeout(this.timer);
    const credentials = this.#credentials;
    if (!credentials || this.disposed) return;
    this.timer = setTimeout(() => {
      if (!this.#credentials) return;
      if (this.#credentials.expiresAt <= Date.now() + 5000) {
        this.clearCredentials();
        this.update({ error: 'Twitch sign-in expired. Connect again before sending.' });
      } else void this.refreshValidation().catch(() => { /* State contains the reconnect instruction. */ });
    }, Math.max(1, Math.min(VALIDATE_INTERVAL, credentials.expiresAt - Date.now() - 5000)));
  }
  private async currentCredentials(): Promise<Credentials> {
    const credentials = this.#credentials;
    if (!credentials || this.disposed) throw new TwitchViewerError('disconnected', 'Connect Twitch before sending a guess.');
    if (credentials.expiresAt <= Date.now() + 5000) {
      this.clearCredentials();
      throw new TwitchViewerError('expired', 'Twitch sign-in expired. Connect again before sending.');
    }
    return this.validation || Date.now() - credentials.checkedAt >= VALIDATE_INTERVAL
      ? this.refreshValidation() : credentials;
  }
  private async broadcaster(channel: string, credentials: Credentials): Promise<string> {
    const known = this.channels.get(channel);
    if (known) return known;
    const url = new URL(USERS_URL);
    url.searchParams.set('login', channel);
    const response = await this.request(url.href, { headers: this.headers(credentials) });
    if (response.status === 401) {
      this.clearCredentials();
      throw new TwitchViewerError('expired', 'Twitch sign-in expired. Connect again before sending.');
    }
    if (response.status === 429) throw new TwitchViewerError('rate-limit', 'Twitch is limiting requests. Wait before trying again.');
    if (!response.ok) throw new TwitchViewerError('channel', 'Twitch could not check this channel. Please try again.');
    const data = await response.json() as { data?: { id?: unknown; login?: unknown }[] };
    if (Array.isArray(data.data) && data.data.length === 0)
      throw new TwitchViewerError('channel-not-found', 'No Twitch account matches that username. Check the Twitch channel name.');
    const user = Array.isArray(data.data) && data.data.length === 1 ? data.data[0] : null;
    if (!user || user.login !== channel || typeof user.id !== 'string' || !/^\d{1,30}$/.test(user.id))
      throw new TwitchViewerError('channel', 'Twitch could not check this channel. Please try again.');
    if (this.channels.size >= 32) this.channels.delete(this.channels.keys().next().value!);
    this.channels.set(channel, user.id);
    return user.id;
  }
  private headers(credentials: Credentials): Record<string, string> {
    return { Authorization: 'Bearer ' + credentials.token, 'Client-Id': this.clientId };
  }

  /** Reading and sending use the same validated viewer identity and channel. */
  watchChat(channel: string, handlers: Pick<TwitchChatOptions, 'message' | 'status' | 'remove'>): () => void {
    let stopped = false;
    let connection: TwitchChatConnection | undefined;
    const generation = this.generation;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      connection?.stop();
      this.chats.delete(stop);
    };
    this.chats.add(stop);
    void (async () => {
      try {
        if (!/^[a-z0-9_]{1,25}$/i.test(channel)) throw new TwitchViewerError('channel', 'Choose a Twitch channel.');
        const identity = await this.currentCredentials();
        const broadcasterId = await this.broadcaster(channel.toLowerCase(), identity);
        if (stopped || generation !== this.generation) return;
        connection = new TwitchChatConnection({ ...handlers, userId: identity.userId, broadcasterId,
          credentials: async () => {
            const current = await this.currentCredentials();
            return { accessToken: current.token, clientId: this.clientId, userId: current.userId,
              login: current.login, expiresAt: current.expiresAt };
          },
          status: (status, detail) => {
            if (stopped) return;
            handlers.status(status, detail);
            if (status === 'auth-required') {
              this.clearCredentials();
              this.update({ error: 'Sign in to Twitch again to use chat and send guesses.' });
            }
          },
          fetch: (url, init) => this.request(String(url), init ?? {}), socket: this.options.socket,
        });
        connection.start();
      } catch (error) {
        if (!stopped) handlers.status(error instanceof TwitchViewerError && error.code === 'channel-not-found' ? 'channel-not-found' : 'offline',
          error instanceof Error ? error.message : 'Could not connect to chat.');
      }
    })();
    return stop;
  }

  /** Exactly one send attempt, called explicitly after connect() has completed.
   * An uncertain response is never retried: Twitch may already have sent it. */
  async sendGuess(channel: string, round: number, point: Point, maximum?: number, roundId?: string): Promise<string> {
    let command: string;
    try {
      if (typeof channel !== 'string' || !/^[a-z0-9_]{1,25}$/i.test(channel) || round > STREAM_ROUNDS) throw Error();
      command = formatGuessCommand(round, point, maximum, roundId);
    } catch { throw new TwitchViewerError('invalid-guess', 'Choose a valid round, map position, and Twitch channel before sending.'); }
    return this.sendMessage(channel, command);
  }

  async sendMessage(channel: string, message: string): Promise<string> {
    if (this.state.sending) throw new TwitchViewerError('busy', 'Your previous message is still being sent.');
    if (!/^[a-z0-9_]{1,25}$/i.test(channel) || typeof message !== 'string' || !message.trim() || message.length > 500)
      throw new TwitchViewerError('invalid-message', 'Choose a channel and enter a message of up to 500 characters.');
    const generation = this.generation;
    this.update({ sending: true, error: null });
    let attempted = false;
    try {
      const credentials = await this.currentCredentials();
      const id = await this.broadcaster(channel.toLowerCase(), credentials);
      if (generation !== this.generation || this.#credentials?.token !== credentials.token || this.disposed)
        throw new TwitchViewerError('disconnected', 'The Twitch connection changed. Click Send after connecting again.');
      attempted = true;
      const response = await this.request(SEND_URL, { method: 'POST', headers: { ...this.headers(credentials), 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_id: id, sender_id: credentials.userId, message }) });
      if (response.status === 401) {
        if (generation === this.generation) this.clearCredentials();
        throw new TwitchViewerError('expired', 'Twitch sign-in expired. Connect again before sending.');
      }
      if (response.status === 403) throw new TwitchViewerError('forbidden', 'Twitch does not allow this account to send messages in that channel.');
      if (response.status === 429) throw new TwitchViewerError('rate-limit', 'Twitch is limiting messages. Wait before sending again.');
      if (!response.ok) throw new TwitchViewerError('uncertain', 'Twitch did not confirm delivery. Check chat before sending again.');
      const data = await response.json() as { data?: { is_sent?: unknown; message_id?: unknown; drop_reason?: { message?: unknown } }[] };
      const sent = Array.isArray(data.data) && data.data.length === 1 ? data.data[0] : null;
      if (sent?.is_sent === false) throw new TwitchViewerError('dropped', typeof sent.drop_reason?.message === 'string'
        ? 'Twitch did not send this message: ' + sent.drop_reason.message.slice(0, 200) : 'Twitch did not send this message. Check the channel’s chat restrictions.');
      if (sent?.is_sent !== true || typeof sent.message_id !== 'string' || !sent.message_id || sent.message_id.length > 256)
        throw new TwitchViewerError('uncertain', 'Twitch did not confirm delivery. Check chat before sending again.');
      return sent.message_id;
    } catch (error) {
      const failure = error instanceof TwitchViewerError ? error : new TwitchViewerError(attempted ? 'uncertain' : 'channel', attempted
        ? 'Delivery could not be confirmed. Check Twitch chat before sending again.' : 'Could not contact Twitch. No guess was sent.');
      if (generation === this.generation) this.update({ error: failure.message });
      throw failure;
    } finally { if (generation === this.generation) this.update({ sending: false }); }
  }

  private clearCredentials(forget = true): void {
    clearTimeout(this.timer);
    this.#credentials = null;
    this.validation = null;
    this.channels.clear();
    for (const stop of this.chats) stop();
    if (forget) this.forgetSaved();
    this.update({ connected: false, userId: null, login: null, expiresAt: null });
  }
  disconnect(forget = true): void {
    this.generation++;
    const pending = this.pending;
    this.pending = null;
    if (pending) { pending.cleanup(); pending.reject(new TwitchViewerError('disconnected', 'Twitch connection cancelled.')); }
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.clearCredentials(forget);
    this.update({ connecting: false, restoring: false, sending: false, error: null });
  }
  dispose(): void { this.disposed = true; this.disconnect(false); this.listeners.clear(); }
}
