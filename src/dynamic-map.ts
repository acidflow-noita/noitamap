/**
 * dynamic-map.ts
 *
 * Orchestrates the complete dynamic map pipeline:
 *   1. Resolve seed (URL param → daily fetch → set URL)
 *   2. Check IndexedDB tile cache
 *   3. Load data.zip (browser-cached)
 *   4. Run telescope generation pipeline
 *   5. Cache result in IndexedDB
 *   6. Render tiles + POIs + pixel scenes onto OSD
 *   7. Index POIs into FlexSearch for dynamic search
 */

import { fetchDailySeed } from "./data_sources/daily_seed";
import { parseURL, updateURLWithSeed, clearSeedParams } from "./data_sources/url";
import { getCachedGeneration, cacheGeneration } from "./telescope/tile-cache";
import { generateDynamicMap, initTelescope, type GenerationResult } from "./telescope/telescope-adapter";
import { getUnlocksFromURL, unlocksChanged, UNLOCK_KEYS } from "./unlocks";
import {
  renderGenerationResult,
  clearDynamicOverlays,
  getAllPOIsFlat,
  hasDynamicOverlays,
  ensurePersistentBiomeBackgrounds,
  resetPersistentBiomeBackgrounds,
} from "./telescope/telescope-osd-bridge";

// ─── Types & state ───────────────────────────────────────────────────────────

export interface DynamicMapOptions {
  /** OSD viewer instance */
  viewer: any;
  /** Called with flat POI list so dynamic search can index it */
  onPOIsReady?: (pois: DynamicPOI[]) => void;
  /** Called when generation starts / ends (for loading indicator) */
  onLoadingChange?: (isLoading: boolean) => void;
  /** Called with the seed that was used (after resolution) */
  onSeedResolved?: (seed: number, isDaily: boolean) => void;
}

export interface DynamicPOI {
  id: string;
  type: string;
  item?: string;
  name?: string;
  pw: number;
  worldX: number;
  worldY: number;
  [key: string]: any;
}

let currentSeed: number | null = null;
let currentIsDaily: boolean = false;
let currentUnlocksKey: string | null = null;
let lastResult: GenerationResult | null = null;
let dynamicRendered: boolean = false;
let generationToken: number = 0;

/** Get the seed currently displayed on the dynamic map */
export function getCurrentDynamicSeed(): number | null {
  return currentSeed;
}

export function getCurrentIsDaily(): boolean {
  return currentIsDaily;
}

export function getLastGenerationResult(): GenerationResult | null {
  return lastResult;
}

// ─── Seed resolution ─────────────────────────────────────────────────────────

/**
 * Work out which seed to use based on URL params.
 * - ?ds=1 present → fetch daily seed, update ?se=<num>&?ds=1 in URL
 * - ?se=<num> without ?ds → use directly (arbitrary seed)
 * - Neither present → treat as daily seed (fetch + set both params)
 */
