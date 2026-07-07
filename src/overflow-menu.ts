/**
 * overflow-menu.ts
 *
 * De-bloats the navbar on the dynamic map by relocating secondary controls
 * into the "..." (more) dropdown, and restoring them to the navbar on static
 * maps where those controls (the overlay group in particular) are the primary
 * feature.
 *
 * The controls are MOVED, not recreated: reparenting a live DOM node preserves
 * its event listeners and Bootstrap instances, so the delegated overlay handler
 * (main.ts), the perf-mode popover wiring, and every other listener keep
 * working unchanged.
 *
 * Each moved element leaves behind a placeholder comment node marking its
 * original navbar position, so it can be restored exactly where it was.
 */

const DYNAMIC_MAP_NAME = "dynamic-main-branch";

// Navbar element ids to tuck into the more-menu on the dynamic map, in the
// order they should appear inside the menu. The overlay group is the bulky
// one; the rest are single icon buttons/dropdowns.
const OVERFLOW_IDS = [
  "spoilerFreeToggle", // the visible control is the sibling <label>, handled specially
  "perfModeDropdown",
  "shareButton",
  "dynamicNerdModeButton",
  "overlay-selector",
];

interface Relocated {
  el: HTMLElement;
  placeholder: Comment;
}

let relocated: Relocated[] = [];
let inMenu = false;

/** The spoiler-free control is a btn-check <input> + a <label for=...> pair.
 *  Return both so they move together (the input carries the state/listeners,
 *  the label is what the user sees/clicks). */
function resolveElements(id: string): HTMLElement[] {
  if (id === "spoilerFreeToggle") {
    const input = document.getElementById("spoilerFreeToggle");
    const label = document.querySelector<HTMLElement>('label[for="spoilerFreeToggle"]');
    return [input, label].filter((e): e is HTMLElement => !!e);
  }
  const el = document.getElementById(id);
  return el ? [el] : [];
}

function moveIntoMenu(): void {
  if (inMenu) return;
  const slot = document.getElementById("more-menu-controls");
  if (!slot) return;

  for (const id of OVERFLOW_IDS) {
    for (const el of resolveElements(id)) {
      const placeholder = document.createComment(`overflow:${el.id || id}`);
      el.parentNode?.insertBefore(placeholder, el);
      slot.appendChild(el);
      relocated.push({ el, placeholder });
    }
  }
  inMenu = true;
  toggleDivider(true);
}

function restoreToNavbar(): void {
  if (!inMenu) return;
  // Restore in reverse so earlier placeholders remain valid as later nodes move.
  for (let i = relocated.length - 1; i >= 0; i--) {
    const { el, placeholder } = relocated[i];
    placeholder.parentNode?.insertBefore(el, placeholder);
    placeholder.remove();
  }
  relocated = [];
  inMenu = false;
  toggleDivider(false);
}

/** Hide the slot + divider when nothing is tucked away, so the menu doesn't
 *  show an empty controls row with a stray divider on static maps. */
function toggleDivider(show: boolean): void {
  const slot = document.getElementById("more-menu-controls-slot");
  const divider = document.getElementById("more-menu-controls-divider");
  slot?.classList.toggle("d-none", !show);
  divider?.classList.toggle("d-none", !show);
}

/**
 * Sync the overflow menu to the active map. Call from the same choke point that
 * toggles dynamic-map UI visibility (updateDynamicUIVisibility).
 */
export function updateOverflowMenu(currentMap: string): void {
  if (currentMap === DYNAMIC_MAP_NAME) moveIntoMenu();
  else restoreToNavbar();
}

/**
 * Move the "..." button to the end of the navbar row so it sits after the
 * last-injected control (Get Pro / auth container). Call once, after all
 * runtime-injected navbar buttons (auth, drawing, seed report) exist.
 */
export function placeMoreMenuLast(): void {
  const menu = document.getElementById("more-menu");
  const container = menu?.parentElement;
  if (menu && container) container.appendChild(menu);
}
