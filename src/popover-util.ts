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
