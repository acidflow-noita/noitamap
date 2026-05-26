/**
 * Unlocks-toggle: per-POI-card view-mode flip between the seed's unlock
 * variants. Three variants exist conceptually:
 *
 *   "all"  — every spell-unlock enabled. Telescope's native default.
 *   "none" — nothing unlocked. Strictest possible spell pool.
 *   "mod"  — the unlock list supplied via the `?u=` URL param (the
 *            noitamap in-game mod reads save00 and deeplinks here).
 *
 * Without `?u=`: the active toggle has TWO states — "all" ↔ "none".
 * With    `?u=`: THREE states — "mod" → "all" → "none" → "mod" → ...
 *
 * The PRIMARY variant is the one used to generate the visible map:
 *   - no `?u=`  → "all"
 *   - with `?u=`→ "mod"
 *
 * Non-primary variants are generated in the background after the primary
 * render finishes (biome layout is identical between variants, so the cost
 * is just POI/wand/chest rolls). POI tooltip cards swap their contents
 * instantly once the requested variant is ready; until then they show an
 * "indexing" placeholder on the lock button.
 *
 * The active view is persisted in localStorage so it survives reloads.
 * Whenever the `?u=` value changes (mod re-deeplinks with fresh save00
 * data), the view is reset to "mod"/primary so the freshest data is shown.
 */

import { generateDynamicMap, type GenerationResult } from "./telescope/telescope-adapter";
import { getUnlocksFromURL } from "./unlocks";
import { isLightMode } from "./light-mode";

export type UnlockDescriptor = "all" | "none" | "mod";

const VIEW_STORAGE = "noitamap-unlocks-view";
const URL_KEY_STORAGE = "noitamap-unlocks-url-key";

// Per-seed, per-descriptor cache. Keys: `${seed}|${descriptor}`.
const altCache = new Map<string, GenerationResult>();
const altIndexes = new Map<string, Map<string, any>>();
const pendingDescriptors = new Set<string>();
let readyListeners: Array<() => void> = [];
let viewListeners: Array<(v: UnlockDescriptor) => void> = [];

let lastSeedSeen: number | null = null;

/** True if the page was opened with a `?u=` URL parameter — i.e. the
 *  noitamap in-game mod supplied a fresh unlock list from save00. */
export function isModSourced(): boolean {
  return new URLSearchParams(window.location.search).has("u");
}

/** Set of view descriptors the user can cycle through. */
export function availableDescriptors(): UnlockDescriptor[] {
  return isModSourced() ? ["mod", "all", "none"] : ["all", "none"];
}

/** Which variant is used to *generate* the visible map / primary POI list. */
export function primaryDescriptor(): UnlockDescriptor {
  return isModSourced() ? "mod" : "all";
}

/** Reset persisted view if the `?u=` value just changed (mod re-deeplink). */
function resetViewIfModChanged(): void {
  try {
    const cur = new URLSearchParams(window.location.search).get("u") || "";
    const last = localStorage.getItem(URL_KEY_STORAGE) || "";
    if (cur !== last) {
      localStorage.setItem(URL_KEY_STORAGE, cur);
      localStorage.setItem(VIEW_STORAGE, primaryDescriptor());
    }
  } catch { /* private mode etc. */ }
}

export function getActiveDescriptor(): UnlockDescriptor {
  resetViewIfModChanged();
  let stored: string | null = null;
  try { stored = localStorage.getItem(VIEW_STORAGE); } catch { /* noop */ }
  const allowed = availableDescriptors();
  if (stored && (allowed as string[]).includes(stored)) return stored as UnlockDescriptor;
  return primaryDescriptor();
}

export function setActiveDescriptor(desc: UnlockDescriptor): void {
  try { localStorage.setItem(VIEW_STORAGE, desc); } catch { /* noop */ }
  for (const cb of viewListeners) cb(desc);
}

export function onActiveDescriptorChange(cb: (v: UnlockDescriptor) => void): () => void {
  viewListeners.push(cb);
  return () => { viewListeners = viewListeners.filter((c) => c !== cb); };
}

/** Cycle to the next allowed descriptor in the configured order. */
export function cycleDescriptor(): UnlockDescriptor {
  const all = availableDescriptors();
  const idx = all.indexOf(getActiveDescriptor());
  const next = all[(idx + 1) % all.length];
  setActiveDescriptor(next);
  return next;
}

/** Bitmap icon class for each descriptor (per user spec: controller for mod). */
export function descriptorIcon(desc: UnlockDescriptor): string {
  if (desc === "mod") return "bi-controller";
  return desc === "none" ? "bi-lock-fill" : "bi-unlock-fill";
}

/** Translates a descriptor to the raw unlocks list passed into telescope. */
function descriptorToUnlocks(desc: UnlockDescriptor): string[] | null {
  if (desc === "all") return null;
  if (desc === "none") return [];
  // "mod" — reuse the URL/localStorage value.
  return getUnlocksFromURL();
}

