/** Allow the loading shell to paint before cached JS initialization can run. */
export function paintLoadingFeedback(): Promise<void> {
  if (document.hidden || typeof requestAnimationFrame !== "function")
    return Promise.resolve();
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** A delayed hover popover must not cover the loading panel after a click. */
export function dismissLoadingPopover(label: Element | null): void {
  if (!label) return;
  const popover = (window as any).bootstrap?.Popover?.getInstance(label);
  if (!popover) return;
  popover.hide();
  if (label.matches(":hover")) {
    // hide() alone does not cancel a show that is still in Bootstrap's hover
    // delay. The public API disables that pending show until the pointer leaves.
    popover.disable();
    label.addEventListener("mouseleave", () => popover.enable(), {
      once: true,
    });
  }
}
