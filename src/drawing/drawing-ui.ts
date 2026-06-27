import { authService } from "../auth/auth-service";
import { AuthUI } from "../auth/auth-ui";
import i18next from "../i18n";
import { showDrawingSkeleton, hideDrawingSkeleton } from "./drawing-skeleton";

export interface DrawingUIOptions {
  onEnableDrawing: () => Promise<boolean>;
}

export class DrawingUI {
  private container: HTMLElement;
  private button: HTMLInputElement | null = null;
  private options: DrawingUIOptions;

  constructor(container: HTMLElement, options: DrawingUIOptions) {
    this.container = container;
    this.options = options;
    this.init();
  }

  private init(): void {
    // Create button wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "shrink-0 inline-flex";
    wrapper.id = "drawing-ui-wrapper";

    wrapper.innerHTML = `
      <input type="checkbox" class="btn-check" id="drawToggleBtn" autocomplete="off">
      <label class="btn-sm-icon-outline shrink-0 pro-accent" for="drawToggleBtn"
        data-i18n-tooltip="drawing.toggle.title"
        data-tooltip="${i18next.t("drawing.toggle.title", "Drawing Tools")}">
        <i class="bi bi-palette"></i>
      </label>
    `;

    // Insert before auth container
    const authContainer = document.getElementById("auth-container");
    if (authContainer && authContainer.parentNode) {
      authContainer.parentNode.insertBefore(wrapper, authContainer);
    } else {
      this.container.appendChild(wrapper);
    }

    this.button = wrapper.querySelector("#drawToggleBtn");
    const label = wrapper.querySelector("label");

    // Initialize popover
    if (label) new bootstrap.Popover(label);

    // Bind click to intercept before state change
    if (this.button) {
      this.button.addEventListener("click", (e) => this.handleClick(e));
    }
  }

  private async handleClick(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    const state = authService.getState();

    // 1. Check Auth & Subscription
    if (!state.authenticated || !state.isSubscriber) {
      e.preventDefault();
      AuthUI.showGetProModal();
      // We no longer return early here. We want to load the pro bundle anyway
      // so the user can see the unauthenticated/non-subscriber sidebar state.
    }

    // 2. Load pro bundle if needed (regardless of subscriber status,
    // since the sidebar now has an unauthenticated view).
    // If we are turning it ON (or attempting to), make sure Pro bundle is loaded
    if (target.checked) {
      if (!(window as any).noitamap_pro_loaded) {
        e.preventDefault(); // Pause toggle while loading

        // Instant UI response: slide in skeleton sidebar + toolbar so the
        // user sees the panel appear immediately while the pro bundle
        // downloads and evaluates in the background.
        showDrawingSkeleton();

        let loaded = false;
        try {
          loaded = await this.options.onEnableDrawing();
          if (loaded) {
            target.checked = true;
            // Open the real sidebar first so it's mounted underneath the
            // skeleton, then slide the skeleton out for a seamless handoff.
            target.dispatchEvent(new Event("change"));
          }
        } finally {
          hideDrawingSkeleton();
        }
      }
    }
  }
}
