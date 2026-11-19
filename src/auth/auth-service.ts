/**
 * Shared Patreon/Twitch sign-in, durable account connections and Pro access.
 */

import i18next from "../i18n";
import { HARD_PUZZLE_POLL_PATH, type GuessrBallot, type PollChoice } from '../../workers/noitamap-auth/src/poll-contract';
import { LoginReturn } from './login-return';
import { beginBrowserLogin, cancelBrowserLogin, consumeBrowserLogin } from './browser-login';

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  nickname: string | null;
  isFollower: boolean;
  isSubscriber: boolean;
  provider: "patreon" | "twitch" | null;
  accountId?: string;
  linkingAvailable?: boolean;
  linkedAccounts?: LinkedAccount[];
}

export interface LinkedAccount {
  provider: 'patreon' | 'twitch';
  userId: string;
  username: string;
  login: string | null;
  isFollower: boolean;
  isSubscriber: boolean;
  membershipStatus: 'active' | 'inactive' | 'reconnect' | 'stale';
  checkedAt: number;
}

export interface TwitchChatSession {
  accessToken: string;
  clientId: string;
  userId: string;
  login: string;
  /** Unix timestamp in milliseconds. Keep the access token in memory only. */
  expiresAt: number;
  scopes?: string[];
}
export interface PlayerTicket {
  token: string; expiresAt: number;
  player: { userId: string; login: string; displayName: string; color?: string };
}

// Auth worker URL (configure based on environment).
// Default: localhost + dev.* -> deployed dev worker; prod -> prod worker.
// To test a LOCAL `wrangler dev` worker, set in the browser console:
//   localStorage.setItem("noitamap_auth_worker", "http://localhost:8787")
// then reload. Clear it (removeItem) to go back to the deployed dev worker.
// The override only applies on localhost so it can never affect prod users.
export function resolveAuthWorkerUrl(host = window.location.hostname): string {
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) {
    let override: string | null = null;
    try { override = localStorage.getItem("noitamap_auth_worker"); } catch { /* Storage may be unavailable. */ }
    if (override) try {
      const url = new URL(override);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return url.origin;
    } catch { /* Ignore malformed local-only overrides. */ }
  }
  return ['dynamic-map.noitamap.com', 'noitamap.com'].includes(host)
    ? 'https://noitamap-auth.wuote.workers.dev'
    : 'https://noitamap-auth-dev.wuote.workers.dev';
}

const AUTH_WORKER_URL = resolveAuthWorkerUrl();

const JWT_KEY = "noitamap_jwt";
// Rotating session reference. Provider credentials remain in the auth Worker.
const REFRESH_KEY = "noitamap_refresh_jwt";
const PENDING_LINK_KEY = 'noitamap_pending_account_link';

class AuthService {
  private state: AuthState = {
    authenticated: false,
    username: null,
    nickname: null,
    isFollower: false,
    isSubscriber: false,
    provider: null,
  };

  private listeners: Set<(state: AuthState) => void> = new Set();
  private loginReturn = new LoginReturn();
  private loginPending = false;
  private refreshPending?: Promise<boolean>;
  private membershipPending?: Promise<AuthState>;
  private membershipCheckedAt = 0;
  private playerTicket?: PlayerTicket;
  private playerTicketPending?: Promise<PlayerTicket>;
  private sessionGeneration = 0;

  registerLoginPreparation = this.loginReturn.register.bind(this.loginReturn);
  getLoginReturnState = this.loginReturn.get.bind(this.loginReturn);
  completeLoginReturnState = this.loginReturn.complete.bind(this.loginReturn);

  /**
   * Resolves once `init()` has finished (success or failure). Code that needs
   * the definitively-resolved auth state (e.g., gated URL-param features)
   * should await this instead of relying on subscribe(), since subscribe()
   * may be registered AFTER the initial notifyListeners() call.
   */
  ready: Promise<AuthState>;
  private resolveReady!: (state: AuthState) => void;

