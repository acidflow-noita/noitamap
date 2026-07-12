/**
 * Seed Report toggle button.
 *
 * Lives in the main bundle so it's visible to everyone (auto-loads the appropriate report
 * bundle on first click). The actual sidebar lives in noitamap-pro.
 *
 * Persists open state in the URL via `?sr=1` (handled in data_sources/url).
 */

import i18next from "./i18n";
import { parseURL, updateURLWithSeedReport } from "./data_sources/url";
import { authService } from "./auth/auth-service";

const BTN_ID = "seedReportToggleBtn";

export interface SeedReportButtonOptions {
  /** Load the subscriber or public report bundle for the resolved auth state. */
  loadReportBundle: () => Promise<boolean>;
}

export function createSeedReportButton(
  anchor: HTMLElement,
  opts: SeedReportButtonOptions,
): void {
  if (document.getElementById(BTN_ID)) return;

  const wrap = document.createElement("div");
  wrap.className = "btn-group me-2";
  wrap.id = "seed-report-ui-wrapper";
  wrap.innerHTML = `
    <input type="checkbox" class="btn-check" id="${BTN_ID}" autocomplete="off">
    <label class="icon-button btn btn-sm btn-outline-light text-nowrap pro-accent" for="${BTN_ID}"
      data-bs-toggle="popover" data-bs-placement="bottom" data-bs-trigger="hover focus"
      data-i18n-title="seedReport.toggle.title"
      data-bs-title="${i18next.t("seedReport.toggle.title", "Seed report")}"
      data-i18n-content="seedReport.toggle.content"
      data-bs-content="${i18next.t("seedReport.toggle.content", "Per-PW, per-biome stats for the current seed.")}">
      <i class="bi bi-bar-chart-line"></i>
    </label>
  `;
  anchor.parentNode?.insertBefore(wrap, anchor);

  const label = wrap.querySelector("label");
  if (label && (window as any).bootstrap?.Popover) {
    try {
      new (window as any).bootstrap.Popover(label);
    } catch {
      /* noop */
    }
  }

  const input = wrap.querySelector(`#${BTN_ID}`) as HTMLInputElement | null;
  if (!input) return;

  async function ensureProAndDispatch(open: boolean): Promise<void> {
    updateURLWithSeedReport(open);
    const hooks = (window as any).__noitamap;
    if (!hooks) return;
    if (typeof hooks.handleSeedReportToggle !== "function") {
      await opts.loadReportBundle();
    }
    if (typeof hooks.handleSeedReportToggle === "function") {
      hooks.handleSeedReportToggle(open);
    }
  }

  // No CTA modal here: opening the seed report loads its sidebar, which renders
  // its own inline locked-view (sign-in buttons + skeleton) for non-subscribers.
  // A modal on top would double-nag. Just let the toggle proceed.
  input.addEventListener("change", () => {
    ensureProAndDispatch(input.checked);
  });

  // Restore from URL state on load — wait for auth to resolve before deciding,
  // otherwise authService.getState() returns the default (unauthenticated)
  // and we'd treat real subscribers as anonymous on every F5.
  // For non-subs we silently reopen the locked sidebar (no modal nag — they
  // already opted into the panel; the locked-view CTA is visible inside).
  //
  // IMPORTANT: only flip input.checked AFTER ensureProAndDispatch finishes
  // (i.e. the pro bundle is loaded and the sidebar is open). If we flip it
  // sooner the user sees a "checked" button while the sidebar is still
  // loading and clicking it sends a spurious change→close event, which
  // strips ?sr=1 and the next click has to re-open it.
  const initial = parseURL().seedReportOpen;
  if (initial) {
    authService.ready.then(async () => {
      try {
        await ensureProAndDispatch(true);
      } finally {
        input.checked = true;
      }
    });
  }
}

