import { tr } from './i18n';
import { ANNOUNCEMENT_SCOPE, canShareGameLink, postTwitchGameLink } from './twitch-announcement';
import type { ParallelAuthorization } from './parallel-types';

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
export const TWITCH_VERIFICATION_FAILED = 'Could not verify Twitch sign-in. Please connect again.';
const SCOPES = ['user:write:chat'];
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const VALIDATE_INTERVAL = 60 * 60 * 1000;
const AUTH_TIMEOUT = 5 * 60 * 1000;
const STORAGE_KEY = 'noitamap-guessr-twitch-tab-v3:';
const LEGACY_KEY = 'noitamap-guessr-twitch-v1:';
const IDENTITY_KEY = 'noitamap-guessr-twitch-identity-v2:';

/** Read-only result presentation, including after token expiry. This neither
 * authenticates a viewer nor starts token validation or a chat connection. */
export function savedTwitchViewerId(clientId = import.meta.env.VITE_GUESSR_TWITCH_CLIENT_ID ?? DEFAULT_TWITCH_CLIENT_ID): string | undefined {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY + clientId);
    if (!raw || raw.length > 4096) return undefined;
    const saved = JSON.parse(raw);
    return typeof saved?.userId === 'string' && /^\d{1,30}$/.test(saved.userId) ? saved.userId : undefined;
  } catch { return undefined; }
}

export interface TwitchViewerState {
  connected: boolean;
  connecting: boolean;
  restoring?: boolean;
  sending: boolean;
  userId: string | null;
  /** Read-only identity from this browser's saved session, usable for offline scores. */
  savedUserId?: string | null;
  login: string | null;
  displayName?: string;
  color?: string;
  expiresAt: number | null;
  error: string | null;
}
export type TwitchViewerErrorCode = 'configuration' | 'popup' | 'denied' | 'expired' | 'validation'
  | 'disconnected' | 'busy' | 'unavailable' | 'forbidden';
export class TwitchViewerError extends Error {
  constructor(public readonly code: TwitchViewerErrorCode, message: string) { super(message); this.name = 'TwitchViewerError'; }
}
export interface TwitchViewerPopup { readonly closed: boolean; close(): void }
export interface TwitchViewerOptions {
  /** A verified site identity uses game tickets, never a second provider popup. */
  siteIdentity?: { userId: string; login: string; displayName: string; color?: string };
  siteAuthorization?: (renew?: boolean) => Promise<string>;
  siteRole?: 'host' | 'account';
  siteLogin?: () => void | Promise<void>;
  onDispose?: () => void;
  siteSignOut?: () => void;
  /** Local host sharing may request posting permission. Gameplay needs identity only. */
  chat?: boolean;
  clientId?: string;
  /** Dependency injection for unit tests; the default calls only Twitch APIs. */
  fetch?: typeof fetch;
  popup?: (url: string, name: string, features: string) => TwitchViewerPopup | null;
}
interface Credentials { token: string; userId: string; login: string; scopes: string[]; expiresAt: number; checkedAt: number }
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

/** Browser identity for the game. Optional host sharing posts only invitation
 * and result links to the broadcaster's own channel. */
export class TwitchViewer {
  private get requiredScopes(): string[] { return this.options.chat === true ? SCOPES : []; }
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
  private disposed = false;
  private generation = 0;

