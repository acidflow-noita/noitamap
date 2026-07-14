/**
 * Auth Service - Manages authentication state (currently via Patreon OAuth)
 * Stateless JWT-only auth — tokens expire after 24 hours.
 */

import i18next from "../i18n";

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  nickname: string | null;
  isFollower: boolean;
  isSubscriber: boolean;
  provider: "patreon" | "twitch" | null;
}

// Auth worker URL (configure based on environment).
// Default: localhost + dev.* -> deployed dev worker; prod -> prod worker.
// To test a LOCAL `wrangler dev` worker, set in the browser console:
//   localStorage.setItem("noitamap_auth_worker", "http://localhost:8787")
// then reload. Clear it (removeItem) to go back to the deployed dev worker.
// The override only applies on localhost so it can never affect prod users.
function resolveAuthWorkerUrl(): string {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) {
    const override = localStorage.getItem("noitamap_auth_worker");
    if (override) return override;
  }
  return isLocal || host.includes("dev.")
    ? "https://noitamap-auth-dev.wuote.workers.dev"
    : "https://noitamap-auth.wuote.workers.dev";
}

const AUTH_WORKER_URL = resolveAuthWorkerUrl();

const JWT_KEY = "noitamap_jwt";
// Long-lived refresh JWT (carries the provider refresh_token, encrypted by the
// worker). Used to silently re-mint the access JWT so sessions survive past the
// 24h access-token expiry without a re-login.
const REFRESH_KEY = "noitamap_refresh_jwt";

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
  }

  /**
   * Initialize auth state from URL params or stored token.
   *
   * Current Workers return credentials in the URL fragment. The legacy query
   * format remains accepted during deployment rollout; both forms are scrubbed
   * from the address bar immediately after they are read.
   */
  async init(): Promise<AuthState> {
    const cleanUrl = new URL(window.location.href);
    let shouldUpdateUrl = false;

    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const urlParams = new URLSearchParams(window.location.search);
    const fromHash = hashParams.get("auth") === "success" && hashParams.get("token");
    const authResult = fromHash ? "success" : urlParams.get("auth");
    const tokenFromUrl = fromHash ? hashParams.get("token") : urlParams.get("token");
    const refreshFromUrl = fromHash ? hashParams.get("refresh_token") : urlParams.get("refresh_token");
    const errorFromUrl = urlParams.get("auth_error");

    if (errorFromUrl) {
      console.error("Auth Error:", errorFromUrl);
      cleanUrl.searchParams.delete("auth_error");
      shouldUpdateUrl = true;
    }

    if (authResult === "success" && tokenFromUrl) {
      localStorage.setItem(JWT_KEY, tokenFromUrl);
      if (refreshFromUrl) localStorage.setItem(REFRESH_KEY, refreshFromUrl);
      else localStorage.removeItem(REFRESH_KEY);
      if (fromHash) {
        cleanUrl.hash = "";
      } else {
        cleanUrl.searchParams.delete("auth");
        cleanUrl.searchParams.delete("token");
        cleanUrl.searchParams.delete("refresh_token");
      }
      shouldUpdateUrl = true;
    }

    if (shouldUpdateUrl) {
      window.history.replaceState({}, "", cleanUrl.toString());
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
  async checkAuth(): Promise<AuthState> {
    try {
      const storedToken = localStorage.getItem(JWT_KEY);
      if (!storedToken) {
        // No access token — try to mint one from the refresh token.
        if (await this.tryRefresh()) return this.state;
        return this.setUnauthenticated();
      }

      const response = await fetch(`${AUTH_WORKER_URL}/auth/check`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) {
          this.applyAuthData(data);
          return this.state;
        }
        // Access token rejected (expired) — attempt silent renewal.
        localStorage.removeItem(JWT_KEY);
        if (await this.tryRefresh()) return this.state;
        return this.setUnauthenticated();
      }

      // Worker error on /auth/check — try refresh as a fallback, else drop.
      if (await this.tryRefresh()) return this.state;
      localStorage.removeItem(JWT_KEY);
      return this.setUnauthenticated();
    } catch (error) {
      console.error("Auth check failed:", error);
      return this.setUnauthenticated();
    }
  }

  /**
   * Exchange the stored refresh JWT for a fresh access+refresh pair. Returns
   * true and updates state on success; false (and clears tokens) on failure.
   */
  private async tryRefresh(): Promise<boolean> {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${AUTH_WORKER_URL}/auth/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${refreshToken}` },
      });
      if (!res.ok) return false;
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
  }): void {
    this.state = {
      authenticated: true,
      username: data.username || null,
      nickname: data.vanity || data.nickname || null,
      isFollower: data.isFollower || false,
      isSubscriber: data.isSubscriber || false,
      provider: data.provider || null,
    };
    this.notifyListeners();
  }

  private setUnauthenticated(): AuthState {
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
   * Sessions are single-provider: signing in with the other provider replaces
   * the current session, and Pro follows the new provider's sub. Warn first.
   */
  private confirmProviderSwitch(next: "patreon" | "twitch"): boolean {
    const current = this.state.provider;
    if (!this.state.authenticated || !current || current === next) return true;
    const labels = { patreon: "Patreon", twitch: "Twitch" };
    return window.confirm(
      i18next.t("auth.switchProviderConfirm", {
        defaultValue:
          "Signing in with {{next}} will sign you out of {{current}}.\n\nPro access will then be based on your {{next}} subscription.\n\nSwitch to {{next}}?",
        current: labels[current],
        next: labels[next],
      }),
    );
  }

  /**
   * Start login flow - redirects to OAuth provider
   */
  login(): void {
    if (!this.confirmProviderSwitch("patreon")) return;
    const redirectUrl = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_WORKER_URL}/auth/login?redirect=${redirectUrl}`;
  }

  /**
   * Start Twitch login flow (UI entry points are gated by TWITCH_ENABLED).
   */
  loginTwitch(): void {
    if (!this.confirmProviderSwitch("twitch")) return;
    const redirectUrl = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_WORKER_URL}/auth/twitch/login?redirect=${redirectUrl}`;
  }

  /**
   * Logout - clear token and reset state
   */
  async logout(): Promise<void> {
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(REFRESH_KEY);
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
