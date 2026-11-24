import { dailyMapPrefix } from "./telescope/daily-bake-status";
import { NIGHTMARE_DEFAULT_SEED, type DynamicGameMode } from "./data_sources/tile_data";
import { isInstantTerrainEnabled, shouldUseBakedTerrain } from "./renderer_settings";
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

import { addBakedWorlds, beginDynamicRequest, generationToken, type InitialDaily } from "./initial-daily";
import { fetchDailySeed, fetchPreviousDailySeed } from "./data_sources/daily_seed";
import { parseURL, updateURLWithSeed, clearSeedParams } from "./data_sources/url";
import { getCachedGeneration, cacheGeneration } from "./telescope/tile-cache";
import { generateDynamicMap, initTelescope, prewarmParallelWorlds, releaseParallelWorlds, type GenerationResult } from "./telescope/telescope-adapter";
import { ensureTelescopeCacheVersion } from "./telescope/telescope-cache-version";
import { prewarmInstantTerrain, releaseInstantTerrainBackend } from "./telescope/instant-terrain-backend";
import { getUnlocksFromURL, unlocksChanged, UNLOCK_KEYS, getUrlUnlockKind } from "./unlocks";
import { getPillarFlagsFromURL } from "./pillars-unlocks";
import { beginAltSeed, prewarmAlt, resetAltCache } from "./unlocks-toggle";
import { isLightMode } from "./light-mode";
import { createScenePrefetchGate } from "./telescope/scene-prefetch-gate";
import {
  renderGenerationResult,
  clearDynamicOverlays,
  cancelPendingDynamicTerrain,
  getAllPOIsFlat,
  hasDynamicOverlays,
  ensurePersistentBiomeBackgrounds,
  resetPersistentBiomeBackgrounds,
  prefetchAllSceneBitmaps,
  prepareInstantTerrainResources,
  prewarmMapPresentation,
} from "./telescope/telescope-osd-bridge";
import { probeBakedDZIs, isLocalBakeView, type BakedDziProbeResult } from "./telescope/baked-dzi-loader";
import { perkNameKey } from "./telescope/perk-i18n";
import { gameTranslator } from "./game-translations/translator";

// ─── Types & state ───────────────────────────────────────────────────────────

