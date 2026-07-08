/**
 * light-mode.ts
 *
 * "Light mode" = only generate the main world (PW 0), skipping east/west
 * parallel worlds. Intended as a memory-saver for mobile / low-RAM devices
 * where iOS Safari kills the tab on zoom due to OOM.
 *
 * Persisted in localStorage, OFF by default.
 */

const STORAGE_KEY = "noitamap-light-mode";

// Default ON for small screens (mobile) where memory is limited — iOS Safari
// otherwise kills the tab on zoom. Desktop users default OFF.
// Check viewport width only (not height — devtools/docked panels shrink height).
const defaultEnabled =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 768px)").matches;

const stored = localStorage.getItem(STORAGE_KEY);
let _enabled: boolean = stored === null ? defaultEnabled : stored === "1";

// Transient override: daily / previous-daily maps are pre-baked with all three
// worlds already on the CDN, so light mode saves nothing there. runDynamicMap
// forces this on for those seeds so generation, the baked-tile filter, and the
// seed report all render the full 3 worlds regardless of the user's saved
// preference. It never touches localStorage or the toggle checkbox — a custom
// seed reverts to the user's real preference.
let _forcedOff = false;

const _listeners: ((enabled: boolean) => void)[] = [];

export function isLightMode(): boolean {
  return _forcedOff ? false : _enabled;
}

/** Force light mode OFF for the current (baked daily/prev-daily) seed, or clear
 *  the override for a custom seed. Does not persist or notify — callers that
 *  need a re-render (runDynamicMap) already drive one off the seed change. */
export function setLightModeForcedOff(forced: boolean): void {
  _forcedOff = forced;
}

export function setLightMode(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  for (const fn of _listeners) fn(enabled);
}

export function onLightModeChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}
