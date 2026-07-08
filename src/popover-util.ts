import i18next from "./i18n";

const bs = () => (window as any).bootstrap;

/**
 * Attach a hover Bootstrap popover to `el`. The host element is tagged with
 * `__disposePopover` so dismissPopovers() can tear it down when its container
 * is rebuilt (search re-render, tooltip close) - otherwise the body-appended
 * panel leaks once the trigger is removed from the DOM.
 */
export function attachHoverPopover(
  el: HTMLElement,
  content: string,
  placement: "top" | "bottom" | "left" | "right" = "top",
): void {
  const lib = bs();
  if (!lib?.Popover) return;
  const existing = lib.Popover.getInstance(el);
  if (existing) existing.dispose();
  const inst = new lib.Popover(el, {
    content,
    trigger: "hover",
    placement,
    container: "body",
    delay: { show: 80, hide: 120 },
  });
  (el as any).__disposePopover = () => {
    try { inst.dispose(); } catch { /* noop */ }
  };
}

/** Attach the in-game "Always casts" popover to a wand AC badge. */
export function attachAlwaysCastPopover(el: HTMLElement): void {
  el.style.cursor = "help";
  attachHoverPopover(el, i18next.t("gameContent.ui.inventory_alwayscasts", { defaultValue: "Always casts" }));
}

/**
 * Dispose every popover within `root` (inclusive). Handles both
 * `data-bs-toggle="popover"` instances and manually-managed ones tagged with
 * `__disposePopover`. Call before tearing down a subtree that hosts popovers.
 */
export function dismissPopovers(root: HTMLElement): void {
  try {
    const lib = bs();
    if (lib?.Popover) {
      root.querySelectorAll('[data-bs-toggle="popover"]').forEach((pop) => {
        const inst = lib.Popover.getInstance(pop);
        if (inst) {
          inst.hide();
          inst.dispose();
        }
      });
    }
    const visit = (node: Element) => {
      const disp = (node as any).__disposePopover;
      if (typeof disp === "function") disp();
    };
    visit(root);
    root.querySelectorAll("*").forEach(visit);
  } catch { /* noop */ }
}

/** Hide every currently-open Bootstrap popover in the document. */
function hideAllPopovers(except?: Element | null): void {
  const lib = bs();
  if (!lib?.Popover) return;
  document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
    if (el === except) return;
    try {
      lib.Popover.getInstance(el)?.hide();
    } catch { /* noop */ }
  });
}

let autoDismissInstalled = false;

/**
 * Make Bootstrap popovers dismissable on touch devices.
 *
 * Popovers use `trigger="hover focus"`, which works with a mouse (leaving the
 * element hides it) but traps touch users: a tap fires hover+focus and shows
 * the popover, and there is no "un-hover" on touch, so it stays stuck open with
 * no way to close it — brutal on mobile where these overlap the map/search.
 *
 * One delegated `pointerup` listener fixes it for every popover (main app AND
 * anything the pro bundle adds later), no per-popover wiring:
 *   - tap ON a hover/focus trigger  -> toggle it, hide any others
 *   - tap anywhere else             -> hide all open popovers
 * Only runs for touch/pen input (`pointerType !== "mouse"`), so desktop hover
 * behaviour is untouched. Form fields keep their focus popover (intentional
 * inline help) unless the tap lands outside them.
 */
export function installPopoverTouchDismiss(): void {
  if (autoDismissInstalled) return;
  autoDismissInstalled = true;

  document.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType === "mouse") return; // desktop hover is fine
      const lib = bs();
      if (!lib?.Popover) return;

      const trigger = (e.target as Element | null)?.closest?.(
        '[data-bs-toggle="popover"]',
      ) as HTMLElement | null;

      if (!trigger) {
        // Tapped off any trigger — dismiss everything (unless the tap landed
        // inside an open popover panel, so links/buttons in it still work).
        if ((e.target as Element | null)?.closest?.(".popover")) return;
        hideAllPopovers();
        return;
      }

      const triggers = trigger.getAttribute("data-bs-trigger") || "click";
      if (!/hover|focus/.test(triggers)) return; // click popovers self-toggle

      // Toggle this one; hide any others so taps don't stack open panels.
      hideAllPopovers(trigger);
      try {
        const inst = lib.Popover.getOrCreateInstance(trigger);
        inst.toggle();
      } catch { /* noop */ }
    },
    true,
  );
}
