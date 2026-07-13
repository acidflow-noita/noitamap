/**
 * Auth UI - Login button and "Get Pro" modal for navbar
 */

import { authService, AuthState } from "./auth-service";
import i18next from "../i18n";

// Twitch login is fully wired (worker + service) but HIDDEN in the UI until
// Twitch platform approval lands. Flip to true to reveal the modal button; no
// other change needed. While false, no Twitch markup renders and no Twitch
// translation keys are referenced, so nothing leaks to users.
const TWITCH_ENABLED = true;

// Official Twitch glitch mark (white, for the purple button). Geometry from
// task/TwitchGlitchPurple.svg. Only injected when TWITCH_ENABLED.
const TWITCH_SYMBOL_WHITE = `
<svg viewBox="0 0 2400 2800" xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true">
  <path fill="#ffffff" d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600V1300z"/>
  <rect x="1700" y="550" fill="#ffffff" width="200" height="600"/>
  <rect x="1150" y="550" fill="#ffffff" width="200" height="600"/>
</svg>`;

// Official Patreon Symbol (White)
const PATREON_SYMBOL_WHITE = `
<svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <path fill="#ffffff" d="M1033.05,324.45c-0.19-137.9-107.59-250.92-233.6-291.7c-156.48-50.64-362.86-43.3-512.28,27.2
        C106.07,145.41,49.18,332.61,47.06,519.31c-1.74,153.5,13.58,557.79,241.62,560.67c169.44,2.15,194.67-216.18,273.07-321.33
        c55.78-74.81,127.6-95.94,216.01-117.82C929.71,603.22,1033.27,483.3,1033.05,324.45z"/>
</svg>`;

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
    authService.subscribe((state) => this.updateButton(state));

    // Re-render when language changes
    i18next.on("languageChanged", () => {
      this.updateButton(authService.getState());
    });

    // Initialize auth state
    const state = await authService.init();
    this.updateButton(state);
  }

  private createButton(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.id = "auth-button-wrapper";
    // Initial state placeholder
    wrapper.innerHTML = `
      <button id="authButton" class="btn btn-sm btn-outline-light" type="button">
        <img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">
        <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>
      </button>
    `;

    const button = wrapper.querySelector("#authButton") as HTMLElement;
    button.addEventListener("click", () => this.handleClick());

    return wrapper;
  }

  private updateButton(state: AuthState): void {
    if (!this.button) return;

    const btn = this.button.querySelector("#authButton") as HTMLElement;

    if (state.authenticated) {
      // Show username with dropdown
      btn.className = "btn btn-sm btn-outline-success dropdown-toggle";
      btn.setAttribute("data-bs-toggle", "dropdown");
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = `<i class="bi bi-person-check me-1"></i> <span class="auth-text">${i18next.t("auth.yourAccount", "Your account")}</span>`;

      // Always rebuild dropdown to pick up language changes
      // Dispose old Bootstrap Dropdown instance so it doesn't hold a stale menu reference
      // @ts-ignore
      const existingBsDropdown = bootstrap.Dropdown.getInstance(btn);
      if (existingBsDropdown) existingBsDropdown.dispose();

      let dropdown = this.button.querySelector(".dropdown-menu");
      if (dropdown) dropdown.remove();

      dropdown = document.createElement("ul");
      dropdown.className = "dropdown-menu dropdown-menu-end";
      dropdown.innerHTML = `
          ${
            state.isSubscriber
              ? `<li><span class="dropdown-item-text text-success small"><img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">${i18next.t("auth.proActive", "Pro active")}</span></li>`
              : `<li><a class="dropdown-item small" href="https://www.patreon.com/wuote/membership" target="_blank" rel="noopener noreferrer"><i class="bi bi-star me-1"></i>${i18next.t("auth.subscribeCta", "Upgrade to Pro")}</a></li>`
          }
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item" id="logoutBtn"><i class="bi bi-box-arrow-right me-1"></i>${i18next.t("auth.signOut", "Sign out")}</button></li>
        `;
      this.button.appendChild(dropdown);
      this.button.classList.add("dropdown");

      // Reinitialize Bootstrap Dropdown with the new menu
      // @ts-ignore
      new bootstrap.Dropdown(btn);

      // Bind logout handler
      const logoutBtn = dropdown.querySelector("#logoutBtn");
      logoutBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        this.handleLogout();
      });
    } else {
      // Show "Get Pro" button
      // We keep the "Get Pro" style for the navbar button to match the theme,
      // but the MODAL will have the Patreon branded button.
      // Alternatively, we could make THIS button Patreon branded too?
      // "Get Pro" usually implies a call to action.
      // Let's keep it as "Get Pro" (standard style) but the modal has the official login button.

      btn.className = "btn btn-sm btn-outline-light pro-accent";
      btn.removeAttribute("data-bs-toggle");
      btn.removeAttribute("aria-expanded");
      btn.innerHTML = `<img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon"> <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>`;
      this.button.classList.remove("dropdown");

      // Remove dropdown if exists
      const dropdown = this.button.querySelector(".dropdown-menu");
      if (dropdown) dropdown.remove();
    }
  }

  public static showGetProModal(): void {
    // Remove existing modal if any
    const existing = document.getElementById("getProModal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "getProModal";
    modal.className = "modal fade";
    modal.tabIndex = -1;
    modal.setAttribute("aria-labelledby", "getProModalLabel");
    modal.setAttribute("aria-hidden", "true");

    // Two provider columns: Twitch (left) and Patreon (right), each with a
    // "sign in" and a "subscribe" button, separated by a faint "or". When
    // TWITCH_ENABLED is off, only the Patreon column shows (centered, no "or").
    const twitchColumnHtml = TWITCH_ENABLED
      ? `<div class="pro-col">
              <button id="twitchLoginBtn" class="btn-twitch justify-content-center">
                ${TWITCH_SYMBOL_WHITE}
                ${i18next.t("auth.loginWithTwitch", "Sign in with Twitch")}
              </button>
              <a href="https://www.twitch.tv/products/wuote" target="_blank" rel="noopener noreferrer" class="btn-patron justify-content-center">
                <i class="bi bi-box-arrow-up-right"></i>${i18next.t("auth.subscribeTwitch", "Subscribe on Twitch")}
              </a>
            </div>
            <div class="pro-or">${i18next.t("auth.or", "or")}</div>`
      : "";

    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-centered pro-dialog">
        <div class="modal-content bg-dark text-light">
          <div class="modal-header border-0 pb-0">
            <button type="button" class="btn-close btn-close-white ms-auto" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body pt-0">
            <p class="text-center text-light mb-3">${i18next.t("auth.proDescription", "Drawing tools and other Pro features are available to supporters.")}</p>
            <div class="pro-columns">
              ${twitchColumnHtml}
              <div class="pro-col">
                <button id="patreonLoginBtn" class="btn-patreon justify-content-center">
                  ${PATREON_SYMBOL_WHITE}
                  ${i18next.t("auth.loginWithPatreon", "Sign in with Patreon")}
                </button>
                <a href="https://www.patreon.com/wuote/membership" target="_blank" rel="noopener noreferrer" class="btn-patron justify-content-center">
                  <i class="bi bi-box-arrow-up-right"></i>${i18next.t("auth.becomePatron", "Become a Patron")}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Bind Patreon login handler
    modal.querySelector("#patreonLoginBtn")?.addEventListener("click", () => {
      bsModal.hide();
      authService.login();
    });

    // Bind Twitch login handler (only present when TWITCH_ENABLED)
    if (TWITCH_ENABLED) {
      modal.querySelector("#twitchLoginBtn")?.addEventListener("click", () => {
        bsModal.hide();
        authService.loginTwitch();
      });
    }

    // Clean up on hide
    modal.addEventListener("hidden.bs.modal", () => {
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
  return authService.isSubscriber();
}

/**
 * Show login prompt for drawing feature
 */
export function showLoginPrompt(): void {
  const confirmed = confirm(
    i18next.t(
      "auth.loginPrompt",
      `Sign in to use drawing tools.

Drawings are saved locally and can be shared via URL.

Would you like to sign in?`,
    ),
  );
  if (confirmed) {
    authService.login();
  }
}
