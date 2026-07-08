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

// Touch-primary device (no real hover). These are exactly the devices where
// hover popovers misbehave: a tap fires the hover, and there's no un-hover.
const isTouchPrimary = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none), (pointer: coarse)").matches;

// Elements whose tap should perform their OWN action — navigate, toggle a
// control, focus a field, open a dropdown — not reveal hover-help. On touch
// these must never show a popover: the tap does the thing. This is the seed
// link (an <a role="button"> that swaps the seed), the filter/AP/LC/gem toggle
// <label>s, the search + seed <input>s, dropdown toggles, etc. A plain info
// affordance (an "i" <button> whose only purpose IS the popover) is NOT
// actionable and keeps tap-to-reveal.
const isActionable = (el: Element | null): boolean =>
  !!el &&
  el.matches(
    'a, label, input, textarea, select, [href], [role="button"], [data-bs-toggle="dropdown"], [data-bs-toggle="collapse"]',
  );

/**
 * Make Bootstrap popovers behave on touch devices.
 *
 * Popovers use `trigger="hover"` / `"hover focus"`, which works with a mouse
 * (leaving the element hides it) but is broken on touch: a tap fires the hover
 * and there is no "un-hover", so the panel sticks open — and worse, on an
 * ACTIONABLE element the tap reveals the popover INSTEAD OF running the action
 * (e.g. tapping the comparison-seed link showed help instead of swapping the
 * seed). Two rules, both touch-only (desktop hover is untouched):
 *
 * 1. Actionable trigger (link / label / form field / dropdown toggle /
 *    role="button"): SUPPRESS the popover entirely (cancel show.bs.popover) so
 *    the tap performs the element's real action. This is the "tapping stuff on
 *    mobile should activate the UI element" rule.
 *
 * 2. Pure info affordance (an "i" button whose only job is the popover): keep
 *    it useful — a delegated pointerup toggles the tapped one and hides the
 *    rest; a tap elsewhere hides all.
 */
export function installPopoverTouchDismiss(): void {
  if (autoDismissInstalled) return;
  autoDismissInstalled = true;

  // 1. Suppress hover-help on actionable triggers on touch. Delegated + capture
  //    so it catches every popover, whenever/wherever it was created.
  document.addEventListener(
    "show.bs.popover",
    (e) => {
      if (isTouchPrimary() && isActionable(e.target as Element)) {
        e.preventDefault();
      }
    },
    true,
  );

  // 2. Tap-to-dismiss for the remaining (pure-info) popovers.
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

      // Actionable triggers never show a popover on touch (see #1) and the tap
      // is "do your action" — leave them entirely alone so the native
      // click/navigation/toggle proceeds.
      if (isActionable(trigger)) return;

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