  constructor(private options: TwitchViewerOptions = {}) {
    this.clientId = options.clientId ?? import.meta.env.VITE_GUESSR_TWITCH_CLIENT_ID
      ?? (location.hostname === 'dynamic-map.noitamap.com' ? DEFAULT_TWITCH_CLIENT_ID : '');
    this.redirectUri = new URL(TWITCH_VIEWER_CALLBACK, window.location.origin).href;
    this.configured = /^[a-zA-Z0-9]{1,128}$/.test(this.clientId)
      && (location.protocol === 'https:' || location.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
    this.purgeLegacyCredentials();
    if (options.siteIdentity && options.siteAuthorization) {
      this.setSiteSession(options.siteIdentity, options.siteRole ?? 'host', options.siteAuthorization);
      this.ready = Promise.resolve(); return;
    }
    this.state.savedUserId = savedTwitchViewerId(this.clientId) ?? null;
    if (options.siteLogin) { this.ready = Promise.resolve(); return; }
    this.ready = this.restoreSaved();
  }

  private async revoke(token: string, clientId = this.clientId): Promise<void> {
    if (!/^[a-zA-Z0-9]{1,2048}$/.test(token) || !/^[a-zA-Z0-9]{1,128}$/.test(clientId)) return;
    try {
      const response = await (this.options.fetch ?? fetch)('https://id.twitch.tv/oauth2/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, token }), credentials: 'omit',
        referrerPolicy: 'no-referrer', redirect: 'error', keepalive: true, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok && response.status !== 400) console.error('[Twitch] Token revocation was not confirmed.');
    } catch { console.error('[Twitch] Token revocation was not confirmed.'); }
  }
  private purgeLegacyCredentials(): void {
    try {
      const key = 'noitamap-guessr-twitch-tab-v2:' + this.clientId, raw = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      const saved = raw && raw.length < 4096 ? JSON.parse(raw) : null;
      if (typeof saved?.token === 'string') void this.revoke(saved.token);
    } catch { /* Old transport credentials are never imported. */ }
    try {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(LEGACY_KEY));
      for (const key of keys) {
        const raw = localStorage.getItem(key); localStorage.removeItem(key);
        try {
          const saved = raw && raw.length < 4096 ? JSON.parse(raw) : null;
          if (typeof saved?.token === 'string') void this.revoke(saved.token, key.slice(LEGACY_KEY.length));
        } catch { /* Invalid old storage is simply removed. */ }
      }
    } catch { /* Storage may be unavailable. Never import an old credential. */ }
  }
  private forgetSaved(): void {
    try { sessionStorage.removeItem(STORAGE_KEY + this.clientId); } catch { /* Storage can be unavailable. */ }
  }
  private remember(credentials: Credentials): void {
    try { sessionStorage.setItem(STORAGE_KEY + this.clientId, JSON.stringify(credentials));
      localStorage.setItem(IDENTITY_KEY + this.clientId, JSON.stringify({ userId: credentials.userId })); }
    catch { /* A blocked/full store still permits this tab to use Twitch. */ }
  }
  private async restoreSaved(): Promise<void> {
    if (!this.configured) return;
    let saved: Credentials;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY + this.clientId);
      if (!raw) return;
      if (raw.length > 4096) throw Error();
      saved = JSON.parse(raw);
      if (!saved || typeof saved.token !== 'string' || !/^[a-zA-Z0-9]{1,2048}$/.test(saved.token)
        || typeof saved.userId !== 'string' || !/^\d{1,30}$/.test(saved.userId)
        || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= Date.now() + 5000) throw Error();
    } catch { this.forgetSaved(); return; }
    const generation = this.generation;
    let retry = false;
    this.update({ connecting: true, restoring: true, savedUserId: saved.userId });
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
      if (error instanceof TwitchViewerError && ['expired', 'validation'].includes(error.code)) {
        this.forgetSaved(); this.update({ savedUserId: null });
        this.update({ error: 'Could not restore Twitch access. Please sign in again.' });
      } else {
        retry = true;
        this.update({ error: 'Twitch identity verification is temporarily unavailable. Retrying…' });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (!this.disposed && generation === this.generation) void this.restoreSaved(); }, 30000);
      }
    } finally {
      if (generation === this.generation && !retry) this.update({ connecting: false, restoring: false });
    }
  }

  getState(): TwitchViewerState { return { ...this.state }; }
  get usesSiteLogin(): boolean { return !!this.options.siteLogin; }
  subscribe(listener: (state: TwitchViewerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => { this.listeners.delete(listener); };
  }
  private update(changes: Partial<TwitchViewerState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.getState());
  }

  setSiteSession(player: NonNullable<TwitchViewerOptions['siteIdentity']>, role: 'host' | 'account',
    authorize: NonNullable<TwitchViewerOptions['siteAuthorization']>): void {
    if (this.disposed) return;
    this.options.siteIdentity = player;
    this.options.siteAuthorization = authorize;
    this.options.siteRole = role;
    try { localStorage.setItem(IDENTITY_KEY + this.clientId, JSON.stringify({ userId: player.userId })); } catch {}
    this.update({ ...emptyState(), ...player, color: player.color, connected: true, savedUserId: player.userId });
  }

  siteConnectionFailed(): void {
    if (!this.disposed) this.update({ connecting: false, error: TWITCH_VERIFICATION_FAILED });
  }

  /** Call directly from the Connect button so the browser permits the popup. */
  connect(options: { announcements?: boolean; posting?: boolean } = {}): Promise<TwitchViewerState> {
    if (this.disposed) return Promise.reject(new TwitchViewerError('disconnected', 'This Twitch connection is closed.'));
    if (this.options.siteLogin && !this.state.connected && !options.posting && !options.announcements) {
      this.update({ connecting: true, error: null });
      return Promise.resolve(this.options.siteLogin()).finally(() => {
        if (!this.disposed && this.state.connecting) this.update({ connecting: false });
      }).then(() => this.getState());
    }
    if (this.options.siteIdentity && this.options.siteAuthorization) return this.options.siteAuthorization().then(() => {
      this.update({ ...this.options.siteIdentity, connected: true, error: null }); return this.getState();
    });
    if (this.options.siteLogin && !options.posting && !options.announcements) {
      return Promise.resolve(this.options.siteLogin()).then(() => this.getState());
    }
    if (!this.configured) return Promise.reject(new TwitchViewerError('configuration', 'Twitch chat sending is not configured on this site.'));
    if (this.state.sending) return Promise.reject(new TwitchViewerError('busy', 'Wait for the current guess to finish sending.'));
    if (this.pending) return this.pending.promise;
    if (this.state.restoring) return this.ready.then(() => {
      if (this.state.connected) return this.getState();
      throw new TwitchViewerError('unavailable', 'Twitch identity verification is temporarily unavailable. Retrying…');
    });
    const requestedScopes = [...new Set([...this.requiredScopes,
      ...(options.posting || options.announcements ? SCOPES : []), ...(options.announcements ? [ANNOUNCEMENT_SCOPE] : [])])];
    if (this.#credentials && this.#credentials.expiresAt > Date.now() + 5000
      && requestedScopes.every(scope => this.#credentials!.scopes.includes(scope))) return Promise.resolve(this.getState());
    this.clearCredentials();
    const generation = ++this.generation;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
    authorize.search = new URLSearchParams({ response_type: 'token', client_id: this.clientId,
      redirect_uri: this.redirectUri, scope: requestedScopes.join(' '), state, force_verify: 'true' }).toString();
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
          if (!requestedScopes.every(scope => credentials.scopes.includes(scope)))
            throw new TwitchViewerError('validation', 'Authorize Twitch posting access.');
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
    if (!response.ok) throw new TwitchViewerError(response.status === 401 ? 'expired' : 'unavailable',
      response.status === 401 ? 'Twitch sign-in expired. Connect again before sending.' : 'Twitch identity verification is temporarily unavailable. Retrying…');
    const value = await response.json() as { client_id?: unknown; user_id?: unknown; login?: unknown; scopes?: unknown; expires_in?: unknown };
    const scopes = value.scopes == null && this.requiredScopes.length === 0 ? [] : value.scopes;
    if (value.client_id !== this.clientId || typeof value.user_id !== 'string' || !/^\d{1,30}$/.test(value.user_id)
      || expectedUserId !== undefined && value.user_id !== expectedUserId
      || typeof value.login !== 'string' || !/^[a-z0-9_]{1,25}$/.test(value.login)
      || !Array.isArray(scopes) || !this.requiredScopes.every(scope => (scopes as unknown[]).includes(scope))
      || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 5
      || !Number.isSafeInteger(Date.now() + value.expires_in * 1000))
      throw new TwitchViewerError('validation', this.requiredScopes.length === 0 ? 'Twitch could not verify your sign-in. Please connect again.' : 'Twitch sign-in did not match this app, account, or chat permission. Connect again.');
    return { token, userId: value.user_id, login: value.login, scopes: scopes as string[], checkedAt: Date.now(), expiresAt: Date.now() + value.expires_in * 1000 };
  }
  /** Local streamer testing uses the same direct announcement API as production. */
  canShare(announcements: boolean): boolean { return canShareGameLink(this.#credentials ?? undefined, announcements); }
  async postGameLink(channel: string, message: string, announcements: boolean): Promise<void> {
    const credentials = await this.currentCredentials();
    if (credentials.login !== channel) throw new TwitchViewerError('forbidden', 'Sign in as the streamer to share this game.');
    await postTwitchGameLink({ ...credentials, accessToken: credentials.token, clientId: this.clientId },
      credentials.userId, message, announcements, (url, init) => this.request(String(url), init ?? {}));
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
        if (error instanceof TwitchViewerError && ['expired', 'validation'].includes(error.code)) this.clearCredentials();
        else {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { void this.refreshValidation().catch(() => {}); }, 30000);
        }
        this.update({ error: error instanceof TwitchViewerError ? error.message : 'Twitch identity verification is temporarily unavailable. Retrying…' });
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
  /** Ephemeral first-frame authentication for the parallel game connection.
   * The coordinator validates it with Twitch and never stores the provider token. */
  async transportAuthorization(renew = false): Promise<ParallelAuthorization> {
    if (this.disposed || !this.state.connected) throw new TwitchViewerError('disconnected', 'Connect Twitch before sending a guess.');
    if (this.options.siteAuthorization) return { role: this.options.siteRole ?? 'host', ticket: await this.options.siteAuthorization(renew) };
    const credentials = renew ? await this.refreshValidation() : await this.currentCredentials();
    return { role: 'player', accessToken: credentials.token };
  }

  private clearCredentials(forget = true): void {
    clearTimeout(this.timer);
    this.#credentials = null;
    this.validation = null;
    if (forget) this.forgetSaved();
    this.update({ connected: false, userId: null, savedUserId: null, login: null, expiresAt: null, displayName: undefined, color: undefined });
  }
  disconnect(forget = true): void {
    if (forget) this.options.siteSignOut?.();
    this.options.siteIdentity = undefined;
    this.options.siteAuthorization = undefined;
    let revoked = this.#credentials?.token;
    if (forget && !revoked) try {
      const raw = sessionStorage.getItem(STORAGE_KEY + this.clientId);
      const saved = raw && raw.length < 4096 ? JSON.parse(raw) : null;
      if (typeof saved?.token === 'string') revoked = saved.token;
    } catch { /* Corrupt storage has no token to revoke. */ }
    this.generation++;
    const pending = this.pending;
    this.pending = null;
    if (pending) { pending.cleanup(); pending.reject(new TwitchViewerError('disconnected', 'Twitch connection cancelled.')); }
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.clearCredentials(forget);
    if (forget) {
      try { localStorage.removeItem(IDENTITY_KEY + this.clientId); } catch { /* Optional public identity. */ }
      if (revoked) void this.revoke(revoked);
    }
    this.update({ connecting: false, restoring: false, sending: false, error: null });
  }
  dispose(): void { this.disposed = true; this.disconnect(false); this.listeners.clear(); this.options.onDispose?.(); }
}
