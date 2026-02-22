/**
 * Auth Service - Manages Twitch authentication state
 */

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  isFollower: boolean;
  isSubscriber: boolean;
}

// Auth worker URL (configure based on environment)
const AUTH_WORKER_URL =
  window.location.hostname === 'localhost' || window.location.hostname.includes('dev.')
    ? 'https://noitamap-auth-dev.wuote.workers.dev'
    : 'https://noitamap-auth.wuote.workers.dev';

// Local storage keys for session backup
const SESSION_KEY = 'noitamap_session';
const JWT_KEY = 'noitamap_jwt';

class AuthService {
  private state: AuthState = {
    authenticated: false,
    username: null,
    isFollower: false,
    isSubscriber: false,
  };

  private listeners: Set<(state: AuthState) => void> = new Set();

  /**
   * Initialize auth state from URL params or cookie
   */
  async init(): Promise<AuthState> {
    // Check if we're returning from OAuth
    const urlParams = new URLSearchParams(window.location.search);
    const authResult = urlParams.get('auth');
    const sessionFromUrl = urlParams.get('session');
    const tokenFromUrl = urlParams.get('token');

    if (authResult === 'success' && sessionFromUrl) {
      // Store session in localStorage as backup
      localStorage.setItem(SESSION_KEY, sessionFromUrl);
      if (tokenFromUrl) {
        localStorage.setItem(JWT_KEY, tokenFromUrl);
      }

      // Clean URL params
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('auth');
      cleanUrl.searchParams.delete('session');
      cleanUrl.searchParams.delete('token');
      window.history.replaceState({}, '', cleanUrl.toString());
    }

    // Check auth status
    await this.checkAuth();
    return this.state;
  }

  /**
   * Check authentication status with the auth worker
   */
  async checkAuth(): Promise<AuthState> {
    try {
      // Get session from localStorage
      const storedSession = localStorage.getItem(SESSION_KEY);

      // Build check URL with session if available
      const checkUrl = new URL(`${AUTH_WORKER_URL}/auth/check`);
      if (storedSession) {
        checkUrl.searchParams.set('session', storedSession);
      }

      const response = await fetch(checkUrl.toString(), {
        credentials: 'include',
        headers: storedSession
          ? {
              Authorization: `Bearer ${storedSession}`,
            }
          : {},
      });

      if (response.ok) {
        const data = await response.json();
        if (data.token) {
          localStorage.setItem(JWT_KEY, data.token);
        }
        this.state = {
          authenticated: data.authenticated,
          username: data.username || null,
          isFollower: data.isFollower || false,
          isSubscriber: data.isSubscriber || false,
        };
      } else {
        this.state = {
          authenticated: false,
          username: null,
          isFollower: false,
          isSubscriber: false,
        };
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.state = {
        authenticated: false,
        username: null,
        isFollower: false,
        isSubscriber: false,
      };
    }

    this.notifyListeners();
    return this.state;
  }

  /**
   * Start login flow - redirects to Twitch OAuth
   */
  login(): void {
    // Include current URL as redirect destination
    const redirectUrl = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_WORKER_URL}/auth/login?redirect=${redirectUrl}`;
  }

  /**
   * Logout - clear session
   */
  async logout(): Promise<void> {
    try {
      const storedSession = localStorage.getItem(SESSION_KEY);

      await fetch(`${AUTH_WORKER_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: storedSession
          ? {
              Authorization: `Bearer ${storedSession}`,
            }
          : {},
      });
    } catch (error) {
      console.error('Logout request failed:', error);
    }

    // Clear local storage regardless
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(JWT_KEY);

    this.state = {
      authenticated: false,
      username: null,
      isFollower: false,
      isSubscriber: false,
    };

    this.notifyListeners();
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
    this.listeners.forEach(listener => listener(state));
  }
}

// Singleton instance
export const authService = new AuthService();
