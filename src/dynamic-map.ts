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

import { fetchDailySeed, fetchPreviousDailySeed } from "./data_sources/daily_seed";
import { parseURL, updateURLWithSeed, clearSeedParams } from "./data_sources/url";
import { getCachedGeneration, cacheGeneration } from "./telescope/tile-cache";
import { generateDynamicMap, initTelescope, type GenerationResult } from "./telescope/telescope-adapter";
import { getUnlocksFromURL, unlocksChanged, UNLOCK_KEYS, getUrlUnlockKind } from "./unlocks";
import { getPillarFlagsFromURL } from "./pillars-unlocks";
import { prewarmAlt, resetAltCache } from "./unlocks-toggle";
import { isLightMode } from "./light-mode";
import {
  renderGenerationResult,
  clearDynamicOverlays,
  getAllPOIsFlat,
  hasDynamicOverlays,
  ensurePersistentBiomeBackgrounds,
  resetPersistentBiomeBackgrounds,
} from "./telescope/telescope-osd-bridge";
import { probeBakedDZIs, type BakedDziProbeResult } from "./telescope/baked-dzi-loader";
import { perkNameKey } from "./telescope/perk-i18n";
import { gameTranslator } from "./game-translations/translator";

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

// ─── Background comparison-seed prewarm (seed report) ────────────────────────

/** Cache key for a daily-style (all-unlocks) generation of `seed`. Must match
 *  the key the live daily render writes (including the light-mode suffix) so
 *  the seed-report comparison lookup hits. Dailies always render all-unlocked,
 *  so the unlock portion is always "all". */
export function dailyCacheKey(seed: number): string {
  return `${seed}-all${isLightMode() ? "|lm" : ""}`;
}

// Dedupe concurrent requests for the same seed; serialize the heavy
// generations so at most one background gen runs at a time.
const pendingSeedCaches = new Map<number, Promise<boolean>>();
let bgGenChain: Promise<unknown> = Promise.resolve();

/**
 * Ensure a seed's POIs are generated and cached in IndexedDB for the seed
 * report's background comparison. Never renders and never reads the live map's
 * OSD state, so it is safe once the current map has settled (the seed report
 * calls it only after indexing is "ready"). Resolves true when the seed is
 * cached (already present or freshly generated), false on failure.
 */
