/**
 * Auth UI - Login button component for navbar
 */

import { authService, AuthState } from './auth-service';
import i18next from '../i18n';

/**
 * Create and manage the auth button in the navbar
 */
export class AuthUI {
  private container: HTMLElement;
  private button: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.init();
  }

  private async init(): Promise<void> {
    // Create initial button
    this.button = this.createButton();
    this.container.appendChild(this.button);

    // Subscribe to auth changes
    authService.subscribe(state => this.updateButton(state));

    // Initialize auth state
    const state = await authService.init();
    this.updateButton(state);
  }

  private createButton(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.id = 'auth-button-wrapper';
    wrapper.className = 'me-2';
    wrapper.innerHTML = `
      <button id="authButton" class="btn btn-sm btn-outline-light" type="button">
        <i class="bi bi-twitch me-1"></i>
        <span class="auth-text">${i18next.t('auth.signIn')}</span>
      </button>
    `;

    const button = wrapper.querySelector('#authButton') as HTMLElement;
    button.addEventListener('click', () => this.handleClick());

    return wrapper;
  }

  private updateButton(state: AuthState): void {
    if (!this.button) return;

    const btn = this.button.querySelector('#authButton') as HTMLElement;
    const textEl = this.button.querySelector('.auth-text') as HTMLElement;
    const icon = this.button.querySelector('i') as HTMLElement;

    if (state.authenticated) {
      // Show username with dropdown
      btn.className = 'btn btn-sm btn-outline-success dropdown-toggle';
      btn.setAttribute('data-bs-toggle', 'dropdown');
      btn.setAttribute('aria-expanded', 'false');
      textEl.textContent = state.username || 'User';
      icon.className = 'bi bi-person-check me-1';

      // Create dropdown menu if not exists
      let dropdown = this.button.querySelector('.dropdown-menu');
      if (!dropdown) {
        dropdown = document.createElement('ul');
        dropdown.className = 'dropdown-menu dropdown-menu-end';
        dropdown.innerHTML = `
          <li><span class="dropdown-item-text text-muted small">${i18next.t('auth.signedInAs')} <strong>${state.username}</strong></span></li>
          <li><hr class="dropdown-divider"></li>
          ${state.isFollower ? `<li><span class="dropdown-item-text"><i class="bi bi-heart-fill text-danger me-1"></i>${i18next.t('auth.follower')}</span></li>` : ''}
          ${state.isSubscriber ? `<li><span class="dropdown-item-text"><i class="bi bi-star-fill text-warning me-1"></i>${i18next.t('auth.subscriber')}</span></li>` : ''}
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" id="logoutBtn"><i class="bi bi-box-arrow-right me-1"></i>${i18next.t('auth.signOut')}</button></li>
        `;
        this.button.appendChild(dropdown);
        this.button.classList.add('dropdown');

        // Bind logout handler
        const logoutBtn = dropdown.querySelector('#logoutBtn');
        logoutBtn?.addEventListener('click', e => {
          e.preventDefault();
          this.handleLogout();
        });
      } else {
        // Update existing dropdown
        const usernameEl = dropdown.querySelector('.dropdown-item-text strong');
        if (usernameEl) usernameEl.textContent = state.username || 'User';
      }
    } else {
      // Show sign in button
      btn.className = 'btn btn-sm btn-outline-light';
      btn.removeAttribute('data-bs-toggle');
      btn.removeAttribute('aria-expanded');
      textEl.textContent = i18next.t('auth.signIn');
      icon.className = 'bi bi-twitch me-1';
      this.button.classList.remove('dropdown');

      // Remove dropdown if exists
      const dropdown = this.button.querySelector('.dropdown-menu');
      if (dropdown) dropdown.remove();
    }
  }

  private handleClick(): void {
    const state = authService.getState();
    if (!state.authenticated) {
      authService.login();
    }
    // If authenticated, dropdown handles the interaction
  }

  private async handleLogout(): Promise<void> {
    await authService.logout();
  }
}

/**
 * Check if user has permission to use drawing feature
 * For now, allow all authenticated users
 */
export function canUseDraw(): boolean {
  return authService.isAuthenticated();
}

/**
 * Show login prompt for drawing feature
 */
export function showLoginPrompt(): void {
  const confirmed = confirm(
    'Sign in with Twitch to use drawing tools.\n\nDrawings are saved locally and can be shared via URL.\n\nWould you like to sign in?'
  );
  if (confirmed) {
    authService.login();
  }
}
