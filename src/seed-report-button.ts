import { requestProSidebar, onProSidebarIntent } from "./pro-sidebar-intent";
import { createSeedReportLoading } from "./seed-report-loading";
import {
  paintLoadingFeedback,
  dismissLoadingPopover,
} from "./pro-loading-feedback";
/**
 * Seed Report toggle button.
 *
 * Lives in the main bundle so it's visible to everyone (auto-loads the pro
 * bundle on first click). The actual sidebar lives in noitamap-pro.
 *
 * Persists open state in the URL via `?sr=1` (handled in data_sources/url).
 */

import i18next from "./i18n";
import { parseURL, updateURLWithSeedReport } from "./data_sources/url";
import { authService } from "./auth/auth-service";

const BTN_ID = "seedReportToggleBtn";

export interface SeedReportButtonOptions {
  /** Load (or no-op) the Pro bundle. */
  loadProBundle: () => Promise<boolean>;
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

  const inputElement = wrap.querySelector(
    `#${BTN_ID}`,
  ) as HTMLInputElement | null;
  if (!inputElement) return;
  const input = inputElement;

  let requested = false;
  let pending: ReturnType<typeof createSeedReportLoading> | undefined;
  const removePending = () => {
    pending?.remove();
    pending = undefined;
    input.removeAttribute("aria-busy");
  };
  const showPending = () => {
    if (!pending)
      pending = createSeedReportLoading(
        () => {
          input.checked = false;
          void ensureProAndDispatch(false);
        },
        () => {
          input.checked = true;
          void ensureProAndDispatch(true);
        },
      );
    else pending.loading();
    input.setAttribute("aria-busy", "true");
    return pending;
  };
  // Changing sidebar during a download removes its shell immediately, not
  // only once the abandoned download eventually settles.
  onProSidebarIntent((sidebar) => {
    if (sidebar === "report" || !requested) return;
    requested = false;
    input.checked = false;
    removePending();
    updateURLWithSeedReport(false);
    (window as any).__noitamap?.handleSeedReportToggle?.(false);
  });

  async function ensureProAndDispatch(
    open: boolean,
    current?: () => boolean,
  ): Promise<boolean> {
    requested = open;
    const stillWanted = current ?? requestProSidebar("report", open);
    updateURLWithSeedReport(open);
    if (open) dismissLoadingPopover(label);
    const hooks = (window as any).__noitamap;
    if (!open) {
      removePending();
      hooks?.handleSeedReportToggle?.(false);
      return true;
    }
    const needsLoad = typeof hooks?.handleSeedReportToggle !== "function";
    const feedback = needsLoad ? showPending() : pending;
    try {
      if (needsLoad) {
        await paintLoadingFeedback();
        if (!stillWanted()) return false;
        if (!(await opts.loadProBundle())) {
          if (stillWanted()) {
            feedback?.error();
            input.removeAttribute("aria-busy");
          }
          return false;
        }
      }
      if (!stillWanted()) return false;
      const readyHooks = (window as any).__noitamap;
      if (typeof readyHooks?.handleSeedReportToggle !== "function") {
        feedback?.error();
        input.removeAttribute("aria-busy");
        return false;
      }
      // The shell is already on-screen. Replace it in place instead of
      // removing it and waiting through another slide-in animation.
      // Older cached Pro bundles can still install their previous panel during
      // rollout; the current bundle always installs V3, regardless of the URL.
      const realPanel = document.getElementById("seed-report-v3")
        ?? document.getElementById("seed-report-sidebar")
        ?? document.getElementById("seed-report-v2");
      const previousTransition = realPanel?.style.transition ?? "";
      if (feedback && realPanel) realPanel.style.transition = "none";
      readyHooks.handleSeedReportToggle(true);
      if (feedback && realPanel) {
        realPanel.getBoundingClientRect();
        requestAnimationFrame(() => {
          realPanel.style.transition = previousTransition;
        });
      }
      removePending();
      input.checked = true;
      return true;
    } catch (error) {
      console.error("[SeedReport] Failed to open report:", error);
      if (stillWanted()) {
        (feedback ?? showPending()).error();
        input.removeAttribute("aria-busy");
      }
      return false;
    }
  }

  // No CTA modal here: opening the seed report loads its sidebar, which renders
  // its own inline locked-view (sign-in buttons + skeleton) for non-subscribers.
  // A modal on top would double-nag. Just let the toggle proceed.
  input.addEventListener("change", () => {
    void ensureProAndDispatch(input.checked);
  });

  // A restored report gets the same immediate, closeable loading shell while
  // auth resolves. Its checkbox now represents the visible shell as well as
  // the loaded report; cancellation prevents any late open from winning.
  const initial = parseURL().seedReportOpen;
  if (initial) {
    requested = true;
    input.checked = true;
    const current = requestProSidebar("report", true);
    showPending();
    authService.ready.then(async () => {
      if (current()) await ensureProAndDispatch(true, current);
    });
  }
}
