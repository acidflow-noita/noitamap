/**
 * Auth Service - Manages authentication state (currently via Patreon OAuth)
 * Stateless JWT-only auth — tokens expire after 24 hours.
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
   * Initialize auth state from URL params or stored token
   */
  async init(): Promise<AuthState> {
    const cleanUrl = new URL(window.location.href);
    let shouldUpdateUrl = false;

    const urlParams = new URLSearchParams(window.location.search);
    const authResult = urlParams.get('auth');
    const tokenFromUrl = urlParams.get('token');
    const errorFromUrl = urlParams.get('auth_error');

    if (errorFromUrl) {
      console.error('Auth Error:', errorFromUrl);
      cleanUrl.searchParams.delete('auth_error');
      shouldUpdateUrl = true;
    }

    if (authResult === 'success' && tokenFromUrl) {
      localStorage.setItem(JWT_KEY, tokenFromUrl);
      cleanUrl.searchParams.delete('auth');
      cleanUrl.searchParams.delete('token');
      shouldUpdateUrl = true;
    }

    if (shouldUpdateUrl) {
      window.history.replaceState({}, '', cleanUrl.toString());
    }

    await this.checkAuth();
    return this.state;
  }

  /**
   * Check authentication status with the auth worker
   */
  async checkAuth(): Promise<AuthState> {
    try {
      const storedToken = localStorage.getItem(JWT_KEY);
      if (!storedToken) {
        this.state = {
          authenticated: false,
          username: null,
          isFollower: false,
          isSubscriber: false,
        };
        this.notifyListeners();
        return this.state;
      }

      const response = await fetch(`${AUTH_WORKER_URL}/auth/check`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      });

      if (response.ok) {
        const data = await response.json();
        this.state = {
          authenticated: data.authenticated,
          username: data.username || null,
          isFollower: data.isFollower || false,
          isSubscriber: data.isSubscriber || false,
        };
        if (!data.authenticated) {
          localStorage.removeItem(JWT_KEY);
        }
      } else {
        localStorage.removeItem(JWT_KEY);
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
   * Start login flow - redirects to OAuth provider
   */
  login(): void {
    const redirectUrl = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_WORKER_URL}/auth/login?redirect=${redirectUrl}`;
  }

  /**
   * Logout - clear token and reset state
   */
  async logout(): Promise<void> {
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
