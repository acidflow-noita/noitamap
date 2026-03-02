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

import { fetchDailySeed } from './data_sources/daily_seed';
import { parseURL, updateURLWithSeed } from './data_sources/url';
import { getCachedGeneration, cacheGeneration } from './telescope/tile-cache';
import { generateDynamicMap, type GenerationResult } from './telescope/telescope-adapter';
import { renderGenerationResult, clearDynamicOverlays, getAllPOIsFlat } from './telescope/telescope-osd-bridge';

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

/** Get the seed currently displayed on the dynamic map */
export function getCurrentDynamicSeed(): number | null {
  return currentSeed;
}

export function getCurrentIsDaily(): boolean {
  return currentIsDaily;
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

  if (urlState.dailySeed || (urlState.seed === undefined && urlState.dailySeed === undefined)) {
    // Daily seed path (explicit ds=1 OR no params at all)
    const seed = await fetchDailySeed();
    updateURLWithSeed(seed, true);
    return { seed, isDaily: true };
  }

  if (urlState.seed !== undefined) {
    // Arbitrary seed — already in URL, no fetch needed
    return { seed: urlState.seed, isDaily: false };
  }

  // Fallback: daily
  const seed = await fetchDailySeed();
  updateURLWithSeed(seed, true);
  return { seed, isDaily: true };
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

/**
 * Run the full dynamic map pipeline for a given seed.
 * Safe to call multiple times — clears previous overlays first.
 */
export async function runDynamicMap(
  seed: number,
  isDaily: boolean,
  opts: DynamicMapOptions,
): Promise<GenerationResult | null> {
  const { viewer, onLoadingChange, onPOIsReady, onSeedResolved } = opts;

  currentSeed = seed;
  currentIsDaily = isDaily;

  onLoadingChange?.(true);
  onSeedResolved?.(seed, isDaily);

  try {
    // 1. Check cache
    console.log(`[DynamicMap] Checking cache for seed ${seed}…`);
    let result: GenerationResult | null = await getCachedGeneration(seed);

    if (!result) {
      // 2. Generate
      console.log(`[DynamicMap] Cache miss — generating seed ${seed}…`);
      result = await generateDynamicMap({ seed, ngPlus: 0, dailySeed: isDaily });

      // 3. Store in cache (fire-and-forget — don't block render)
      cacheGeneration(seed, result).catch(e =>
        console.warn('[DynamicMap] Cache write failed:', e),
      );
    }

    // 4. Render onto OSD
    renderGenerationResult(viewer as any, result);

    // 5. Export flat POI list for search
    if (onPOIsReady) {
      const flat = getAllPOIsFlat(result);
      const dynamicPOIs: DynamicPOI[] = flat.map((p, i) => ({
        ...p,
        id: `dyn-${i}`,
        name: buildPOIName(p),
      }));
      onPOIsReady(dynamicPOIs);
    }

    return result;
  } catch (err) {
    console.error('[DynamicMap] Pipeline failed:', err);
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
  currentSeed = null;
  currentIsDaily = false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPOIName(p: any): string {
  if (p.item) return p.item;
  if (p.name) return p.name;
  if (p.type) return p.type;
  return 'Unknown';
}
