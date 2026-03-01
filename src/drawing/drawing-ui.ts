import { authService } from "../auth/auth-service";
import { AuthUI } from "../auth/auth-ui";
import i18next from "../i18n";

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
      <label class="icon-button btn btn-sm btn-outline-light text-nowrap" for="drawToggleBtn"
        data-bs-toggle="popover" data-bs-placement="top" data-bs-trigger="hover focus"
        data-i18n-title="drawing.toggle.title" 
        data-bs-title="${i18next.t("drawing.toggle.title", "Drawing Tools")}"
        data-i18n-content="drawing.toggle.content" 
        data-bs-content="${i18next.t("drawing.toggle.content", "Toggle drawing sidebar")}">
        <i class="bi bi-brush"></i>
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
    // Allow if subscriber OR if user is "wuote" (just in case auth service check fails locally but we want to allow override)
    // Actually authService now handles the ID check.
    if (!state.authenticated || !state.isSubscriber) {
      e.preventDefault(); // Stop checkbox from toggling
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

        // Show some loading feedback?
        document.body.style.cursor = "wait";

        try {
          const loaded = await this.options.onEnableDrawing();
          if (loaded) {
            target.checked = true;
            // Trigger change event so pro bundle listener picks it up
            target.dispatchEvent(new Event("change"));

            // Also explicitly open sidebar if needed?
            // The change event should be enough if pro bundle is listening.
            // We'll ensure pro bundle attaches listener on init.
          }
        } finally {
          document.body.style.cursor = "";
        }
      }
    }
  }
}