export function ensureSeedCached(seed: number, isDaily: boolean): Promise<boolean> {
  const existing = pendingSeedCaches.get(seed);
  if (existing) return existing;

  const run = (async (): Promise<boolean> => {
    const key = dailyCacheKey(seed);
    try {
      if (await getCachedGeneration(key)) return true;
    } catch {
      /* cache read failed - fall through and regenerate */
    }

    const gen = bgGenChain.then(async () => {
      await initTelescope();
      return generateDynamicMap({
        seed,
        ngPlus: 0,
        dailySeed: isDaily,
        unlocks: null,
        parallelWorlds: isLightMode() ? [0] : undefined,
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
      pendingSeedCaches.delete(seed);
    });

  pendingSeedCaches.set(seed, run);
  return run;
}

// ─── Daily baked-overlay fast path (pre-warm) ────────────────────────────────

// main.ts calls startDailyFastPath() the instant OSD exists. With no custom
// seed in the URL we KNOW it's today's daily, whose baked DZIs live at fixed
// worker URLs — so we fire the daily-seed lookup + the manifest probe NOW, in
// parallel with the rest of page init, instead of waiting for the dynamic
// pipeline to spin up (~UI wiring) and then serialize those round-trips. By the
// time runDynamicMap reaches its probe, this is already resolved, so the baked
// biome DZIs get queued onto OSD almost as early as the static background.
let dailyFastPath: {
  seed: Promise<number | null>;
  probe: Promise<BakedDziProbeResult | null>;
} | null = null;

export function startDailyFastPath(): void {
  if (dailyFastPath) return;
  try {
    const urlState = parseURL();
    if (urlState.seed !== undefined && !urlState.dailySeed) return; // custom seed — not a daily
    if (new URLSearchParams(window.location.search).has("nb")) return; // baked path disabled
  } catch {
    return;
  }
  const seed = fetchDailySeed().catch(() => null);
  const probe = seed
    .then((s) => (s == null ? null : probeBakedDZIs("daily", s)))
    .catch(() => null);
  dailyFastPath = { seed, probe };
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

  // Read unlock state from URL (caches to localStorage automatically).
  // The shareable shorthand tokens (`u=all`, `u=none`) override the mod
  // list — `none` means "render with nothing unlocked", `all` means default.
  let unlocks = getUnlocksFromURL();
  const urlKind = getUrlUnlockKind();
  if (urlKind === "none") unlocks = [];
  // (urlKind === "all" → unlocks stays null → telescope's default = all)
  const lightMode = isLightMode();
  // Dedicated pillar achievement channel (`&p=`). Independent of `&u=`: it only
  // affects pillar segment lock state, but a change must still re-render, so it
  // joins the cache key.
  const pillarFlags = getPillarFlagsFromURL();
  const pillarKey = pillarFlags ? "p" + pillarFlags.length + ":" + pillarFlags.slice().sort().join(",") : "p-";
  const unlockKey = (unlocks ? unlocks.sort().join(",") : "all") + (lightMode ? "|lm" : "") + "|" + pillarKey;

  // 0. Skip only if same seed, same unlocks, and overlays still present.
  if (seed === currentSeed && unlockKey === currentUnlocksKey && dynamicRendered && hasDynamicOverlays()) {
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

  // If unlocks changed for the same seed, we must regenerate (skip cache)
  const forceRegenerate = seed === currentSeed && unlockKey !== currentUnlocksKey;

  onLoadingChange?.(true);

  // Capture token so we can detect if clearDynamicMap was called mid-pipeline
  const myToken = ++generationToken;

  // Yield so the browser can paint the loading indicator before telescope
  // blocks the main thread during initialization (~700ms first load).
  await new Promise((r) => setTimeout(r, 0));
  if (myToken !== generationToken) { onLoadingChange?.(false); return null; }

  // Fire the baked-DZI probe FIRST, ahead of telescope init. The probe is
  // pure network work and doesn't depend on telescope. Painting baked DZIs
  // the moment they arrive lets the user see the map within ~150-300ms of
  // page load instead of waiting for the ~700ms telescope init + cache check
  // + (in worst case) full generation.
  // Lives at function scope so the later render() call can reference it.
  let bakedAlreadyPainted = false;
  // ?nb=1 disables the baked fast path entirely. The bake page uses it so a
  // re-bake of an already-deployed seed still runs a real local generation
  // (the export hooks need live tileLayers, which the baked path never has).
  const noBaked = new URLSearchParams(window.location.search).has("nb");
  const bakedProbePromise: Promise<{ probe: BakedDziProbeResult; generation: GenerationResult | null } | null> = (async () => {
    try {
      if (noBaked) return null;
      // Resolve the prefix with minimal round-trips. fetchDailySeed is already
      // cached (resolveSeed + the fast-path pre-warm), so this is usually free;
      // the previous-daily lookup (an extra request) only fires when the seed
      // isn't today's — keeping the common daily overlay off that RTT.
      let prefix: "daily" | "previous-daily" | null = null;
      const todayDaily = await fetchDailySeed().catch(() => null);
      if (todayDaily !== null && seed === todayDaily) {
        prefix = "daily";
      } else {
        const prevDaily = await fetchPreviousDailySeed().catch(() => null);
        if (prevDaily !== null && seed === prevDaily) prefix = "previous-daily";
      }
      if (!prefix) return null;
      // Generation data (POIs, pixel scenes, biome map) rides on the same
      // workers as the DZIs. Fetch it in PARALLEL with the probe: once the
      // probe paints, OSD floods these same origins with hundreds of tile
      // requests and a late generation.json queues behind all of them (the
      // "POIs take forever" symptom). Baked with u=all, so only valid for
      // the default all-unlocked state; restricted-unlock views keep the
      // baked DZIs but run telescope for their own POI pools.
      const generationPromise: Promise<GenerationResult | null> =
        unlocks === null
          ? (async () => {
              const { fetchBakedGeneration } = await import("./telescope/baked-generation");
              const worlds: ("left" | "middle" | "right")[] = isLightMode() ? ["middle"] : ["left", "middle", "right"];
              return fetchBakedGeneration(prefix, worlds, seed);
            })().catch(() => null)
          : Promise.resolve(null);
      // Reuse the pre-warmed probe when it covers this exact daily seed so the
      // manifest round-trips don't repeat on the critical path.
      let probe: BakedDziProbeResult | null = null;
      if (prefix === "daily" && dailyFastPath && (await dailyFastPath.seed) === seed) {
        probe = await dailyFastPath.probe;
      }
      if (!probe) probe = await probeBakedDZIs(prefix, seed);
      if (!probe.baked) return { probe, generation: null };
      if (myToken === generationToken && !bakedAlreadyPainted) {
        console.log(`[DynamicMap] Baked ${probe.prefix}-* hit, painting biomes immediately`);
        const bridge = await import("./telescope/telescope-osd-bridge");
        const loader = await import("./telescope/baked-dzi-loader");
        bridge.clearDynamicOverlays(viewer as any);
        // Light mode: only paint the middle world (pw=0). The other two worlds'
        // DZIs are still on CF — we just don't ask OSD to load them.
        const placements = isLightMode()
          ? probe.placements.filter((p) => p.pw === 0)
          : probe.placements;
        // addTiledImage is async: if the user switches seed while these are
        // in flight, they'd land AFTER the next clearDynamicOverlays pass and
        // linger as stale tiles. Remove on arrival when outdated.
        loader.addBakedDZIsToOSD(viewer as any, placements, (item) => {
          if (myToken !== generationToken) {
            try { (viewer as any).world.removeItem(item); } catch {}
          }
        });
        bakedAlreadyPainted = true;
        onLoadingChange?.(false);
      }
      const generation = await generationPromise;
      if (!generation && unlocks === null) console.log("[DynamicMap] No baked generation.json; falling back to telescope for POIs");
      return { probe, generation };
    } catch (e) {
      console.warn("[DynamicMap] baked-DZI probe threw:", e);
      return null;
    }
  })();

  // Determine if this seed will likely be served from baked DZIs. When yes,
  // skip the static placeholder bg fills (the baked tiles already include
  // them; the placeholder would otherwise flash visibly on every refresh).
  // The seed lookups here hit the same in-memory cache the probe just used.
  const [_todayD, _prevD] = await Promise.all([
    fetchDailySeed().catch(() => null),
    fetchPreviousDailySeed().catch(() => null),
  ]);
  const likelyBaked = (_todayD !== null && seed === _todayD) || (_prevD !== null && seed === _prevD);
  if (!likelyBaked) {
    await ensurePersistentBiomeBackgrounds(viewer);
  }

  currentSeed = seed;
  currentIsDaily = isDaily;
  currentUnlocksKey = unlockKey;

  onSeedResolved?.(seed, isDaily);

  try {
    // 0b. Await the probe. Non-daily seeds resolve ~instantly (seed lookups
    // are cached, prefix misses return null immediately). A generation.json
    // hit means telescope is NEVER initialized: biome map, POIs and pixel
    // scenes all come prebaked from the static workers.
    const bakedData = await bakedProbePromise;
    if (myToken !== generationToken) { onLoadingChange?.(false); return null; }
    // UI hooks (spoiler-free toggle) need to know when the view is served
    // from baked pyramids: identities are flattened into the pixels there,
    // so spoiler-free cannot work and the toggle gets disabled.
    window.dispatchEvent(new CustomEvent("bakedSeedChange", { detail: { baked: !!bakedData?.probe?.baked } }));

    let t = performance.now();
    let result: GenerationResult | null = null;
    const cacheKey = `${seed}-${unlockKey}`;

    if (bakedData?.generation) {
      result = bakedData.generation;
      console.log(`[DynamicMap] Baked generation.json hit — skipping telescope entirely`);
      // Seed the IDB cache so seed-report comparisons and tomorrow's
      // "previous daily" lookups work offline (fire-and-forget).
      cacheGeneration(cacheKey, seed, result).catch(() => {});
    } else {
    // Ensure telescope is initialized (runs LIB_VERSION cache bust BEFORE cache check)
    await initTelescope();
    if (myToken !== generationToken) { onLoadingChange?.(false); return null; }

    // 1. Check cache (skip if unlocks changed for same seed)
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
      result = await generateDynamicMap({ seed, ngPlus: 0, dailySeed: isDaily, unlocks, pillarFlags, parallelWorlds: lightMode ? [0] : undefined });
      if (myToken !== generationToken) { onLoadingChange?.(false); return null; }
      console.log(`[DynamicMap] Generation: ${((performance.now() - t) / 1000).toFixed(2)}s`);

      // 3. Store in cache (fire-and-forget -- don't block render)
      cacheGeneration(cacheKey, seed, result).catch((e) => console.warn("[DynamicMap] Cache write failed:", e));
    }
    } // end telescope path

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

    // 4.6. Kick off background pre-warm of the *alternate* unlocks variant
    //      (e.g. nothing-unlocked when primary is all-unlocked, and vice
    //      versa). Biome layout is identical between variants — only spell
    //      pools differ — so this hidden second generation gives POI cards
    //      an instant lock-toggle later without a full reload. Fire-and-
    //      forget: if it fails or is racy with a seed change, no harm done.
    void prewarmAlt(seed, isDaily).catch((e) =>
      console.warn("[DynamicMap] alt-unlocks pre-warm failed:", e),
    );

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
      console.log(`[DynamicMap] First paint (PW 0,0): ${((performance.now() - t) / 1000).toFixed(2)}s`);
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
    await renderGenerationResult(viewer as any, result, unlocks, isDaily, onFirstPaint, cacheKey, bakedDZIs, bakedAlreadyPainted, bakedDecorations);
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

    // Background prefetch: composite & cache every pixel-scene bitmap telescope
    // knows about. Fires once per session after the first successful render so
    // future seed switches don't pay any compositing cost.
    import("./telescope/telescope-osd-bridge").then(({ prefetchAllSceneBitmaps }) => {
      prefetchAllSceneBitmaps();
    }).catch(() => {});

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
  // Drop pre-warmed alt-unlocks POIs — they belong to the seed we just left.
  resetAltCache();
  window.dispatchEvent(new CustomEvent("bakedSeedChange", { detail: { baked: false } }));
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
