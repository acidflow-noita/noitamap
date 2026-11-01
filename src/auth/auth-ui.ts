/**
 * Auth UI - Login button and "Get Pro" dialog for navbar
 */

import { authService, AuthState } from "./auth-service";
import i18next from "../i18n";
import * as bootstrap from "../bootstrap";
import { createProControls } from "./pro-controls";

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
      <span class="btn btn-sm auth-button-sizer" aria-hidden="true">
        <span class="auth-button-labels"><span data-auth-size="pro"></span><span data-auth-size="account"></span></span>
      </span>
      <button id="authButton" class="btn btn-sm btn-outline theme-inverse" type="button">
        <img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">
        <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>
      </button>
    `;

    this.sizeButton(wrapper);
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

  private sizeButton(wrapper: HTMLElement): void {
    wrapper.querySelector('[data-auth-size="pro"]')!.textContent = i18next.t('auth.getPro', 'Get Pro');
    wrapper.querySelector('[data-auth-size="account"]')!.textContent = i18next.t('auth.yourAccount', 'Your account');
  }

  private async updateButton(state: AuthState): Promise<void> {
    if (!this.button) return;

    const update = ++this.buttonUpdate;
    const btn = this.button.querySelector("#authButton") as HTMLElement;
    // Both account states share one intrinsic width; a late auth reply only
    // changes the visible label, without moving the rest of the navbar.
    this.sizeButton(this.button);

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
      const providerLabel = state.linkedAccounts?.map(account => account.provider === 'twitch' ? 'Twitch' : 'Patreon').join(' + ')
        || (state.provider === "twitch" ? "Twitch" : "Patreon");
      menu.innerHTML = `
          <span class="menu-header fg-secondary small"><i class="bi bi-box-arrow-in-right me-1"></i>${i18next.t("auth.yourAccount", "Your account")}: ${providerLabel}</span>
          ${
            state.isSubscriber
              ? `<span class="menu-header fg-success small"><img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon">${i18next.t("auth.proActive", "Pro active")}</span>`
              : `<button class="menu-item small" id="upgradeProBtn" type="button"><i class="bi bi-star me-1"></i>${i18next.t("auth.subscribeCta", "Upgrade to Pro")}</button>`
          }
          <button class="menu-item small" id="manageAccountsBtn" type="button">${i18next.t("auth.manageAccounts", "Connected accounts")}</button>
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
      menu.querySelector("#manageAccountsBtn")?.addEventListener("click", () => AuthUI.showGetProModal());
    } else {
      btn.className = "btn btn-sm btn-outline theme-inverse pro-accent animation-pop";
      btn.removeAttribute("data-bs-toggle");
      btn.removeAttribute("aria-expanded");
      btn.innerHTML = `<img src="assets/icons/website-icons/noitamap-pro-icon.svg" alt="" class="pro-icon"> <span class="auth-text">${i18next.t("auth.getPro", "Get Pro")}</span>`;
    }
  }

  /** Provider controls shared by the map dialog and inline Pro gates. */
  public static createProControls(options: Parameters<typeof createProControls>[0] = {}): HTMLElement {
    return createProControls(options);
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

    dialog.innerHTML = `
      <div class="dialog-header border-0 pb-0">
        <h2 id="getProModalLabel" class="dialog-title visually-hidden">${i18next.t("auth.getPro", "Get Pro")}</h2>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="dialog" aria-label="${i18next.t("seedReport.close", "Close")}"></button>
      </div>
      <div class="dialog-body pt-0">
        <p class="text-center mb-5">${i18next.t("auth.proDescription", "Drawing tools and other Pro features are available to supporters.")}</p>
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

    dialog.querySelector(".dialog-body")!.append(AuthUI.createProControls({
      onLogin: startLogin => { void login(startLogin); },
    }));
    const shown = bsDialog.show();
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
