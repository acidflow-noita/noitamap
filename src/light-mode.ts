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

const _listeners: ((enabled: boolean) => void)[] = [];

export function isLightMode(): boolean {
  return _enabled;
}

export function setLightMode(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  for (const fn of _listeners) fn(enabled);
}

export function onLightModeChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}
