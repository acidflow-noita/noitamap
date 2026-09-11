// Async feature loading must not reopen an older sidebar after the user has
// closed it or chosen the other one. Closing an inactive sidebar (the normal
// mutual-exclusion handoff) must not cancel the new sidebar's request.
let revision = 0;
type Sidebar = "drawing" | "report" | null;
let requested: Sidebar = null;
const listeners = new Set<(sidebar: Sidebar) => void>();
export function onProSidebarIntent(
  listener: (sidebar: Sidebar) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function requestProSidebar(
  kind: "drawing" | "report",
  open: boolean,
): () => boolean {
  if (open || requested === kind) {
    requested = open ? kind : null;
    revision++;
    for (const listener of listeners) listener(requested);
  }
  const ticket = revision;
  return () => revision === ticket && requested === kind;
}
