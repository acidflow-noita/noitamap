/**
 * Auth UI - Login button and "Get Pro" dialog for navbar
 */

import { authService, AuthState } from "./auth-service";
import i18next from "../i18n";
import * as bootstrap from "../bootstrap";

// Twitch login is fully wired (worker + service) but HIDDEN in the UI until
// Twitch platform approval lands. Flip to true to reveal the dialog button; no
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
  private buttonUpdate = 0;
  private menuCleanup: Promise<void> | null = null;
  private menuHidden: Promise<void> | null = null;

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
      <button id="authButton" class="btn btn-sm btn-outline theme-inverse" type="button">
        <img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">
        <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>
      </button>
    `;

    const button = wrapper.querySelector("#authButton") as HTMLElement;
    button.addEventListener("click", () => this.handleClick());
    button.addEventListener("hide.bs.menu", (event) => {
      if (event.defaultPrevented || this.menuHidden) return;
      let finish!: () => void;
      this.menuHidden = new Promise<void>((resolve) => { finish = resolve; });
      const onHidden = () => {
        this.menuHidden = null;
        finish();
      };
      button.addEventListener("hidden.bs.menu", onHidden, { once: true });
      queueMicrotask(() => {
        if (event.defaultPrevented) {
          button.removeEventListener("hidden.bs.menu", onHidden);
          onHidden();
        }
      });
    });

    return wrapper;
  }

  private async updateButton(state: AuthState): Promise<void> {
    if (!this.button) return;

    const update = ++this.buttonUpdate;
    const btn = this.button.querySelector("#authButton") as HTMLElement;

    // Keep the old menu attached until its exit transition finishes. Auth and
    // language changes can arrive together, so only render the latest update.
    const existingMenu = bootstrap.Menu.getInstance(btn);
    if (existingMenu) {
      btn.removeAttribute("data-bs-toggle");
      // hide() is a no-op if an automatic close is already transitioning.
      this.menuCleanup ??= (this.menuHidden ?? existingMenu.hide()).then(() => existingMenu.dispose());
      await this.menuCleanup;
      this.menuCleanup = null;
    }
    if (update !== this.buttonUpdate) return;
    this.button.querySelector(".menu")?.remove();

    if (state.authenticated) {
      // Show the account menu.
      btn.className = "btn btn-sm btn-outline theme-success";
      btn.setAttribute("data-bs-toggle", "menu");
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = `<i class="bi bi-person-check me-1"></i> <span class="auth-text">${i18next.t("auth.yourAccount", "Your account")}</span>`;

      const menu = document.createElement("div");
      menu.className = "menu";
      const providerLabel = state.provider === "twitch" ? "Twitch" : "Patreon";
      menu.innerHTML = `
          <span class="menu-header fg-secondary small"><i class="bi bi-box-arrow-in-right me-1"></i>${i18next.t("auth.yourAccount", "Your account")}: ${providerLabel}</span>
          ${
            state.isSubscriber
              ? `<span class="menu-header fg-success small"><img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">${i18next.t("auth.proActive", "Pro active")}</span>`
              : `<button class="menu-item small" id="upgradeProBtn" type="button"><i class="bi bi-star me-1"></i>${i18next.t("auth.subscribeCta", "Upgrade to Pro")}</button>`
          }
          <hr class="menu-divider">
          <button class="menu-item" id="logoutBtn" type="button"><i class="bi bi-box-arrow-right me-1"></i>${i18next.t("auth.signOut", "Sign out")}</button>
        `;
      this.button.appendChild(menu);

      new bootstrap.Menu(btn, { placement: "bottom-end" });

      // Bind logout handler
      const logoutBtn = menu.querySelector("#logoutBtn");
      logoutBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        this.handleLogout();
      });
      menu.querySelector("#upgradeProBtn")?.addEventListener("click", () => AuthUI.showGetProModal());
    } else {
      btn.className = "btn btn-sm btn-outline theme-inverse pro-accent";
      btn.removeAttribute("data-bs-toggle");
      btn.removeAttribute("aria-expanded");
      btn.innerHTML = `<img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon"> <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>`;
    }
  }

  public static showGetProModal(): void {
    // Repeated requests share the current dialog and its pending transitions.
    const existing = document.getElementById("getProModal");
    if (existing) return;

    const dialog = document.createElement("dialog");
    dialog.id = "getProModal";
    dialog.className = "dialog dialog-scrollable pro-dialog";
    dialog.setAttribute("data-bs-theme", "dark");
    dialog.setAttribute("aria-labelledby", "getProModalLabel");

    // Two provider columns: Twitch (left) and Patreon (right), each with a
    // "sign in" and a "subscribe" button, separated by a faint "or". When
    // TWITCH_ENABLED is off, only the Patreon column shows (centered, no "or").
    const state = authService.getState();
    const twitchLoginHtml = state.provider === "twitch"
      ? ""
      : `<button id="twitchLoginBtn" class="btn btn-solid theme-primary btn-twitch justify-content-center" type="button">
          ${TWITCH_SYMBOL_WHITE}
          <span class="pro-provider-label">${i18next.t("auth.loginWithTwitch", "Sign in with Twitch")}</span>
        </button>`;
    const patreonLoginHtml = state.provider === "patreon"
      ? ""
      : `<button id="patreonLoginBtn" class="btn btn-solid theme-primary btn-patreon justify-content-center" type="button">
          ${PATREON_SYMBOL_WHITE}
          <span class="pro-provider-label">${i18next.t("auth.loginWithPatreon", "Sign in with Patreon")}</span>
        </button>`;
    const twitchColumnHtml = TWITCH_ENABLED
      ? `<div class="pro-col">
              ${twitchLoginHtml}
              <a href="https://www.twitch.tv/products/wuote" target="_blank" rel="noopener noreferrer" class="btn btn-outline theme-secondary btn-patron justify-content-center">
                <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i><span class="pro-provider-label">${i18next.t("auth.subscribeTwitch", "Subscribe on Twitch")}</span>
              </a>
            </div>
            <div class="pro-or">${i18next.t("auth.or", "or")}</div>`
      : "";

    dialog.innerHTML = `
      <div class="dialog-header border-0 pb-0">
        <h2 id="getProModalLabel" class="dialog-title visually-hidden">${i18next.t("auth.getPro", "Get Pro")}</h2>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="dialog" aria-label="Close"></button>
      </div>
      <div class="dialog-body pt-0">
        <p class="text-center mb-5">${i18next.t("auth.proDescription", "Drawing tools and other Pro features are available to supporters.")}</p>
        <div class="pro-columns">
          ${twitchColumnHtml}
          <div class="pro-col">
            ${patreonLoginHtml}
            <a href="https://www.patreon.com/wuote/membership" target="_blank" rel="noopener noreferrer" class="btn btn-outline theme-secondary btn-patron justify-content-center">
              <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i><span class="pro-provider-label">${i18next.t("auth.becomePatron", "Become a Patron")}</span>
            </a>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const bsDialog = new bootstrap.Dialog(dialog);
    let disposed = false;
    let loginPending = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      bsDialog.dispose();
      dialog.remove();
    };

    // Dismissal through Escape, the backdrop, or the close button uses the data
    // API. Provider clicks instead dispose after their hide promise settles.
    dialog.addEventListener("hidden.bs.dialog", () => {
      if (!loginPending) dispose();
    }, { once: true });
    const shown = bsDialog.show();

    const login = async (startLogin: () => void) => {
      if (loginPending || disposed) return;
      loginPending = true;
      await shown;
      if (disposed) return;
      await bsDialog.hide();
      if (dialog.open) {
        loginPending = false;
        return;
      }
      dispose();
      startLogin();
    };

    dialog.querySelector("#patreonLoginBtn")?.addEventListener("click", () => {
      void login(() => authService.login());
    });

    // Bind Twitch login handler (only present when TWITCH_ENABLED)
    if (TWITCH_ENABLED) {
      dialog.querySelector("#twitchLoginBtn")?.addEventListener("click", () => {
        void login(() => authService.loginTwitch());
      });
    }
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