  constructor() {
    this.ready = new Promise<AuthState>((resolve) => { this.resolveReady = resolve; });
    window.addEventListener('pageshow', event => {
      if (event.persisted) { this.loginReturn.discardUnreturned(); sessionStorage.removeItem(PENDING_LINK_KEY); }
    });
    let storageRefresh: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('storage', event => {
      if (event.key !== JWT_KEY && event.key !== REFRESH_KEY) return;
      this.playerTicket = undefined;
      clearTimeout(storageRefresh);
      storageRefresh = setTimeout(() => { void this.checkAuth(); }, 50);
    });
  }

  /** Credentials are scrubbed and nonce-checked by the blocking bootstrap. */
  async init(): Promise<AuthState> {
    const cleanUrl = new URL(window.location.href);
    let shouldUpdateUrl = false;
    const returned = consumeBrowserLogin();
    const linkToken = returned?.linkToken;
    if (returned?.error) {
      console.error('Auth Error:', returned.error);
      sessionStorage.removeItem(PENDING_LINK_KEY);
    }

    if (this.loginReturn.arrive(cleanUrl)) shouldUpdateUrl = true;

    if (shouldUpdateUrl) {
      window.history.replaceState({}, "", cleanUrl.toString());
    }

    if (linkToken) {
      try {
        const expectedAccount = sessionStorage.getItem(PENDING_LINK_KEY);
        sessionStorage.removeItem(PENDING_LINK_KEY);
        await this.checkAuth();
        if (!expectedAccount || this.state.accountId !== expectedAccount) throw new Error('Start this account connection from your signed-in account.');
        const preview = await this.accountRequest('/auth/link/review', { linkToken });
        if (!preview.ok) throw new Error('Could not review this account connection.');
        const { confirmAccountLink } = await import('./confirm-link');
        if (!await confirmAccountLink(await preview.json())) { await this.checkAuth(); this.resolveReady(this.state); return this.state; }
        const response = await this.accountRequest('/auth/link/complete', { linkToken, confirmed: true });
        const data = await response.json();
        if (!response.ok || !data.token) throw new Error(data.error || 'Could not connect this account.');
        this.storeSession(data);
      } catch (error) {
        const { authSecurityMessage } = await import('./security-messages');
        window.alert(await authSecurityMessage(error instanceof Error ? error.message : 'Could not connect this account.'));
      }
    }

    await this.checkAuth();
    this.resolveReady(this.state);
    return this.state;
  }

