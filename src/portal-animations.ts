/**
 * portal-animations.ts
 *
 * "Animated portals" = run the GPU particle simulation for portals on the
 * dynamic map (both baked daily maps and browser-generated ones). Persisted in
 * localStorage. Default ON everywhere, including small screens; the renderer
 * itself culls to the visible portals so idle cost is near zero.
 */

const STORAGE_KEY = "noitamap-portal-animations";

function readStored(): boolean | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
}

let _enabled: boolean = readStored() ?? true;

const _listeners: ((enabled: boolean) => void)[] = [];

export function isPortalAnimations(): boolean {
  return _enabled;
}

export function setPortalAnimations(enabled: boolean): void {
  _enabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
  for (const fn of _listeners) fn(enabled);
}

export function onPortalAnimationsChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}