export async function resolveSeed(): Promise<{ seed: number; isDaily: boolean }> {
  const urlState = parseURL();

  if (urlState.seed !== undefined && !urlState.dailySeed) {
    // Arbitrary seed — already in URL, no fetch needed
    return { seed: urlState.seed, isDaily: false };
  }

  // Daily seed path (explicit ds=1 OR no params at all)
  try {
    const seed = await fetchDailySeed();
    updateURLWithSeed(seed, true);
    return { seed, isDaily: true };
  } catch (err) {
    console.warn("[DynamicMap] Daily seed fetch failed, using fallback:", err);
    // Fallback: use a deterministic seed based on UTC date so every visitor
    // still sees the same map even when the Nolla endpoint is unreachable.
    const dateStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    let hash = 0;
    for (let i = 0; i < dateStr.length; i++) {
      hash = (hash * 31 + dateStr.charCodeAt(i)) | 0;
    }
    const fallbackSeed = Math.abs(hash) % 2147483647 || 1;
    updateURLWithSeed(fallbackSeed, true);
    return { seed: fallbackSeed, isDaily: true };
  }
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

/**
 * Run the full dynamic map pipeline for a given seed.
 * Safe to call multiple times — clears previous overlays first.
 */
export async function runDynamicMap(
  seed: number,
  isDailyParam: boolean,
  opts: DynamicMapOptions,
): Promise<GenerationResult | null> {
  const { viewer, onLoadingChange, onPOIsReady, onSeedResolved } = opts;

  // Auto-detect daily seed: if not explicitly daily, compare against today's daily.
  // This handles the mod sending ?se=<seed> without ds=1 when the player is on a daily run.
  let isDaily = isDailyParam;
  if (!isDaily) {
    try {
      const dailySeed = await fetchDailySeed();
      if (dailySeed === seed) {
        isDaily = true;
        console.log(`[DynamicMap] Seed ${seed} matches today's daily seed, auto-detecting as daily`);
        // Update URL to reflect daily status so the UI shows correctly on reload
        (await import("./data_sources/url")).updateURLWithSeed(seed, true);
      }
    } catch {
      // Daily seed fetch failed — continue as non-daily
    }
  }

  // Read unlock state from URL (caches to localStorage automatically)
  const unlocks = getUnlocksFromURL();
  const unlockKey = unlocks ? unlocks.sort().join(",") : "all";

  // 0. Skip only if same seed, same unlocks, and overlays still present.
  if (seed === currentSeed && unlockKey === currentUnlocksKey && dynamicRendered && hasDynamicOverlays()) {
    console.log(`[DynamicMap] Seed ${seed} is already active with same unlocks, skipping redundant render.`);
    // Still re-emit POIs so search is populated (it may have been cleared)
    if (onPOIsReady && lastResult) {
      const flat = getAllPOIsFlat(lastResult);
      const dynamicPOIs: DynamicPOI[] = flat.map((p, i) => ({
        ...p,
        id: `d-${i}`,
        name: buildPOIName(p),
      }));
      onPOIsReady(dynamicPOIs);
    }
    onLoadingChange?.(false);
    return lastResult;
  }

  // If unlocks changed for the same seed, we must regenerate (skip cache)
  const forceRegenerate = seed === currentSeed && unlockKey !== currentUnlocksKey;

  onLoadingChange?.(true);

  // Capture token so we can detect if clearDynamicMap was called mid-pipeline
  const myToken = ++generationToken;

  // Yield so the browser can paint the loading indicator before telescope
  // blocks the main thread during initialization (~700ms first load).
  await new Promise((r) => setTimeout(r, 0));
  if (myToken !== generationToken) { onLoadingChange?.(false); return null; }

  // Ensure persistent biome backgrounds are present in OSD — fills the
  // biome boundary shapes with correct textures so there are no "black holes".
  // Only does work on the first call; subsequent calls are no-ops.
  await ensurePersistentBiomeBackgrounds(viewer);

  currentSeed = seed;
  currentIsDaily = isDaily;
  currentUnlocksKey = unlockKey;

  onSeedResolved?.(seed, isDaily);

  try {
     // 0b. Ensure telescope is initialized (runs LIB_VERSION cache bust BEFORE cache check)
    await initTelescope();
    if (myToken !== generationToken) { onLoadingChange?.(false); return null; }

    // 1. Check cache (skip if unlocks changed for same seed)
    let t = performance.now();
    let result: GenerationResult | null = null;
    const cacheKey = `${seed}-${unlockKey}`;
    
    if (!forceRegenerate) {
      console.log(`[DynamicMap] Checking cache for key ${cacheKey}...`);
      result = await getCachedGeneration(cacheKey);
      console.log(`[DynamicMap] Cache check: ${((performance.now() - t) / 1000).toFixed(2)}s (${result ? "HIT" : "MISS"})`);
    } else {
      console.log(`[DynamicMap] Unlocks changed, forcing regeneration for key ${cacheKey}`);
    }

    if (!result) {
      // 2. Generate with unlock state
      t = performance.now();
      console.log(`[DynamicMap] Generating seed ${seed} (unlocks: ${unlocks ? unlocks.length + "/" + UNLOCK_KEYS.length : "all"})...`);
      result = await generateDynamicMap({ seed, ngPlus: 0, dailySeed: isDaily, unlocks });
      if (myToken !== generationToken) { onLoadingChange?.(false); return null; }
      console.log(`[DynamicMap] Generation: ${((performance.now() - t) / 1000).toFixed(2)}s`);

      // 3. Store in cache (fire-and-forget -- don't block render)
      cacheGeneration(cacheKey, seed, result).catch((e) => console.warn("[DynamicMap] Cache write failed:", e));
    }

    // 4. Stamp orb POIs with collected flag based on current unlock state.
    //    Daily seed: NEVER mark as collected — always show orbs with spells inside,
    //    since players want to see where all the spells are.
    //    Non-daily: mark collected orbs as empty (spell already taken in a prior run).
    const ORB_UNLOCK_KEYS = [
      "sea_lava", "crumbling_earth", "tentacle", "nuke", "necromancy",
      "bomb_holy", "spiral_shot", "cloud_thunder", "firework",
      "exploding_deer", "material_cement",
    ];
    if (unlocks && !isDaily) {
      const unlockSet = new Set(unlocks);
      for (const pois of Object.values(result.poisByPW)) {
        let orbCounter = 0;
        for (const poi of pois) {
          if (poi.type === "item" && poi.item === "orb") {
            // Assign orbIndex if missing (e.g. from old cached data)
            if ((poi as any).orbIndex == null) (poi as any).orbIndex = orbCounter;
            const idx = (poi as any).orbIndex;
            const key = typeof idx === "number" ? ORB_UNLOCK_KEYS[idx] : (poi as any).unlockKey;
            (poi as any).collected = key ? unlockSet.has(key) : false;
            orbCounter++;
          }
        }
      }
    }

    // 4.5. Assign persistent IDs to POIs recursively so nested items (e.g., boss drops, spawned wands) can be deep-linked
    let globalPoiIndex = 0;
    const assignIds = (poiArr: any[]) => {
      if (!Array.isArray(poiArr)) return;
      for (const poi of poiArr) {
        if (!poi.id) {
          poi.id = `d-${globalPoiIndex++}`;
        }
        if (poi.items) {
          assignIds(poi.items);
        }
      }
    };
    for (const pois of Object.values(result.poisByPW)) {
      assignIds(pois as any[]);
    }

    // 5. Render onto OSD (skeleton placeholders are removed inside after real biome backgrounds load)
    t = performance.now();
    console.log(
      `[DynamicMap] Rendering seed ${seed} with ${result.parallelWorlds?.length || 3} worlds, worldCenter=${result.worldCenter}`,
    );
    await renderGenerationResult(viewer as any, result, unlocks, isDaily);
    if (myToken !== generationToken) { onLoadingChange?.(false); return null; }
    console.log(`[DynamicMap] Render: ${((performance.now() - t) / 1000).toFixed(2)}s`);
    lastResult = result;
    dynamicRendered = true;

    // Log summary of what was generated
    const allPois = Object.values(result.poisByPW).flat();
    const poiCounts = allPois.reduce(
      (acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    console.log("[Telescope] Generated PoI summary:", poiCounts);

    // 5. Export flat POI list for search
    t = performance.now();
    if (onPOIsReady) {
      const flat = getAllPOIsFlat(result);
      const dynamicPOIs: DynamicPOI[] = flat.map((p) => ({
        ...p,
        id: (p as any).id,
        name: buildPOIName(p),
      }));
      onPOIsReady(dynamicPOIs);
    }
    console.log(`[DynamicMap] POI export + index: ${((performance.now() - t) / 1000).toFixed(2)}s`);

    return result;
  } catch (err) {
    console.error("[DynamicMap] Pipeline failed:", err);
    return null;
  } finally {
    onLoadingChange?.(false);
  }
}

/**
 * Convenience wrapper: resolve seed from URL then run the full pipeline.
 */
export async function runDynamicMapFromURL(opts: DynamicMapOptions): Promise<GenerationResult | null> {
  const { seed, isDaily } = await resolveSeed();
  return runDynamicMap(seed, isDaily, opts);
}

/**
 * Clear all dynamic overlays from the viewer.
 */
export function clearDynamicMap(viewer: any): void {
  clearDynamicOverlays(viewer);
  resetPersistentBiomeBackgrounds();
  currentSeed = null;
  currentIsDaily = false;
  currentUnlocksKey = null;
  dynamicRendered = false;
  generationToken++;
  clearSeedParams();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPOIName(p: any): string {
  if (p.type === "wand" && p.name) return p.name;
  if (p.item) return p.item;
  if (p.type === "entity" && p.entity) return p.entity;
  if (p.name) return p.name;
  if (p.type) return p.type;
  return "Unknown";
}