  /**
   * Check authentication status with the auth worker. If the access token is
   * missing or expired, transparently try /auth/refresh with the stored refresh
   * JWT before giving up — this is what keeps sessions alive past 24h without a
   * re-login. Sub status is re-evaluated server-side on each refresh.
   */
  async checkAuth(retryChangedSession = true): Promise<AuthState> {
    const generation = this.sessionGeneration;
    try {
      const storedToken = localStorage.getItem(JWT_KEY);
      if (!storedToken) {
        // No access token — try to mint one from the refresh token.
        if (await this.tryRefresh()) return this.state;
        if (this.sessionGeneration !== generation) return this.getState();
        return this.setUnauthenticated();
      }

      const response = await fetch(`${AUTH_WORKER_URL}/auth/check`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      });
      if (this.sessionGeneration !== generation) return this.getState();
      if (localStorage.getItem(JWT_KEY) !== storedToken) return retryChangedSession ? this.checkAuth(false) : this.getState();

      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) {
          if (data.token) this.storeSession(data);
          else this.applyAuthData(data);
          return this.state;
        }
        // Access token rejected (expired) — attempt silent renewal.
        if (localStorage.getItem(JWT_KEY) === storedToken) localStorage.removeItem(JWT_KEY);
        if (await this.tryRefresh()) return this.state;
        return this.setUnauthenticated();
      }

      // Worker error on /auth/check — try refresh as a fallback, else drop.
      if (await this.tryRefresh()) return this.state;
      if (response.status === 401 && localStorage.getItem(JWT_KEY) === storedToken) localStorage.removeItem(JWT_KEY);
      return this.setUnauthenticated();
    } catch (error) {
      console.error("Auth check failed:", error);
      if (this.sessionGeneration !== generation) return this.getState();
      return this.setUnauthenticated();
    }
  }

  /** Explicit or pre-access membership refresh, bounded in this tab and by the
   * server's per-account rate limit and shared provider-check cooldown. */
  refreshMembership(): Promise<AuthState> {
    if (!this.state.authenticated) return Promise.resolve(this.getState());
    if (this.membershipPending) return this.membershipPending;
    if (Date.now() - this.membershipCheckedAt < 30000) return Promise.resolve(this.getState());
    const owner = this.state.accountId, generation = this.sessionGeneration;
    this.membershipPending = (async () => {
      const response = await this.accountRequest('/auth/membership/refresh', {});
      if (!response.ok) throw new Error('Could not refresh Pro status. Try again shortly.');
      const data = await response.json();
      if (!this.state.authenticated || this.state.accountId !== owner || this.sessionGeneration !== generation) throw new Error('Sign in to continue.');
      if (!data.authenticated || typeof data.token !== 'string') throw new Error('Could not refresh Pro status. Try again shortly.');
      this.storeSession(data); this.membershipCheckedAt = Date.now(); return this.getState();
    })().finally(() => { this.membershipPending = undefined; });
    return this.membershipPending;
  }

  /** Participant tickets stay in memory and never authorize Pro/host actions. */
  async getPlayerTicket(): Promise<PlayerTicket> {
    const owner = this.state.accountId;
    const generation = this.sessionGeneration;
    if (!this.state.authenticated || !owner) throw new Error('Sign in to continue.');
    if (this.playerTicket && this.playerTicket.expiresAt > Date.now() + 90000) return this.playerTicket;
    return this.playerTicketPending ??= (async () => {
      const response = await this.accountRequest('/auth/player-ticket', {});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Sign in to continue.');
      if (!this.state.authenticated || this.state.accountId !== owner || this.sessionGeneration !== generation) throw new Error('Sign in to continue.');
      if (typeof data.token !== 'string' || !Number.isFinite(data.expiresAt) || !/^\d{1,30}$/.test(data.player?.userId ?? '')
        || !/^[a-z0-9_]{1,25}$/.test(data.player?.login ?? '') || typeof data.player?.displayName !== 'string') throw new Error('Sign in to continue.');
      this.playerTicket = data; return data as PlayerTicket;
    })().finally(() => { this.playerTicketPending = undefined; });
  }

  /** Exchange the stored refresh reference for a fresh registered session. */
  private tryRefresh(): Promise<boolean> {
    const refresh = async () => navigator.locks
      ? await navigator.locks.request('noitamap-session-refresh', () => this.refreshSession())
      : await this.refreshSession();
    return this.refreshPending ??= refresh().finally(() => { this.refreshPending = undefined; });
  }

  private async refreshSession(retry = true): Promise<boolean> {
    const generation = this.sessionGeneration;
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${AUTH_WORKER_URL}/auth/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${refreshToken}` },
      });
      if (this.sessionGeneration !== generation) return this.state.authenticated;
      if (localStorage.getItem(REFRESH_KEY) !== refreshToken)
        return retry && localStorage.getItem(REFRESH_KEY) ? this.refreshSession(false) : this.state.authenticated;
      if (res.status === 409 && retry && localStorage.getItem(REFRESH_KEY) !== refreshToken) return this.refreshSession(false);
      if (!res.ok) {
        if (res.status === 401 && localStorage.getItem(REFRESH_KEY) === refreshToken) {
          localStorage.removeItem(JWT_KEY); localStorage.removeItem(REFRESH_KEY);
        }
        return false;
      }
      const data = await res.json();
      if (!data.authenticated || !data.token) {
        // Refresh token is dead (revoked/expired) — clear it so we stop trying.
        localStorage.removeItem(REFRESH_KEY);
        return false;
      }
      localStorage.setItem(JWT_KEY, data.token);
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
      this.applyAuthData(data);
      return true;
    } catch (error) {
      console.error("Silent refresh failed:", error);
      return false;
    }
  }

  private applyAuthData(data: {
    username?: string;
    vanity?: string;
    nickname?: string;
    isFollower?: boolean;
    isSubscriber?: boolean;
    provider?: "patreon" | "twitch";
    accountId?: string;
    linkingAvailable?: boolean;
    linkedAccounts?: LinkedAccount[];
  }): void {
    this.state = {
      authenticated: true,
      username: data.username || null,
      nickname: data.vanity || data.nickname || null,
      isFollower: data.isFollower || false,
      isSubscriber: data.isSubscriber || false,
      provider: data.provider || null,
      accountId: data.accountId,
      linkingAvailable: data.linkingAvailable ?? !!data.accountId,
      linkedAccounts: data.linkedAccounts,
    };
    this.notifyListeners();
  }

  private setUnauthenticated(): AuthState {
    this.sessionGeneration++;
    this.playerTicket = undefined; this.membershipCheckedAt = 0;
    this.state = {
      authenticated: false,
      username: null,
      nickname: null,
      isFollower: false,
      isSubscriber: false,
      provider: null,
    };
    this.notifyListeners();
    return this.state;
  }

  /**
   * Start login flow - redirects to OAuth provider
   */
  login(): void {
    void this.redirectToLogin('patreon');
  }

  /**
   * Start Twitch login flow (UI entry points are gated by TWITCH_ENABLED).
   */
  loginTwitch(): void {
    void this.redirectToLogin('twitch');
  }

  /** Announcement permission is optional and selected during streamer setup. */
  async connectTwitchChat(options: { announcements?: boolean } = {}): Promise<void> {
    await this.redirectToLogin('twitch', true, options.announcements === true);
  }

  async getTwitchChatSession(): Promise<TwitchChatSession | null> {
    const response = await this.accountRequest('/auth/twitch/chat-session');
    if (response.status === 401 || response.status === 409) return null;
    if (!response.ok) throw new Error('Twitch chat connection is temporarily unavailable.');
    return response.json();
  }

  async unlink(provider: 'patreon' | 'twitch'): Promise<void> {
    const response = await this.accountRequest('/auth/unlink', { provider });
    const data = await response.json();
    if (!response.ok) {
      const { authSecurityMessage } = await import('./security-messages');
      throw new Error(await authSecurityMessage(data.error || '', 'Could not disconnect this account.'));
    }
    this.clearSession();
  }

  private storeSession(data: { token: string; refresh_token?: string } & Parameters<AuthService['applyAuthData']>[0]): void {
    localStorage.setItem(JWT_KEY, data.token);
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
    this.applyAuthData(data);
  }

  async guessrBallot(choice?: PollChoice, expectedAccount?: string): Promise<GuessrBallot | null> {
    const owner = this.state.accountId;
    if (choice && (!owner || owner !== expectedAccount)) throw new Error('Sign in to vote.');
    const response = owner
      ? await this.accountRequest(HARD_PUZZLE_POLL_PATH, choice ? { choice } : undefined, owner)
      : await fetch(AUTH_WORKER_URL + HARD_PUZZLE_POLL_PATH, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (this.state.accountId !== owner) throw new Error('Your account changed. Reopen the poll.');
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error('Sign in to vote.');
    if (!response.ok && response.status !== 409) throw new Error('The poll is unavailable. Try again.');
    const ballot = await response.json() as GuessrBallot;
    if (!ballot || !['open', 'scheduled', 'closed'].includes(ballot.phase)
      || !Number.isSafeInteger(ballot.opensAt) || !Number.isSafeInteger(ballot.closesAt) || !Number.isSafeInteger(ballot.serverNow)
      || ballot.closesAt <= ballot.opensAt || ![null, 'yes', 'no'].includes(ballot.vote))
      throw new Error('The poll is unavailable. Try again.');
    if (choice && ballot.phase === 'open' && !ballot.vote) throw new Error('Your vote could not be confirmed. Please retry.');
    return ballot;
  }

  private async accountRequest(path: string, body?: Record<string, unknown>, expectedAccount?: string): Promise<Response> {
    const send = () => {
      if (expectedAccount && this.state.accountId !== expectedAccount) throw new Error('Your account changed. Reopen the poll.');
      return fetch(`${AUTH_WORKER_URL}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.getToken() || ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(expectedAccount ? { signal: AbortSignal.timeout(15000) } : {}),
      });
    };
    let response = await send();
    if (response.status === 401 && await this.tryRefresh()) response = await send();
    return response;
  }

  private async redirectToLogin(provider: 'patreon' | 'twitch', chat = false, announcements = false): Promise<void> {
    if (this.loginPending) return;
    this.loginPending = true;
    let workspacePrepared = false;
    try {
      if (this.loginReturn.get('drawing')) throw new Error('The previous drawing workspace is still being restored');
      const returnUrl = beginBrowserLogin(await this.loginReturn.prepare());
      workspacePrepared = true;
      if (this.state.authenticated) {
        if (!this.state.accountId) throw new Error('Sign in again before connecting another account.');
        const response = await this.accountRequest('/auth/link/start', { provider, redirect: returnUrl, chat, announcements });
        const data = await response.json();
        if (!response.ok || !data.url) throw new Error(data.error || 'Could not start this account connection.');
        if (!this.state.accountId) throw new Error('Account connections are not available yet.');
        sessionStorage.setItem(PENDING_LINK_KEY, this.state.accountId);
        window.location.href = data.url;
        return;
      }
      const path = provider === 'twitch' ? '/auth/twitch/login' : '/auth/login';
      window.location.href = `${AUTH_WORKER_URL}${path}?redirect=${encodeURIComponent(returnUrl)}${chat ? '&chat=1' : ''}${chat && announcements ? '&announcements=1' : ''}`;
    } catch (error) {
      console.error('[Auth] Could not start sign-in:', error);
      this.loginReturn.discardUnreturned();
      cancelBrowserLogin();
      sessionStorage.removeItem(PENDING_LINK_KEY);
      const { authSecurityMessage } = await import('./security-messages');
      const message = error instanceof Error ? error.message : '';
      window.alert(!workspacePrepared && !message.includes('still being restored')
        ? String(i18next.t('auth.workspaceSaveFailed', 'Could not save your workspace. Sign-in was cancelled. Please try again.'))
        : await authSecurityMessage(message, 'Could not start this account connection.'));
    } finally {
      this.loginPending = false;
    }
  }

  /**
   * Logout - clear token and reset state
   */
  async logout(): Promise<void> {
    const token = localStorage.getItem(REFRESH_KEY) || localStorage.getItem(JWT_KEY);
    try {
      if (token) {
        const response = await fetch(`${AUTH_WORKER_URL}/auth/logout`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) console.error('[Auth] Server logout was not confirmed.');
      }
    } catch { console.error('[Auth] Server logout was not confirmed.'); }
    finally { this.clearSession(); }
  }

  private clearSession(): void {
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(PENDING_LINK_KEY);
    this.setUnauthenticated();
  }

  /**
   * Get current auth state
   */
  getState(): AuthState {
    return { ...this.state };
  }

  /**
   * Get stored JWT token
   */
  getWorkerUrl(): string { return AUTH_WORKER_URL; }

  getToken(): string | null {
    return localStorage.getItem(JWT_KEY);
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.state.authenticated;
  }

  /**
   * Check if user is a follower
   */
  isFollower(): boolean {
    return this.state.isFollower;
  }

  /**
   * Check if user is a subscriber
   */
  isSubscriber(): boolean {
    return this.state.isSubscriber;
  }

  /**
   * Subscribe to auth state changes
   */
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}

// Singleton instance
export const authService = new AuthService();
