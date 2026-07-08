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

// Memory-constrained viewport (phones). Light mode defaults ON here, and the
// daily/prev-daily auto-off is SKIPPED here — a baked daily still paints 3
// worlds of DZI tiles into the canvas, which is what OOM-kills iOS Safari on
// zoom (baking only removes the generation cost, not the render-memory cost).
// Desktop has the RAM, so it takes the full 3 worlds on dailies.
export function isSmallViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches
  );
}

// Default ON for small screens (mobile) where memory is limited — iOS Safari
// otherwise kills the tab on zoom. Desktop users default OFF.
const defaultEnabled = isSmallViewport();

const stored = localStorage.getItem(STORAGE_KEY);
let _enabled: boolean = stored === null ? defaultEnabled : stored === "1";

// Transient override: daily / previous-daily maps are pre-baked with all three
// worlds already on the CDN, so light mode saves no GENERATION there. On
// desktop runDynamicMap forces this on so the report and map render the full 3
// worlds regardless of the user's saved preference; on mobile it is left off
// (see isSmallViewport) to avoid re-introducing the zoom OOM. It never touches
// localStorage or the toggle checkbox — a custom seed reverts to the pref.
let _forcedOff = false;

const _listeners: ((enabled: boolean) => void)[] = [];

/** Effective light mode used by generation/rendering (honours the daily
 *  auto-off override). */
export function isLightMode(): boolean {
  return _forcedOff ? false : _enabled;
}

/** The user's SAVED preference, ignoring the transient daily override — for the
 *  toggle checkbox, so a forced-off daily doesn't show it unchecked (and a
 *  toggle interaction doesn't silently overwrite the real preference). */
export function isLightModePreference(): boolean {
  return _enabled;
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