/** True when this descriptor's POI data is available (either it's the
 *  primary — which is always live — or the alt cache has it). */
export function isVariantReady(desc: UnlockDescriptor, seed?: number): boolean {
  if (desc === primaryDescriptor()) return true;
  const s = seed ?? lastSeedSeen;
  if (s == null) return false;
  return altCache.has(`${s}|${desc}`);
}

/** Look up the POI's variant by primary id. Returns null if the variant
 *  isn't cached (caller should fall back to primary or show indexing). */
export function getPoiVariant(desc: UnlockDescriptor, primaryId: string | undefined): any | null {
  if (!primaryId) return null;
  if (desc === primaryDescriptor()) return null; // caller already has primary
  const s = lastSeedSeen;
  if (s == null) return null;
  const idx = altIndexes.get(`${s}|${desc}`);
  return idx?.get(primaryId) ?? null;
}

export function onAltReady(cb: () => void): () => void {
  readyListeners.push(cb);
  return () => { readyListeners = readyListeners.filter((c) => c !== cb); };
}

/** Walk a flat POI tree and index every node by id. */
function indexPois(result: GenerationResult): Map<string, any> {
  const map = new Map<string, any>();
  const walk = (arr: any[]) => {
    for (const p of arr) {
      if (p?.id) map.set(p.id, p);
      if (Array.isArray(p?.items)) walk(p.items);
    }
  };
  for (const pois of Object.values(result.poisByPW)) walk(pois as any[]);
  return map;
}

/** Generate one alt variant for the given seed + descriptor. Idempotent;
 *  silently swallows races (seed-change cancellation, multiple callers
 *  for the same key, etc.). Resolves after the variant is in cache (or
 *  failed). */
async function ensureVariant(seed: number, isDaily: boolean, desc: UnlockDescriptor): Promise<void> {
  const cacheKey = `${seed}|${desc}`;
  if (altCache.has(cacheKey) || pendingDescriptors.has(cacheKey)) return;
  if (desc === primaryDescriptor()) return; // primary is always live, not cached here
  pendingDescriptors.add(cacheKey);
  try {
    const result = await generateDynamicMap({
      seed,
      ngPlus: 0,
      dailySeed: isDaily,
      unlocks: descriptorToUnlocks(desc),
      parallelWorlds: isLightMode() ? [0] : undefined,
    });
    // Mirror dynamic-map.ts's id-assignment so ids align with the primary
    // result — same biome layout means same traversal order.
    let idx = 0;
    const assign = (arr: any[]) => {
      for (const p of arr) {
        if (!p.id) p.id = `d-${idx++}`;
        if (Array.isArray(p.items)) assign(p.items);
      }
    };
    for (const pois of Object.values(result.poisByPW)) assign(pois as any[]);
    altCache.set(cacheKey, result);
    altIndexes.set(cacheKey, indexPois(result));
    const listeners = readyListeners.slice();
    for (const cb of listeners) {
      try { cb(); } catch { /* swallow */ }
    }
  } catch (e) {
    console.warn(`[unlocks-toggle] variant ${desc} pre-warm failed:`, e);
  } finally {
    pendingDescriptors.delete(cacheKey);
  }
}

/** Background pre-warm of every non-primary variant. Called after the
 *  primary render completes; fires the generations sequentially so we
 *  don't thrash telescope's PRNG / cache. */
export async function prewarmAlt(seed: number, isDaily: boolean): Promise<void> {
  lastSeedSeen = seed;
  const primary = primaryDescriptor();
  for (const desc of availableDescriptors()) {
    if (desc === primary) continue;
    // Sequential — telescope generation isn't cheap and we don't want to
    // contend with the user's next interaction.
    await ensureVariant(seed, isDaily, desc);
  }
}

/** Request a specific variant on demand (e.g. user clicks the lock toggle
 *  before the background pre-warm got to that descriptor). Resolves once
 *  the variant is ready, or rejects if generation fails. */
export async function requestVariant(desc: UnlockDescriptor): Promise<void> {
  const s = lastSeedSeen;
  if (s == null) return;
  if (isVariantReady(desc, s)) return;
  // We need isDaily to regenerate; not stored here. Pass false — daily
  // worlds always pre-warm with all-unlocked anyway, and the alt for the
  // mod case isn't a daily.
  await ensureVariant(s, /* isDaily */ false, desc);
}

/** Reset cache when seed changes. */
export function resetAltCache(): void {
  altCache.clear();
  altIndexes.clear();
  pendingDescriptors.clear();
  readyListeners = [];
  lastSeedSeen = null;
}

// Debug
if (typeof window !== "undefined") {
  (window as any).__unlocksState = () => ({
    modSourced: isModSourced(),
    primary: primaryDescriptor(),
    active: getActiveDescriptor(),
    available: availableDescriptors(),
    seed: lastSeedSeen,
    cached: Array.from(altCache.keys()),
    pending: Array.from(pendingDescriptors),
  });
}
