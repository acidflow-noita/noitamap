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
    wrapper.className = "btn-group me-2";
    wrapper.id = "drawing-ui-wrapper";

    wrapper.innerHTML = `
      <input type="checkbox" class="btn-check" id="drawToggleBtn" autocomplete="off">
      <label class="icon-button btn btn-sm btn-outline-light text-nowrap pro-accent" for="drawToggleBtn"
        data-bs-toggle="popover" data-bs-placement="bottom" data-bs-trigger="hover focus"
        data-i18n-title="drawing.toggle.title" 
        data-bs-title="${i18next.t("drawing.toggle.title", "Drawing Tools")}"
        data-i18n-content="drawing.toggle.content" 
        data-bs-content="${i18next.t("drawing.toggle.content", "Toggle drawing sidebar")}">
        <i class="bi bi-palette"></i><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" /></svg>
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
