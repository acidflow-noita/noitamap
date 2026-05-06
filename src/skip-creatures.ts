/**
 * skip-creatures.ts
 *
 * "Skip creatures" = don't render `enemies`/`props` POIs as markers on the
 * map. Massively reduces marker count (the daily seed has ~32k creatures vs
 * ~9k everything else) which helps slow devices stay responsive.
 *
 * Persisted in localStorage. Default ON for mobile, OFF for desktop.
 */

const STORAGE_KEY = "noitamap-skip-creatures";

const defaultEnabled =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 768px)").matches;

const stored = localStorage.getItem(STORAGE_KEY);
let _enabled: boolean = stored === null ? defaultEnabled : stored === "1";

const _listeners: ((enabled: boolean) => void)[] = [];

export function isSkipCreatures(): boolean {
  return _enabled;
}

export function setSkipCreatures(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  for (const fn of _listeners) fn(enabled);
}

export function onSkipCreaturesChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}
