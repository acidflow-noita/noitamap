/**
 * spoiler-free.ts
 *
 * Manages the "Spoiler-free" mode: hides ALL item identities on the map.
 * - Wand sprites → wand:handgun, label "Wand"
 * - Spell sprites → spell:_unidentified, label "Spell"
 * - Everything else → spell:_unidentified, label "Something"
 * - Popups show no detailed data (no spells, materials, contents, etc.)
 * - Persisted in localStorage, ON by default
 */

const STORAGE_KEY = "noitamap-spoiler-free";

// Default to OFF — users who want to hide spoilers toggle it on
const stored = localStorage.getItem(STORAGE_KEY);
let _enabled: boolean = stored === null ? false : stored === "1";

const _listeners: ((enabled: boolean) => void)[] = [];

export function isSpoilerFree(): boolean {
  return _enabled;
}

export function setSpoilerFree(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  _sfCache.clear(); // invalidate cache on change
  for (const fn of _listeners) fn(enabled);
}

export function onSpoilerFreeChange(cb: (enabled: boolean) => void): void {
  _listeners.push(cb);
}

/**
 * Classify a sprite key into a spoiler-free category.
 */
export type SpoilerCategory = "wand" | "spell" | "something";

export function getSpoilerCategory(key: string): SpoilerCategory {
  if (key.startsWith("wand:")) return "wand";
  if (key.startsWith("spell:")) return "spell";
  return "something";
}

/**
 * Get the display label for a spoiler-free category.
 */
export function getSpoilerLabel(category: SpoilerCategory): string {
  switch (category) {
    case "wand": return "Wand";
    case "spell": return "Spell";
    case "something": return "Something";
  }
}

// Per-atlas cache: avoids repeated string/atlas lookups in hot tile-render loops
const _sfCache = new Map<string, string>();

/**
 * Apply spoiler-free transformations to a sprite key.
 * Returns the original key if spoiler-free is off.
 * Hot path — results are cached per key for the lifetime of the session.
 */
export function applySpoilerFree(
  key: string,
  atlas: Record<string, unknown>,
): string {
  if (!_enabled) return key;

  const cached = _sfCache.get(key);
  if (cached !== undefined) return cached;

  let result: string;
  const category = getSpoilerCategory(key);
  switch (category) {
    case "wand":
      result = atlas["wand:handgun"] ? "wand:handgun" : key;
      break;
    case "spell":
      if (!key.endsWith("_unidentified")) {
        const unidentified = `${key}_unidentified`;
        if (atlas[unidentified]) { result = unidentified; break; }
      }
      result = atlas["spell:_unidentified"] ? "spell:_unidentified" : key;
      break;
    case "something":
      result = atlas["spell:_unidentified"] ? "spell:_unidentified" : key;
      break;
  }

  _sfCache.set(key, result);
  return result;
}
