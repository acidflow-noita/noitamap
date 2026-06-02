/**
 * simplistic-background.ts
 *
 * "Simplistic map background" = replace the streamed DZI tile pyramids that
 * normally load when a map opens with a single tiny flat PNG per parallel
 * world (`bg_perf_mode.png`). One image pixel maps to one 512px chunk, so the
 * PNG is displayed at 512x. Big bandwidth/decode/memory saver on slow
 * connections and low-RAM devices; the background looks blocky.
 *
 * Persisted in localStorage, OFF by default everywhere.
 */

const STORAGE_KEY = "noitamap-simplistic-background";

const stored = localStorage.getItem(STORAGE_KEY);
let _enabled: boolean = stored === "1";

const _listeners: ((enabled: boolean) => void)[] = [];

export function isSimplisticBackground(): boolean {
  return _enabled;
}

export function setSimplisticBackground(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  for (const fn of _listeners) fn(enabled);
}

export function onSimplisticBackgroundChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}
