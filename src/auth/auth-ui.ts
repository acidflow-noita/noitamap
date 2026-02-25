/**
 * Auth UI - Login button and "Get Pro" modal for navbar
 */

import { authService, AuthState } from './auth-service';
import i18next from '../i18n';

// Official Patreon Symbol (White)
const PATREON_SYMBOL_WHITE = `
<svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <path fill="#ffffff" d="M1033.05,324.45c-0.19-137.9-107.59-250.92-233.6-291.7c-156.48-50.64-362.86-43.3-512.28,27.2
        C106.07,145.41,49.18,332.61,47.06,519.31c-1.74,153.5,13.58,557.79,241.62,560.67c169.44,2.15,194.67-216.18,273.07-321.33
        c55.78-74.81,127.6-95.94,216.01-117.82C929.71,603.22,1033.27,483.3,1033.05,324.45z"/>
</svg>`;

// Official Patreon Colors
const PATREON_COLOR = '#FF424D';
const PATREON_NAVY = '#052D49';

/**
 * Create and manage the auth button in the navbar
 */
export class AuthUI {
  private container: HTMLElement;
  private button: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.injectStyles();
    this.init();
  }

  private injectStyles(): void {
    const styleId = 'patreon-auth-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .btn-patreon {
        background-color: ${PATREON_COLOR};
        color: white;
        border: none;
        border-radius: 20px; /* Pill shape */
        padding: 8px 16px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: background-color 0.2s;
      }
      .btn-patreon:hover {
        background-color: #E63B45; /* Slightly darker coral */
        color: white;
      }
      .btn-patreon svg {
        width: 18px;
        height: 18px;
      }
      .btn-patreon-outline {
        background-color: transparent;
        color: ${PATREON_COLOR};
        border: 1px solid ${PATREON_COLOR};
        border-radius: 20px;
        padding: 8px 16px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: all 0.2s;
      }
      .btn-patreon-outline:hover {
        background-color: rgba(255, 66, 77, 0.1);
        color: ${PATREON_COLOR};
      }
    `;
    document.head.appendChild(style);
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
    // Initial state placeholder
    wrapper.innerHTML = `
      <button id="authButton" class="btn btn-sm btn-outline-light" type="button">
        <i class="bi bi-star me-1"></i>
        <span class="auth-text">${i18next.t('auth.getPro', 'Get Pro')}</span>
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
      // Reset content if it was replaced by Patreon button
      btn.innerHTML = `<i class="bi bi-person-check me-1"></i> <span class="auth-text">${i18next.t('auth.yourAccount', 'Your Account')}</span>`;
      
      // Create dropdown menu if not exists
      let dropdown = this.button.querySelector('.dropdown-menu');
      if (!dropdown) {
        dropdown = document.createElement('ul');
        dropdown.className = 'dropdown-menu dropdown-menu-end';
        dropdown.innerHTML = `
          ${state.isSubscriber
            ? `<li><span class="dropdown-item-text text-success small"><i class="bi bi-check-circle-fill me-1"></i>${i18next.t('auth.proActive', 'Pro active')}</span></li>`
            : `<li><a class="dropdown-item small" href="https://www.patreon.com/wuote/membership" target="_blank" rel="noopener noreferrer"><i class="bi bi-star me-1"></i>${i18next.t('auth.subscribeCta', 'Subscribe for Pro')}</a></li>`
          }
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" id="logoutBtn"><i class="bi bi-box-arrow-right me-1"></i>${i18next.t('auth.signOut', 'Sign Out')}</button></li>
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
        // Dropdown already exists, nothing to update
      }
    } else {
      // Show "Get Pro" button
      // We keep the "Get Pro" style for the navbar button to match the theme, 
      // but the MODAL will have the Patreon branded button.
      // Alternatively, we could make THIS button Patreon branded too?
      // "Get Pro" usually implies a call to action. 
      // Let's keep it as "Get Pro" (standard style) but the modal has the official login button.
      
      btn.className = 'btn btn-sm btn-outline-light';
      btn.removeAttribute('data-bs-toggle');
      btn.removeAttribute('aria-expanded');
      btn.innerHTML = `<i class="bi bi-star me-1"></i> <span class="auth-text">${i18next.t('auth.getPro', 'Get Pro')}</span>`;
      this.button.classList.remove('dropdown');

      // Remove dropdown if exists
      const dropdown = this.button.querySelector('.dropdown-menu');
      if (dropdown) dropdown.remove();
    }
  }

  public static showGetProModal(): void {
    // Remove existing modal if any
    const existing = document.getElementById('getProModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'getProModal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.setAttribute('aria-labelledby', 'getProModalLabel');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content bg-dark text-light">
          <div class="modal-header border-secondary">
            <h5 class="modal-title" id="getProModalLabel">
              <i class="bi bi-brush me-2"></i>${i18next.t('auth.proFeatures', 'Pro Features')}  
            </h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <p>${i18next.t('auth.proDescription', 'Drawing tools and other pro features are available to Patreon supporters.')}</p>
            <ul class="list-unstyled mb-3">
              <li class="mb-2"><i class="bi bi-brush me-2 text-info"></i>${i18next.t('auth.featureDrawing', 'Drawing & annotation tools')}</li>
              <li class="mb-2"><i class="bi bi-share me-2 text-info"></i>${i18next.t('auth.featureShare', 'Share drawings via URL or screenshot')}</li>
              <li class="mb-2"><i class="bi bi-save me-2 text-info"></i>${i18next.t('auth.featureSave', 'Save & manage multiple drawings')}</li>
            </ul>
            <hr class="border-secondary">
            <div class="d-grid gap-2">
              <button id="patreonLoginBtn" class="btn-patreon">
                ${PATREON_SYMBOL_WHITE}
                ${i18next.t('auth.loginWithPatreon', 'Log in with Patreon')}
              </button>
              <a href="https://www.patreon.com/wuote/membership" target="_blank" rel="noopener noreferrer" class="btn btn-outline-secondary">
                <i class="bi bi-box-arrow-up-right me-2"></i>${i18next.t('auth.becomePatron', 'Become a Patron')}
              </a>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Bind Patreon login handler
    modal.querySelector('#patreonLoginBtn')?.addEventListener('click', () => {
      bsModal.hide();
      authService.login();
    });

    // Clean up on hide
    modal.addEventListener('hidden.bs.modal', () => {
      modal.remove();
    });
  }

  private handleClick(): void {
    const state = authService.getState();
    if (!state.authenticated) {
      AuthUI.showGetProModal();
    }
  }

  private async handleLogout(): Promise<void> {
    await authService.logout();
  }
}

/**
 * Check if user has permission to use drawing feature
 * Requires active Patreon subscription
 */
export function canUseDraw(): boolean {
  return authService.isAuthenticated();
}

/**
 * Show login prompt for drawing feature
 */
export function showLoginPrompt(): void {
  const confirmed = confirm(
    i18next.t('auth.loginPrompt', `Sign in with Patreon to use drawing tools.

Drawings are saved locally and can be shared via URL.

Would you like to sign in?`)
  );
  if (confirmed) {
    authService.login();
  }
}