export interface DynamicMapOptions {
  gameMode?: DynamicGameMode;
  ngPlus?: number;
  /** OSD viewer instance */
  viewer: any;
  /** Called with flat POI list so dynamic search can index it */
  onPOIsReady?: (pois: DynamicPOI[]) => void;
  /** Invalidate outgoing interactions immediately, before seed resolution awaits network work. */
  onMapReplacementStart?: () => void;
  /** Covers the whole current request, including lookup, metadata and failures. */
  onRequestStateChange?: (pending: boolean) => void;
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

let currentGameMode: DynamicGameMode = "normal";
let currentNGPlus = 0;
export function getCurrentNGPlus(): number { return currentNGPlus; }
let currentSeed: number | null = null;
let currentIsDaily: boolean = false;
let currentUnlocksKey: string | null = null;
let currentAllowsBaked: boolean | null = null;
let lastResult: GenerationResult | null = null;
let dynamicRendered: boolean = false;
let scenePrefetchLifetime: AbortController | undefined;
/** Get the seed currently displayed on the dynamic map */
export function getCurrentDynamicSeed(): number | null {
  return currentSeed;
}

/** Only a completed presentation can make Generate a no-op. */
export function getCompletedDynamicSeed(): number | null {
  return dynamicRendered ? currentSeed : null;
}

export function getCurrentIsDaily(): boolean {
  return currentIsDaily;
}

export function getLastGenerationResult(): GenerationResult | null {
  return lastResult;
}

// ─── Background comparison-seed prewarm (seed report) ────────────────────────

/** Cache key for a daily-style (all-unlocks) generation of `seed`. Must match
 *  the key the live daily render writes (including the light-mode suffix) so
 *  the seed-report comparison lookup hits. Dailies always render all-unlocked,
 *  so the unlock portion is always "all". */
function generationCacheKey(seed: number, unlockKey: string, isDaily: boolean, mode: DynamicGameMode, ngPlus = 0): string {
  return `${seed}-${unlockKey}${ngPlus > 0 ? `|ng-plus-${ngPlus}` : ""}${mode === "nightmare" ? "|nightmare-wang-v3" : ""}${isDaily ? "|daily-loadout-v1" : ""}`;
}
export function dailyCacheKey(seed: number): string {
  return generationCacheKey(seed, `all${isLightMode() ? "|lm" : ""}|p-`, currentGameMode === "normal", currentGameMode, currentNGPlus);
}

// Dedupe concurrent requests for the same seed; serialize the heavy
// generations so at most one background gen runs at a time.
const pendingSeedCaches = new Map<string, Promise<boolean>>();
let bgGenChain: Promise<unknown> = Promise.resolve();

/**
 * Ensure a seed's POIs are generated and cached in IndexedDB for the seed
 * report's background comparison. Never renders and never reads the live map's
 * OSD state, so it is safe once the current map has settled (the seed report
 * calls it only after indexing is "ready"). Resolves true when the seed is
 * cached (already present or freshly generated), false on failure.
 */
export function ensureSeedCached(seed: number, isDaily: boolean): Promise<boolean> {
  const lightMode = isLightMode();
  const gameMode = currentGameMode, ngPlus = currentNGPlus;
  const daily = isDaily && gameMode === "normal";
  const key = generationCacheKey(seed, `all${lightMode ? "|lm" : ""}|p-`, daily, gameMode, ngPlus);
  const existing = pendingSeedCaches.get(key);
  if (existing) return existing;

  const run = (async (): Promise<boolean> => {
    try {
      if (await getCachedGeneration(key)) return true;
    } catch {
      /* cache read failed - fall through and regenerate */
    }

    const gen = bgGenChain.then(async () => {
      await initTelescope();
      return generateDynamicMap({
        seed,
        ngPlus,
        dailySeed: daily,
        gameMode,
        unlocks: null,
        parallelWorlds: lightMode ? [0] : undefined,
      });
    });
    // Keep the serial chain alive even if this generation throws.
    bgGenChain = gen.catch(() => undefined);

    const result = await gen;
    if (!result) return false;
    await cacheGeneration(key, seed, result);
    return true;
  })()
    .catch((e) => {
      console.warn(`[DynamicMap] ensureSeedCached(${seed}) failed:`, e);
      return false;
    })
    .finally(() => {
      pendingSeedCaches.delete(key);
    });

  pendingSeedCaches.set(key, run);
  return run;
}

// ─── Seed resolution ─────────────────────────────────────────────────────────

/**
 * Work out which seed to use based on URL params.
 * - ?se=<num> present → use that exact seed; ?ds=1 preserves daily mode
 * - ?ds=1 without ?se → fetch today's seed and pin it in the URL
 * - Neither present → treat as daily seed (fetch + set both params)
 */
export async function resolveSeed(isCurrent = () => true, requirePublishedDaily = false, startupSeed?: Promise<number>, gameMode: DynamicGameMode = "normal"): Promise<{ seed: number; isDaily: boolean }> {
  const urlState = parseURL();
  if (gameMode === "nightmare") {
    const seed = urlState.seed ?? NIGHTMARE_DEFAULT_SEED;
    if (isCurrent()) updateURLWithSeed(seed, false);
    return { seed, isDaily: false };
  }

  if (urlState.seed !== undefined) {
    // Shared daily links must keep their explicit seed even after rollover.
    // ds controls generation mode; it never overrides an explicit identity.
    return { seed: urlState.seed, isDaily: !!urlState.dailySeed };
  }

  // No seed identity: daily-only links and the default map resolve today.
  // A failed lookup must never invent a seed and label it as today's Daily.
  // Leave the URL unchanged so retry can resolve the published seed.
  const seed = await (startupSeed ?? fetchDailySeed(requirePublishedDaily));
  if (isCurrent()) updateURLWithSeed(seed, true);
  return { seed, isDaily: true };
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
  const myToken = beginDynamicRequest();
  try {
    opts.onRequestStateChange?.(true);
    if (myToken !== generationToken) return null;
    return await runDynamicMapRequest(seed, isDailyParam, opts, myToken);
  } finally {
    if (myToken === generationToken) opts.onRequestStateChange?.(false);
  }
}

async function runDynamicMapRequest(
  seed: number,
  isDailyParam: boolean,
  opts: DynamicMapOptions,
  myToken: number,
  initialDaily?: InitialDaily,
): Promise<GenerationResult | null> {
  const { viewer, onLoadingChange, onPOIsReady, onSeedResolved } = opts;
  const runStarted = performance.now();
  scenePrefetchLifetime?.abort();
  scenePrefetchLifetime = undefined;
  const gameMode = opts.gameMode ?? "normal";
  if (gameMode === "nightmare" && parseURL().dailySeed) updateURLWithSeed(seed, false);
  const ngPlus = gameMode === "nightmare" ? 0 : opts.ngPlus ?? 0;
  const modeChanged = currentGameMode !== gameMode || ngPlus !== currentNGPlus;
  beginAltSeed(seed, gameMode, ngPlus);
  opts.onMapReplacementStart?.();
  if (myToken !== generationToken) return null;

  const noBaked = ngPlus > 1 || !shouldUseBakedTerrain(window.location.search) || (gameMode === "nightmare" && seed !== NIGHTMARE_DEFAULT_SEED);
  // These changes already require replacement, before Daily detection can
  // await the network. Stop old cooking/late attachments, retain drawn frames.
  const retiredEarly = modeChanged || seed !== currentSeed || currentAllowsBaked !== !noBaked || !dynamicRendered;
  if (retiredEarly) {
    dynamicRendered = false; // returning to this seed must restart its stopped renderer
    cancelPendingDynamicTerrain();
  }
  if (noBaked && isInstantTerrainEnabled()) {
    prewarmInstantTerrain();
    prewarmMapPresentation(ngPlus ? "ng-plus" : gameMode);
    prewarmParallelWorlds(isLightMode() ? [0] : undefined);
  }
  // Explicit live GPU requests need these assets regardless of daily identity.
  // Download/decode them while the daily lookup runs, preserving its unlock rules.
  // Capture rejection immediately; an obsolete request may never await this work.
  const earlyInit = noBaked && isInstantTerrainEnabled()
    ? initTelescope().then(() => null, error => ({ error }))
    : null;

  // Auto-detect daily seed: if not explicitly daily, compare against today's daily.
  // This handles the mod sending ?se=<seed> without ds=1 when the player is on a daily run.
  let isDaily = gameMode === "normal" && (isDailyParam || isLocalBakeView());
  if (!isDaily && gameMode === "normal") {
    try {
      const dailySeed = await fetchDailySeed();
      if (myToken !== generationToken) return null;
      if (dailySeed === seed) {
        isDaily = true;
        console.log(`[DynamicMap] Seed ${seed} matches today's daily seed, auto-detecting as daily`);
        // Update URL to reflect daily status so the UI shows correctly on reload
        updateURLWithSeed(seed, true);
      }
    } catch {
      // Daily seed fetch failed — continue as non-daily
    }
  }
  if (myToken !== generationToken) return null;

  // Read unlock state from URL (caches to localStorage automatically).
  // The shareable shorthand tokens (`u=all`, `u=none`) override the mod
  // list — `none` means "render with nothing unlocked", `all` means default.
  let unlocks = getUnlocksFromURL();
  const urlKind = getUrlUnlockKind();
  if (!noBaked && (isDaily || gameMode === "nightmare")) unlocks = null;
  else if (urlKind === "none") unlocks = [];
  // (urlKind === "all" → unlocks stays null → telescope's default = all)
  const lightMode = isLightMode();
  // Dedicated pillar achievement channel (`&p=`). Independent of `&u=`: it only
  // affects pillar segment lock state, but a change must still re-render, so it
  // joins the cache key.
  const pillarFlags = getPillarFlagsFromURL();
  const pillarKey = pillarFlags ? "p" + pillarFlags.length + ":" + pillarFlags.slice().sort().join(",") : "p-";
  const unlockKey = (unlocks ? unlocks.sort().join(",") : "all") + (lightMode ? "|lm" : "") + "|" + pillarKey;

  // A daily button can leave a forced live preview of the very same seed.
  // Its baked/live route is part of presentation identity, not the geometry
  // cache key: the existing pixels must not suppress the baked-map probe.
  if (!modeChanged && seed === currentSeed && unlockKey === currentUnlocksKey && isDaily === currentIsDaily
    && currentAllowsBaked === !noBaked && dynamicRendered && hasDynamicOverlays()) {
    console.log(`[DynamicMap] Seed ${seed} is already active with same unlocks, skipping redundant render.`);
    // Still re-emit POIs so search is populated (it may have been cleared)
    if (onPOIsReady && lastResult) {
      const flat = getAllPOIsFlat(lastResult);
      const dynamicPOIs: DynamicPOI[] = flat.map((p) => ({
        ...p,
        id: (p as any).id,
        name: buildPOIName(p),
      }));
      onPOIsReady(dynamicPOIs);
    }
    onLoadingChange?.(false);
    return lastResult;
  }

  // The requested identity changes before assets/rendering finish. Until the
  // replacement completes, lastResult still belongs to the outgoing map.
  dynamicRendered = false;

  // Early GPU preparation replaces the shared renderer before the new map
  // reaches presentation. Retire the old cooker and lazy plane requests first;
  // its displayed frames remain attached until the replacement first paints.
  if (!retiredEarly) cancelPendingDynamicTerrain();

  // If unlocks changed for the same seed, we must regenerate (skip cache)
  const forceRegenerate = !modeChanged && seed === currentSeed && unlockKey !== currentUnlocksKey;

  onLoadingChange?.(true);

  // Yield so the browser can paint the loading indicator before telescope
  // blocks the main thread during initialization (~700ms first load).
  await new Promise((r) => setTimeout(r, 0));
  if (myToken !== generationToken) return null;

  // The initial viewer may already have queued the validated Daily layers.
  // Every other route probes here before starting the live renderer.
  let bakedAlreadyPainted = false;
  // ?nb=1 disables the baked fast path entirely. The bake page uses it so a
  // re-bake of an already-deployed seed still runs a real local generation
  // (the export hooks need live tileLayers, which the baked path never has).
  // A published bake owns both terrain and POIs. A fetch failure must not turn
  // navigation or a returning visitor's saved mod settings into a world build.
  let bakeOnly = gameMode === "nightmare" && !noBaked;
  const bakedProbePromise: Promise<{ probe: BakedDziProbeResult; generation: GenerationResult | null } | null> = (async () => {
    try {
      if (noBaked) return null;
      // Resolve the prefix with minimal round-trips. fetchDailySeed is already
      // cached (resolveSeed + the fast-path pre-warm), so this is usually free;
      // the previous-daily lookup (an extra request) only fires when the seed
      // isn't today's — keeping the common daily overlay off that RTT.
      let prefix: import("./telescope/baked-dzi-loader").BakedMapPrefix | null =
        gameMode === "nightmare" ? "nightmare" : isLocalBakeView() ? dailyMapPrefix("daily", ngPlus) : null;
      const todayDaily = prefix ? null : await (initialDaily?.today ?? fetchDailySeed()).catch(() => null);
      if (!prefix && todayDaily !== null && seed === todayDaily) {
        prefix = dailyMapPrefix("daily", ngPlus);
      } else if (!prefix) {
        const prevDaily = await fetchPreviousDailySeed().catch(() => null);
        if (prevDaily !== null && seed === prevDaily) prefix = dailyMapPrefix("previous-daily", ngPlus);
        // An explicit historical seed may need generation after both bakes rotate.
        // If identity lookups failed, the browser cannot establish that it rotated.
        if (!prefix && isDaily && (todayDaily === null || prevDaily === null)) bakeOnly = true;
      }
      if (!prefix || myToken !== generationToken) return null;
      bakeOnly = true;
      // Start Daily metadata alongside manifests so tile downloads cannot queue it.
      // Every ordinary Daily uses the published all-unlocked POIs.
      const worlds: ("left" | "middle" | "right")[] = lightMode ? ["middle"] : ["left", "middle", "right"];
      const readDailyMetadata = async (revision = String(seed)) => {
        const { fetchBakedGeneration } = await import("./telescope/baked-generation");
        return fetchBakedGeneration(prefix, worlds, seed, revision);
      };
      const needsRevision = prefix === "nightmare" || ngPlus === 1;
      const generationPromise = needsRevision ? null : readDailyMetadata().catch(() => null);
      const initial = prefix === "daily" || prefix === "ng-plus-daily" ? await initialDaily?.tiles : null;
      if (myToken !== generationToken) return null;
      let probe = initial ?? await probeBakedDZIs(prefix, seed);
      if (!probe.baked && !probe.unpublishedNGPlus && myToken === generationToken)
        probe = await probeBakedDZIs(prefix, seed, AbortSignal.timeout(15000));
      if (myToken !== generationToken) return null;
      if (!probe.baked) {
        // An NG+1 Daily can be opened before the independent baker publishes it.
        // Partial publications and failed POI reads keep their baked ownership.
        if (ngPlus === 1 && probe.unpublishedNGPlus) bakeOnly = false;
        return { probe, generation: null };
      }
      if (myToken === generationToken) {
        if (!initial?.baked) {
          clearDynamicOverlays(viewer);
          addBakedWorlds(viewer, probe, myToken);
        }
        bakedAlreadyPainted = true;
        // Hide live-render controls as soon as the bake is selected; fetching
        // generation.json must not leave a disabled switch visible in between.
        window.dispatchEvent(new CustomEvent("bakedSeedChange", { detail: {
          baked: true, fullPixelsBaked: probe.fullPixelsBaked,
        } }));
        onLoadingChange?.(false);
      }
      let generation = await generationPromise;
      if (!generation && myToken === generationToken) {
        // Nightmare validates metadata against all three manifests. A stale
        // Daily response gets one retry keyed to the publication we just read.
        if (needsRevision) {
          const { fetchBakedGeneration } = await import("./telescope/baked-generation");
          generation = await fetchBakedGeneration(prefix, worlds, seed, probe.renderId, ngPlus === 1 || probe.includesNightmareEdges === true);
        } else {
          generation = await readDailyMetadata(probe.renderId || probe.placements[0]?.bust || String(seed));
        }
      }
      return { probe, generation };
    } catch (e) {
      console.warn("[DynamicMap] baked-DZI probe threw:", e);
      return null;
    }
  })();

  // Background artwork and generation are independent. Start the artwork now,
  // join before presentation, and never attach it to a superseded map. A live
  // request needs no previous-daily lookup; the baked probe alone owns that.
  const backgroundReady = bakedProbePromise.then(async data => {
    if (!ngPlus && gameMode === "normal" && !bakeOnly && !data?.probe.baked && myToken === generationToken) {
      await ensurePersistentBiomeBackgrounds(viewer, () => myToken === generationToken);
    }
  }).catch(error => console.warn("[DynamicMap] Biome background unavailable:", error));

  currentGameMode = gameMode;
  currentNGPlus = ngPlus;
  currentSeed = seed;
  currentIsDaily = isDaily;
  currentUnlocksKey = unlockKey;
  currentAllowsBaked = !noBaked;

  onSeedResolved?.(seed, isDaily);

  try {
    // 0b. Await the probe. Non-daily seeds resolve ~instantly (seed lookups
    // are cached, prefix misses return null immediately). A generation.json
    // hit supplies this seed's biome map, POIs and scenes from the bake.
    // Baked terrain needs no live renderer or speculative asset preparation.
    const bakedData = await bakedProbePromise;
    if (myToken !== generationToken) return null;
    if (bakeOnly && !bakedData?.generation) {
      // Valid pyramids were attached above. Keep those tiles usable even if
      // the matching POI files are unavailable. Selecting the map again retries.
      if (!bakedData?.probe.baked) clearDynamicOverlays(viewer);
      lastResult = null;
      opts.onPOIsReady?.([]);
      console.warn("[DynamicMap] Published bake unavailable or missing metadata", seed, bakedData?.probe);
      return null;
    }
    // Ordinary custom-seed links also need shader/artwork startup overlapped
    // with generation. Previously only the diagnostic ?nb link did this, so
    // normal cold loads initialized presentation after generation had finished.
    // Resolve the baked route first: daily pixels must never trigger live work.
    if (!noBaked && !bakedData?.probe.baked && isInstantTerrainEnabled()) {
      prewarmInstantTerrain();
      prewarmMapPresentation(ngPlus ? "ng-plus" : gameMode);
    }
    // UI hooks (spoiler-free toggle) need to know when the view is served
    // from baked pyramids: identities are flattened into the pixels there,
    // so spoiler-free cannot work and the toggle gets disabled.
    window.dispatchEvent(new CustomEvent("bakedSeedChange", { detail: {
      baked: !!bakedData?.probe?.baked,
      fullPixelsBaked: bakedData?.probe.baked === true && bakedData.probe.fullPixelsBaked,
    } }));

    let t = performance.now();
    let result: GenerationResult | null = null;
    let restoreTerrain = false;
    // Daily equipment differs from a normal run of the same seed.
    // Keep old daily records out of this lookup without clearing terrain assets.
    let cacheKey = generationCacheKey(seed, unlockKey, isDaily, gameMode, ngPlus);

    if (bakedData?.generation) {
      result = bakedData.generation;
      // Daily/previous-daily artifacts remain daily even when ds=1 was omitted.
      cacheKey = generationCacheKey(seed, `all${lightMode ? "|lm" : ""}|p-`, gameMode === "normal", gameMode, ngPlus);
      console.log(`[DynamicMap] Baked generation.json hit — reusing seed metadata`);
      // Seed the IDB cache so seed-report comparisons and tomorrow's
      // "previous daily" lookups work offline (fire-and-forget).
      cacheGeneration(cacheKey, seed, result).catch(() => {});
    } else {
    prewarmParallelWorlds(lightMode ? [0] : undefined);
    // Version validation is a small shared barrier. Reading cached geometry can
    // then overlap asset initialization instead of waiting for every scene.
    const cacheReady = forceRegenerate ? Promise.resolve(null) :
      ensureTelescopeCacheVersion().then(() => getCachedGeneration(cacheKey));
    const assetsReady = earlyInit
      ? earlyInit.then(failure => { if (failure) throw failure.error; })
      : initTelescope();
    [result] = await Promise.all([cacheReady, assetsReady]);
    if (myToken !== generationToken) return null;
    if (result && (!result.tileLayers?.length || (result.gameMode ?? "normal") !== gameMode || result.ngPlus !== ngPlus)) result = null; // baked metadata cannot render live terrain
    restoreTerrain = !!result;
    console.log(`[DynamicMap] Assets + cache: ${((performance.now() - t) / 1000).toFixed(2)}s (${result ? "HIT" : "MISS"})`);

    if (!result) {
      // 2. Generate with unlock state
      t = performance.now();
      console.log(`[DynamicMap] Generating seed ${seed} (unlocks: ${unlocks ? unlocks.length + "/" + UNLOCK_KEYS.length : "all"})...`);
      result = await generateDynamicMap({ seed, gameMode, ngPlus, dailySeed: isDaily, unlocks, pillarFlags, parallelWorlds: lightMode ? [0] : undefined,
        onTerrainReady: isInstantTerrainEnabled() && !bakedData?.probe.baked ? terrain => {
          if (myToken !== generationToken) return;
          void prepareInstantTerrainResources(terrain, () => myToken === generationToken).catch(error =>
            console.warn("[DynamicMap] Early terrain preparation unavailable:", error));
        } : undefined,
      });
      if (myToken !== generationToken) return null;
      console.log(`[DynamicMap] Generation: ${((performance.now() - t) / 1000).toFixed(2)}s`);

      // 3. Store in cache (fire-and-forget -- don't block render)
      cacheGeneration(cacheKey, seed, result).catch((e) => console.warn("[DynamicMap] Cache write failed:", e));
    }
    } // end telescope path

    if (isInstantTerrainEnabled() && !bakedData?.probe.baked) {
      // Cached generations did not pass through onTerrainReady. The backend
      // coalesces this with the early callback for newly generated seeds.
      void prepareInstantTerrainResources(result, () => myToken === generationToken).catch(error =>
        console.warn("[DynamicMap] Terrain preparation unavailable:", error));
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
    const assignIds = (poiArr: any[], prefix: string) => {
      if (!Array.isArray(poiArr)) return;
      poiArr.forEach((poi, index) => {
        if (!poi.id) {
          const type = poi.type || "unknown";
          const x = Math.round(poi.x || 0);
          const y = Math.round(poi.y || 0);
          poi.id = `d-${prefix}_${type}_${x}_${y}_${index}`;
        }
        if (poi.items) {
          assignIds(poi.items, `${poi.id}_item`);
        }
      });
    };
    for (const [pwKey, pois] of Object.entries(result.poisByPW)) {
      assignIds(pois as any[], `pw_${pwKey.replace(/,/g, '_')}`);
    }

    // 5. Render onto OSD (skeleton placeholders are removed inside after real biome backgrounds load)
    t = performance.now();
    console.log(
      `[DynamicMap] Rendering seed ${seed} with ${result.parallelWorlds?.length || 3} worlds, worldCenter=${result.worldCenter}`,
    );
    // Hide loading indicator as soon as the main world's biome layer paints,
    // not after the full multi-PW render finishes. The remaining PWs / pixel
    // scenes / POIs continue rendering in the background.
    let firstPaintFired = false;
    const onFirstPaint = () => {
      if (firstPaintFired || myToken !== generationToken) return;
      firstPaintFired = true;
      console.log(`[DynamicMap] First paint, seed ${seed}: ${((performance.now() - runStarted) / 1000).toFixed(2)}s total, ${((performance.now() - t) / 1000).toFixed(2)}s presentation`);
      onLoadingChange?.(false);
    };
    // Probe result was already awaited at step 0b.
    const bakedProbe = bakedData?.probe ?? null;
    // Light mode: only the middle world's baked DZI is loaded (matches
    // generateDynamicMap's parallelWorlds: [0] above).
    const bakedDZIs = bakedProbe && bakedProbe.baked
      ? (lightMode ? bakedProbe.placements.filter((p) => p.pw === 0) : bakedProbe.placements)
      : null;
    const bakedDecorations = !!(bakedProbe && bakedProbe.baked && bakedProbe.decorationsBaked);
    if (bakedProbe) {
      if (bakedProbe.baked) {
        console.log(`[DynamicMap] Using baked ${bakedProbe.prefix}-* DZIs (${bakedProbe.placements.length} regions); skipping live biome composite${bakedDecorations ? " + scenes + markers" : ""}`);
      } else {
        console.log(`[DynamicMap] Baked DZIs not used: ${bakedProbe.reason}`);
      }
    }
    await backgroundReady;
    if (myToken !== generationToken) return null;
    await renderGenerationResult(viewer as any, result, unlocks, isDaily, onFirstPaint, cacheKey, bakedDZIs, bakedAlreadyPainted, bakedDecorations, false, runStarted, restoreTerrain);
    if (myToken !== generationToken) return null;
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

    // Alternate unlock data is background work. Never compete with the first
    // map paint/compositing. Yield a frame and a task before starting it, and
    // discard this intent if the user has already changed seeds.
    requestAnimationFrame(() => setTimeout(() => {
      if (myToken !== generationToken) return;
      void prewarmAlt(seed, isDaily, !bakedData?.probe.baked, gameMode, ngPlus).catch((e) =>
        console.warn("[DynamicMap] alt-unlocks pre-warm failed:", e),
      );
    }, 0));

    // Only live maps need scene preparation for future generations. A baked
    // daily (including yesterday's seed) already contains its rendered pixels.
    if (!bakedData?.probe.baked) {
      const lifetime = scenePrefetchLifetime = new AbortController();
      const gate = createScenePrefetchGate(viewer, lifetime.signal);
      void prefetchAllSceneBitmaps(() => myToken === generationToken, gate.wait)
        .catch(() => {}).finally(() => {
          gate.dispose();
          if (scenePrefetchLifetime === lifetime) scenePrefetchLifetime = undefined;
        });
    }

    return result;
  } catch (err) {
    if (myToken === generationToken && (err as Error)?.name !== "AbortError")
      console.error("[DynamicMap] Pipeline failed:", err);
    return null;
  } finally {
    // A superseded request does not own the replacement map's loading state.
    if (myToken === generationToken) onLoadingChange?.(false);
  }
}

/**
 * Convenience wrapper: resolve seed from URL then run the full pipeline.
 */
export async function runDynamicMapFromURL(opts: DynamicMapOptions, requirePublishedDaily = false, initialDaily?: InitialDaily): Promise<GenerationResult | null> {
  // Own the request before Daily resolution awaits the network. A newer seed
  // or clearDynamicMap must invalidate both its URL write and pipeline start.
  const token = initialDaily?.token ?? beginDynamicRequest();
  const isCurrent = () => token === generationToken;
  if (!isCurrent()) return null;
  try {
    opts.onRequestStateChange?.(true);
    if (!isCurrent()) return null;
    const { seed, isDaily } = await resolveSeed(isCurrent, requirePublishedDaily, initialDaily?.today, opts.gameMode);
    if (!isCurrent()) return null;
    return await runDynamicMapRequest(seed, isDaily, opts, token, initialDaily);
  } catch (error) {
    // A failed older lookup must not replace a newer map with an error panel.
    if (!isCurrent()) return null;
    throw error;
  } finally {
    if (isCurrent()) opts.onRequestStateChange?.(false);
  }
}

/**
 * Clear all dynamic overlays from the viewer.
 */
export function clearDynamicMap(viewer: any): void {
  scenePrefetchLifetime?.abort();
  scenePrefetchLifetime = undefined;
  releaseParallelWorlds();
  releaseInstantTerrainBackend();
  clearDynamicOverlays(viewer);
  resetPersistentBiomeBackgrounds();
  currentGameMode = "normal";
  currentNGPlus = 0;
  currentSeed = null;
  currentIsDaily = false;
  currentUnlocksKey = null;
  currentAllowsBaked = null;
  dynamicRendered = false;
  lastResult = null;
  beginDynamicRequest();
  clearSeedParams();
  // Drop pre-warmed alt-unlocks POIs — they belong to the seed we just left.
  resetAltCache();
  window.dispatchEvent(new CustomEvent("bakedSeedChange", { detail: { baked: false, fullPixelsBaked: false } }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function buildPOIName(p: any): string {
  if (p.type === "wand" && p.name) return p.name;
  // Explicit in-game name key (item_chest_dark, item_chest_light, item_musicstone,
  // item_essence_stone, ...) is the authoritative localized name — prefer it.
  if (p.nameKey) {
    const t = gameTranslator.translateItem(String(p.nameKey));
    if (t !== p.nameKey) return t;
  }
  // Perks: prefer the proper in-game name (perk_<id>) over the raw "perk" item id.
  if (p.item === "perk" && p.perk) {
    const k = perkNameKey(p.perk);
    const t = gameTranslator.translateItem(k);
    if (t !== k) return t;
  }
  // Emerald Tablets carry a descriptive per-location name ("Emerald Tablet
  // (Sea of Lava)"); prefer it over the raw item id so search results are
  // distinguishable and "tablet" tokenizes as its own word.
  if (p.item === "emerald_tablet") return p.name || "Emerald Tablet";
  // Achievement pillar segments carry the curated achievement title
  // ("Suomuhauki", "The Tower") — never surface the raw "pillar_segment" id.
  if (p.item === "pillar_segment") return p.name || "Achievement Pillar";
  if (p.item) return p.item;
  // An entity may carry an explicit display name (e.g. a boss reward "Sampo");
  // prefer it over the raw entity id (boss_centipede_sampo).
  if (p.type === "entity" && p.name) return p.name;
  if (p.type === "entity" && p.entity) return p.entity;
  if (p.name) return p.name;
  if (p.type) return p.type;
  return "Unknown";
}
