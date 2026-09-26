import { ReportMapHighlights } from './report-map-highlights';
import { getCachedDailyComparisonTarget, getCachedDailySeedIdentity } from './data_sources/daily_seed';
import { getPOIDisplayName } from "./telescope/poi-display-name";
import { getPOIBiomeDescription } from "./data_sources/biome-names";
import { clearCreatureSpawnBiomeFocus, focusCreatureSpawnBiomes, frameCreatureSpawnBiomes, resolveCreatureSpawnBiomes } from "./data_sources/creature-spawn-biomes";
import { setCreatureSpawnNavigation } from "./creature-spawn-navigation";
import { mountCreatureSpawnNotice } from "./creature-spawn-notice";
import { createCreatureSpawnSharing } from "./creature-spawn-sharing";
import { dismissEnclosingPopup, getExtendedCreature, isProUser, loadExtendedCreatures } from "./extended-info";
import { getCachedGeneration } from "./telescope/tile-cache";
import i18next from "./i18n";
import { initializeApplication } from "./app/startup";
import { installLoadingProgress } from "./app/loading-progress";
import { setupDropOverlay } from "./drop-overlay";
import { createProLoader } from "./pro-loader";
import { negotiateTabHandoff } from "./tab-coordinator";
import { createDynamicUI, updateDynamicUIVisibility, setDynamicUISeed, showLoadingStrip, hideLoadingStrip } from "./dynamic_ui";
import {
  runDynamicMapFromURL,
  runDynamicMap,
  clearDynamicMap,
  getCurrentDynamicSeed,
  getCurrentIsDaily,
  getLastGenerationResult,
  buildPOIName,
  dailyCacheKey,
  ensureSeedCached,
  startDailyFastPath,
} from "./dynamic-map";
import type { DynamicPOI } from "./dynamic-map";
import {
  onActiveDescriptorChange,
  onAltReady,
  getActiveDescriptor,
  primaryDescriptor,
  getAltResult,
  isVariantReady,
  UnlockDescriptor,
} from "./unlocks-toggle";
import { rebuildAltLayers, getAllPOIsFlat, openTooltipForPOI, closePOICard, guardPOICardContext, resetPOICardContext, restorePOICardContext, getPOISpriteFirstFrame, applyHighValueOverlays } from "./telescope/telescope-osd-bridge";
import { getUnlocksFromURL } from "./unlocks";
import type { GenerationResult } from "./telescope/telescope-adapter";
import { isRenderer, getStoredRenderer, setStoredRenderer } from "./renderer_settings";

import { App } from "./app";
import {
  parseURL,
  updateURL,
  getEnabledOverlays,
  updateURLWithOverlays,
  updateURLWithSidebar,
  updateURLWithSeedReport,
  updateURLWithCanvas,
  updateURLWithSeed,
  updateURLWithSearch,
  reorderParams,
  clearTargetPoiId,
  normalizeSpawnCreatureId,
  updateURLWithCreatureSpawn,
} from "./data_sources/url";
import { asOverlayKey, showOverlay, selectSpell, OverlayKey } from "./data_sources/overlays";
import { isMainPathBiome } from "./data_sources/main-path-biomes";
import { overlayToShort } from "./data_sources/param-mappings";
import { UnifiedSearch } from "./search/unifiedsearch";
import { asMapName, MapName } from "./data_sources/tile_data";
import { addEventListenerForId, assertElementById, debounce } from "./util";
import { createMapLinks, createMapSelectorRenderer, refreshMapSelectorDate, NAV_LINK_IDENTIFIER } from "./nav";
import { initMouseTracker } from "./mouse_tracker";
import { isSpoilerFree, setSpoilerFree, onSpoilerFreeChange, isBakedSeedView } from "./spoiler-free";
import { isLightMode, setLightMode } from "./light-mode";
import { installPopoverTouchDismiss } from "./popover-util";
import { isSkipCreatures, setSkipCreatures } from "./skip-creatures";
import { isSimplisticBackground, setSimplisticBackground } from "./simplistic-background";
import { isPortalAnimations, setPortalAnimations } from "./portal-animations";
import { createLanguageSelector } from "./language-selector";
import { updateTranslations } from "./i18n-dom";
import { initKonamiCode } from "./konami";
import { AuthUI } from "./auth/auth-ui";
import { authService } from "./auth/auth-service";
import { DrawingUI } from "./drawing/drawing-ui";
import { createSeedReportButton } from "./seed-report-button";
import { placeBiomeBoundariesButton, placeMoreMenuLast } from "./overflow-menu";
import { cueBiomeBoundariesButton } from "./biome-boundaries-button";
import { initChunkGrid, showChunkGrid, isChunkGridVisible } from "./drawing/chunk-grid";
import { initSideworld, toggleSideworld, mapHasSideworld, resetSideworld } from "./sideworld";
import { roundVisibleOverlayGroupEdges } from "./dynamic_ui";
import { getMaterialInfo, primeMaterialInfo } from "./material-info";

const isDev = /dev\.noitamap\.com|localhost|127\.0\.0\.1/.test(window.location.hostname)
  || window.location.protocol === "file:";
if (isDev) {
  import("./dev/console").then(module => module.installDevCommands())
    .catch(error => console.warn("[Noitamap] Dev commands unavailable:", error));
}

// Global reference to unified search for translation updates
let globalUnifiedSearch: UnifiedSearch | null = null;

let globalApp: App | null = null;

// Map-change callbacks registered by the pro bundle via onMapChange hook
const mapChangeCallbacks: Array<(mapName: string) => void> = [];

// Reference to unified search so the pro hook can update it
let _unifiedSearch: UnifiedSearch | null = null;
let _currentDynamicPOIs: DynamicPOI[] = [];
/**
 * Unfiltered POI list — keeps `entity`, `enemies`, `props` even when the
 * "skip creatures" performance toggle hides them on the map. Used by the
 * pro bundle's Seed Report so creature stats are correct regardless of the
 * map-rendering toggle.
 */
let _allDynamicPOIs: DynamicPOI[] = [];

// Export function to refresh search translations
export const refreshSearchTranslations = () => {
  if (globalUnifiedSearch) {
    globalUnifiedSearch.refreshTranslations();
  }
};

// Start cross-tab handoff negotiation as early as possible (the mod opens a
// new browser tab on every M-press; if another noitamap tab is already open
// we want it to take over so this duplicate tab can self-close).
const _tabHandoff = negotiateTabHandoff();

document.addEventListener("DOMContentLoaded", async () => {
  if (!(await _tabHandoff)) return;
  const navbarBrandElement = assertElementById("navbar-brand", HTMLElement);
  const osdRootElement = assertElementById("osContainer", HTMLElement);
  const searchForm = assertElementById("search-form", HTMLFormElement);
  const overlayButtonsElement = assertElementById("overlay-selector", HTMLDivElement);
  const mapSelectorButton = assertElementById("mapSelectorButton", HTMLButtonElement);
  const tooltipElement = assertElementById("coordinate", HTMLElement);
  const coordinatesText = tooltipElement.innerText;
  const rendererForm = assertElementById("renderer-form", HTMLFormElement);
  const storedRenderer = getStoredRenderer();
  (rendererForm.elements as any)["renderer"].value = storedRenderer;
  const urlState = parseURL();
  const loadingProgress = installLoadingProgress(() => globalApp?.getMap() ?? urlState.map ?? "dynamic-main-branch");

  // Seed/manifests and base-map tiles can load while the selected language loads.
  if (!urlState.map || urlState.map === "dynamic-main-branch") startDailyFastPath();
  const app = await initializeApplication({
    mountTo: osdRootElement,
    overlayButtons: overlayButtonsElement,
    initialState: urlState,
    useWebGL: storedRenderer === "webgl",
  });
  globalApp = app;
  createLanguageSelector();
  updateTranslations();
  console.log(`[Noitamap] Active OSD drawer: ${(app.osd as any).drawer?.getType?.() ?? storedRenderer}`);

  // Helper to update the map selector button: shows the current map's full
  // label plus icon-only versions of its badges. Hover popovers on the badges
  // provide the full badge labels (same content as the dropdown items).
  const updateMapSelectorText = createMapSelectorRenderer(mapSelectorButton);
  // Set initial button text
  updateMapSelectorText(app.getMap());
  refreshMapSelectorDate(() => updateMapSelectorText(app.getMap()));
  i18next.on('languageChanged', () => updateMapSelectorText(app.getMap()));

  // Chunk grid toggle
  initChunkGrid(app.osd.viewer);
  const chunkGridToggler = document.getElementById("chunkGridToggler") as HTMLInputElement | null;
  if (chunkGridToggler) {
    chunkGridToggler.checked = isChunkGridVisible();
    if (chunkGridToggler.checked) showChunkGrid(true);
    chunkGridToggler.addEventListener("change", () => showChunkGrid(chunkGridToggler.checked));
  }

  // Sideworld overlay toggle — QLC map only.
  initSideworld(app.osd.viewer);
  const sideworldToggler = document.getElementById("sideworldToggler") as HTMLInputElement | null;
  const sideworldLabel = document.querySelector('label[for="sideworldToggler"]') as HTMLElement | null;
  const syncSideworldButton = () => {
    const available = mapHasSideworld(app.getMap());
    sideworldToggler?.classList.toggle("d-none", !available);
    sideworldLabel?.classList.toggle("d-none", !available);
    if (!available && sideworldToggler) sideworldToggler.checked = false;
  };
  if (sideworldToggler) {
    sideworldToggler.addEventListener("change", async () => {
      // The overlay reports what actually happened: if the tile source fails
      // to load, the checkbox must not stay lit claiming it is showing.
      const shown = await toggleSideworld(sideworldToggler.checked);
      sideworldToggler.checked = shown;
      // The toggle is the last button in the group, so its visibility changes
      // which labels are the group's rounded ends.
      roundVisibleOverlayGroupEdges();
    });
  }
  syncSideworldButton();
  let sideworldMap = app.getMap();
  app.on("state-change", () => {
    const map = app.getMap();
    if (map === sideworldMap) return;
    sideworldMap = map;
    // Switching maps re-opens the viewer, destroying every tiled image, so the
    // overlay's own flag has to be cleared alongside the button.
    if (!mapHasSideworld(app.getMap())) resetSideworld();
    syncSideworldButton();
  });

  let initialSearchQuery = urlState.query;
  let initialTargetPoiId = urlState.targetPoiId;

  // Pre-populate and trigger the search right away so user sees skeletons
  if (initialSearchQuery && _unifiedSearch) {
    setTimeout(() => {
        if (initialSearchQuery && _unifiedSearch) {
           _unifiedSearch.triggerSearch(initialSearchQuery);
        }
    }, 500);
  }

  // Static map POI link sharing: pan to URL-encoded coordinates when map is not dynamic
  if (initialTargetPoiId && urlState.map !== "dynamic-main-branch") {
    const capturedStaticPoiId = initialTargetPoiId;
    const contextIsCurrent = guardPOICardContext();
    initialTargetPoiId = undefined;
    setTimeout(() => {
      if (!contextIsCurrent()) return;
      // st-X_Y format produced by the search result selector
      const match = capturedStaticPoiId.match(/^st-(-?[\d.]+)_(-?[\d.]+)$/);
      if (match) {
        const x = parseFloat(match[1]);
        const y = parseFloat(match[2]);
        app.osd.viewport.panTo(new (OpenSeadragon as any).Point(x, y), false);
      }
    }, 500);
  }

  // Apply canvas background from URL
  if (urlState.canvas) {
    app.setBackground(urlState.canvas);
  }

  // Apply overlays from URL
  if (urlState.overlays && urlState.overlays.length > 0) {
    for (const overlayKey of urlState.overlays) {
      const toggler = document.querySelector(
        `input.overlayToggler[data-overlay-key="${overlayKey}"]`,
      ) as HTMLInputElement | null;
      if (toggler && !toggler.disabled) {
        toggler.checked = true;
        showOverlay(overlayKey, true);
      }
    }
  }

  // Initialize auth UI in navbar (at the end of the button container)
  const authContainer = document.createElement("div");
  authContainer.id = "auth-container";
  // Find the container div that holds all the buttons
  const buttonContainer = document.querySelector(".collapse.navbar-collapse .d-flex.flex-wrap");
  if (buttonContainer) {
    buttonContainer.appendChild(authContainer);
  }
  new AuthUI(authContainer);

  navbarBrandElement.addEventListener("click", (ev) => {
    ev.preventDefault();
    app.home();
  });

  // create unified search
  const unifiedSearch = UnifiedSearch.create({
    currentMap: app.getMap(),
    form: searchForm,
    initialFilters: urlState.filters,
  });

  // Store global reference for translation updates
  globalUnifiedSearch = unifiedSearch;
  _unifiedSearch = unifiedSearch;

  // Track the search string in the URL on typing
  unifiedSearch.searchInput.addEventListener("input", debounce(300, (ev: Event) => {
    updateURLWithSearch((ev.target as HTMLInputElement).value, unifiedSearch.activeFilters);
  }));

  // Track filter changes
  document.addEventListener("change", (ev: Event) => {
    if (ev.target instanceof HTMLInputElement && ev.target.matches('#unifiedSearchFilterBox input[type="checkbox"][data-filter]')) {
      updateURLWithSearch(unifiedSearch.searchInput.value, unifiedSearch.activeFilters);
    }
  });

  // ── Dynamic map setup ─────────────────────────────────────────────────────
  // Tracks seed from the last dynamic map session so returning to dynamic map
  // can restore it (priority: URL param > last session seed > daily).
  let lastSessionSeed: number | null = null;
  let lastSessionIsDaily: boolean = false;
  // Pending seed set via setSeedParams before the map has switched to dynamic
  let pendingDynamicSeed: number | null = null;

  let reportHighlights: ReportMapHighlights | null = null;
  let reportMapLoading = false;
  let poiContextReady = false;
  let initialTargetSeedStarted = false;
  let spawnSharing: ReturnType<typeof createCreatureSpawnSharing> | undefined;
  app.osd.addHandler('map-change-start', () => {
    initialTargetPoiId = undefined;
    poiContextReady = false;
    reportHighlights?.clear(false);
    spawnSharing?.dismiss();
    spawnSharing?.setMapReady(false);
    clearCreatureSpawnBiomeFocus(osdRootElement);
    resetPOICardContext(app.osd);
  });
  const dynamicOpts = {
    viewer: app.osd,
    onMapReplacementStart: () => {
      poiContextReady = false;
      // The original URL target belongs to the first requested generation only.
      if (initialTargetSeedStarted) {
        initialTargetPoiId = undefined;
        spawnSharing?.dismiss();
      }
      spawnSharing?.setMapReady(false);
      initialTargetSeedStarted = true;
      reportHighlights?.clear(false);
      clearCreatureSpawnBiomeFocus(osdRootElement);
      resetPOICardContext(app.osd);
    },
    onLoadingChange: (isLoading: boolean) => {
      reportMapLoading = isLoading;
      if (isLoading) {
        poiContextReady = false;
        spawnSharing?.setMapReady(false);
        reportHighlights?.clear(false);
        clearCreatureSpawnBiomeFocus(osdRootElement);
        resetPOICardContext(app.osd);
      }
      loadingIndicator.style.display = isLoading ? "block" : "none";
      if (isLoading) {
        showLoadingStrip();
        unifiedSearch.setIndexingState('indexing');
      } else {
        hideLoadingStrip();
      }
    },
    onSeedResolved: (seed: number, isDaily: boolean) => {
      setDynamicUISeed(seed, isDaily);
      updateMapSelectorText(app.getMap());
      lastSessionSeed = seed;
      lastSessionIsDaily = isDaily;
    },
    onPOIsReady: (pois: DynamicPOI[]) => {
      restorePOICardContext(app.osd);
      poiContextReady = true;
      spawnSharing?.setMapReady(true);
      // Keep the full unfiltered list for stats (Seed Report counts creatures
      // regardless of the perf-mode "skip creatures" toggle).
      _allDynamicPOIs = pois;
      // Honour the "Don't add creatures" toggle in search too. Inner items
      // unwrapped from "enemies"/"props" containers carry type "entity" and
      // would otherwise still surface in search even though the map filter
      // hides them. Bosses use boss_* types and pass through.
      const filtered = isSkipCreatures()
        ? pois.filter((p) => p.type !== "entity" && p.type !== "enemies" && p.type !== "props")
        : pois;
      _currentDynamicPOIs = filtered;
      unifiedSearch.setDynamicPOIs(filtered);
      unifiedSearch.setIndexingState('ready');
      // If we had a search query, trigger it now that dynamic POIs are indexed
      if (initialSearchQuery) {
        unifiedSearch.triggerSearch(initialSearchQuery);
        initialSearchQuery = undefined;
      }
      // If we had a target POI ID to share, open its tooltip.
      // Capture the value NOW before clearing it — the deferred sidebar wait
      // must not make the callback observe undefined.
      if (initialTargetPoiId) {
        const capturedPoiId = initialTargetPoiId;
        const contextIsCurrent = guardPOICardContext();
        initialTargetPoiId = undefined;
        // If the URL also requested the seed-report sidebar (?sr=1), wait a
        // brief moment for it to mount + open before triggering the tooltip
        // pan — otherwise the cinematic pan would compute its sidebar offset
        // before the sidebar is visible and the POI ends up behind the panel.
        const waitForSidebar = async (): Promise<void> => {
          const urlState = parseURL();
          if (!urlState.seedReportOpen) return;
          for (let i = 0; i < 30; i++) {
            const el = document.querySelector<HTMLElement>('#seed-report-v3.open, #seed-report-sidebar.open');
            if (el && el.classList.contains("open")) return;
            await new Promise((r) => setTimeout(r, 100));
          }
        };
        waitForSidebar().then(() => {
          if (contextIsCurrent() && poiContextReady && app.getMap() === 'dynamic-main-branch')
            openTooltipForPOI(capturedPoiId, app.osd, { owner: 'map' });
        });
      }
    },
  };

  /** Explicit seed/daily URL → last session seed → today's daily. */
  async function runDynamicMapWithPriority(): Promise<void> {
    const urlState = parseURL();
    if (urlState.seed !== undefined) {
      // Daily-mode share links are pinned to their explicit seed too.
      await runDynamicMap(urlState.seed, !!urlState.dailySeed, dynamicOpts);
    } else if (!urlState.dailySeed && lastSessionSeed !== null) {
      // Restore the last seed the user was viewing
      updateURLWithSeed(lastSessionSeed, lastSessionIsDaily);
      await runDynamicMap(lastSessionSeed, lastSessionIsDaily, dynamicOpts);
    } else {
      // Fall back to daily seed resolution
      await runDynamicMapFromURL(dynamicOpts);
    }
  }

  createDynamicUI(dynamicOpts);
  updateDynamicUIVisibility(app.getMap());

  // Helper to rebuild/update search, markers, and sidebar when active unlock descriptor changes
  const refreshActiveVariant = async () => {
    const seed = getCurrentDynamicSeed();
    if (seed === null) return;
    const activeDesc = getActiveDescriptor();
    const primary = primaryDescriptor();
    const isDaily = getCurrentIsDaily();

    let result: GenerationResult | null = null;
    if (activeDesc === primary) {
      result = getLastGenerationResult();
    } else {
      result = getAltResult(activeDesc, seed);
    }

    if (!result) {
      if (unifiedSearch) {
        unifiedSearch.setIndexingState("indexing");
      }
      return;
    }

    // Update POI lists
    const flat = getAllPOIsFlat(result);
    _allDynamicPOIs = flat.map((p) => ({
      ...p,
      id: (p as any).id,
      name: buildPOIName(p),
    }));
    const filtered = isSkipCreatures()
      ? _allDynamicPOIs.filter((p) => p.type !== "entity" && p.type !== "enemies" && p.type !== "props")
      : _allDynamicPOIs;
    _currentDynamicPOIs = filtered;

    // Update search index
    if (unifiedSearch) {
      unifiedSearch.setDynamicPOIs(_currentDynamicPOIs);
      unifiedSearch.setIndexingState("ready");
      unifiedSearch.updateSearchResults();
    }

    // Determine unlocks list to pass to rebuildAltLayers
    const descriptorToUnlocks = (desc: UnlockDescriptor): string[] | null => {
      if (desc === "all") return null;
      if (desc === "none") return [];
      // desc === "mod": defer to the URL/localStorage decoder so the `all` /
      // `none` shorthand tokens never get parsed as base64.
      return getUnlocksFromURL();
    };
    const unlocksList = descriptorToUnlocks(activeDesc);

    // Rebuild marker tiled image layer + orb overlays
    rebuildAltLayers(app.osd, result, unlocksList, isDaily);
  };

  onActiveDescriptorChange(() => {
    refreshActiveVariant();
  });

  onAltReady(() => {
    refreshActiveVariant();
  }, true); // register as persistent listener

  // Auto-start generation if landing on dynamic map
  if (app.getMap() === "dynamic-main-branch") {
    runDynamicMapFromURL(dynamicOpts).catch((e) => console.error("[Noitamap] Dynamic map init failed:", e));
  }

  // Expose hooks for the pro bundle via window.__noitamap
  const proHooks: NoitamapProHooks = {
    i18next,
    authService,
    osd: app.osd as unknown as OpenSeadragon.Viewer,
    osdElement: osdRootElement,
    getMap: () => app.getMap(),
    setMap: (mapName: string) => app.setMap(asMapName(mapName) ?? (mapName as any)),
    updateURLWithSidebar,
    urlState: { sidebarOpen: urlState.sidebarOpen, canvas: urlState.canvas, seed: urlState.seed },
    getBakedSageSnapshot: () => getLastGenerationResult()?.sage,
    getReportInventorySnapshot: () => getLastGenerationResult()?.reportInventory,
    getSeedParams: () => ({ seed: getCurrentDynamicSeed() ?? undefined, isDaily: getCurrentIsDaily() }),
    getDailyComparisonTarget: () => {
      const seed = getCurrentDynamicSeed();
      return seed === null ? null : getCachedDailyComparisonTarget(seed);
    },
    getDailySeedIdentity: () => {
      const seed = getCurrentDynamicSeed();
      // Daily generation mode also applies to historical seeds. Only the
      // current published pointers establish today's/previous identity.
      return seed === null ? null : getCachedDailySeedIdentity(seed);
    },
    setSeedParams: (seed: number) => {
      updateURLWithSeed(seed, false);
      // Always update seed UI immediately
      setDynamicUISeed(seed, false);
      // Store as pending — may be used when map transitions to dynamic
      pendingDynamicSeed = seed;
      lastSessionSeed = seed;
      lastSessionIsDaily = false;
      if (app.getMap() === "dynamic-main-branch") {
        runDynamicMap(seed, false, dynamicOpts).catch((e) => console.error("[Noitamap] Dynamic map rebuild failed:", e));
      }
    },
    setBackground: (type: "map" | "black" | "white") => {
      app.setBackground(type);
      updateURLWithCanvas(type);
    },
    setSearchMap: (mapName: string) => {
      if (_unifiedSearch) _unifiedSearch.currentMap = mapName as any;
    },
    onMapChange: (callback: (mapName: string) => void) => {
      mapChangeCallbacks.push(callback);
    },
    getEnabledOverlays,
    overlayToShort: (key: string) => overlayToShort(key as any),
    showOverlay: (key: string, show: boolean) => {
      const toggler = document.querySelector(
        `input.overlayToggler[data-overlay-key="${key}"]`,
      ) as HTMLInputElement | null;
      if (toggler) {
        toggler.checked = show;
      }
      showOverlay(key as any, show);
      updateURLWithOverlays(getEnabledOverlays());
    },
    getDynamicPOIs: () => _currentDynamicPOIs,
    /**
     * Available POI inventory (no skip-creatures filter applied). Expanded
     * contents and boss rewards appear once; isBossReward distinguishes
     * guaranteed loot from Sage's natural-only baseline. Parent preview arrays
     * are display metadata, not additional inventory. Comparison seeds agree.
     */
    getAllDynamicPOIs: () => _allDynamicPOIs,
    isSpoilerFree: () => isSpoilerFree(),
    isBakedSeed: () => isBakedSeedView(),
    isLightMode: () => isLightMode(),
    isSkipCreatures: () => isSkipCreatures(),
    onSpoilerFreeChange: (cb: (enabled: boolean) => void) => onSpoilerFreeChange(cb),
    setAlchemyActive: (active: boolean) => _unifiedSearch?.setAlchemyActive(active),
    getIndexingState: () => _unifiedSearch?.getIndexingState() ?? "idle",
    onIndexingStateChange: (cb: (s: "idle" | "indexing" | "ready") => void) => {
      _unifiedSearch?.onIndexingStateChange(cb);
    },
    getMaterialInfo: (id: string) => getMaterialInfo(id),
    primeMaterialInfo: () => primeMaterialInfo(),
    getFlatPOIsForSeed: async (seed: number) => {
      // Cache-only lookup first. We intentionally do NOT generate here - that
      // has telescope-wide side effects (setUnlocks, biome data, pixel scene
      // cache writes) which can disturb the currently-rendered map.
      try {
        const cached = await getCachedGeneration(dailyCacheKey(seed));
        if (cached?.poisByPW) return getAllPOIsFlat({ poisByPW: cached.poisByPW } as any);
        // The comparison target is ALWAYS a daily seed, whose POIs are already
        // baked + served as generation.json by the CI pipeline. Fetch them
        // directly (instant) instead of regenerating client-side. Try today's
        // and yesterday's worker origins; fetchBakedGeneration validates the
        // seed, so a mismatch just falls through.
        const { fetchBakedGeneration } = await import("./telescope/baked-generation");
        const worlds: ("left" | "middle" | "right")[] = isLightMode() ? ["middle"] : ["left", "middle", "right"];
        for (const prefix of ["daily", "previous-daily"] as const) {
          const gen = await fetchBakedGeneration(prefix, worlds, seed).catch(() => null);
          if (gen?.poisByPW) return getAllPOIsFlat({ poisByPW: gen.poisByPW } as any);
        }
        return null;
      } catch (e) {
        console.warn("[Noitamap] getFlatPOIsForSeed failed:", e);
        return null;
      }
    },
    requestSeedStats: async (seed: number) => {
      // Background-generate + cache a comparison seed's POIs so a subsequent
      // getFlatPOIsForSeed hits. The comparison target is always a daily seed
      // (all-unlocked). Safe to call after the live map is ready.
      try {
        return await ensureSeedCached(seed, true);
      } catch (e) {
        console.warn("[Noitamap] requestSeedStats failed:", e);
        return false;
      }
    },
    // Blob URL for a wand's sprite (first frame, atlas or data.zip). Used by the
    // pro seed-report to draw wand icons — wands are procedural, so there's no
    // static asset the pro bundle could reference on its own.
    // Reuse the real atlas/material tint and canonical names for report loot,
    // instead of raw item ids or guesses at public asset filenames.
    getPOIPreview: async (poi) => ({
      name: getPOIDisplayName(poi),
      iconUrl: await getPOISpriteFirstFrame(poi),
    }),
    getPOIBiome: (poi) => {
      const seed = getCurrentDynamicSeed();
      const descriptor = getActiveDescriptor();
      const generation = descriptor === primaryDescriptor() ? getLastGenerationResult()
        : seed === null ? null : getAltResult(descriptor, seed);
      return getPOIBiomeDescription(poi, generation?.seed === seed ? generation : null);
    },
    getWandIconUrl: async (sprite: string): Promise<string | null> => {
      try {
        return await getPOISpriteFirstFrame({ type: "wand", sprite });
      } catch (e) {
        console.warn("[Noitamap] getWandIconUrl failed:", e);
        return null;
      }
    },
    setReportHighlights: (targets, options) => {
      const state = authService.getState();
      if (!poiContextReady || reportMapLoading || !state.authenticated || !state.isSubscriber || isSpoilerFree() || app.getMap() !== 'dynamic-main-branch') {
        targets = [];
        options = { ...options, restore: false };
      }
      if (targets.length) reportHighlights ??= new ReportMapHighlights(app.osd.viewer);
      reportHighlights?.setTargets(targets, options);
    },
    getReportMapView: () => {
      const previewOrigin = reportHighlights?.getReturnView();
      if (previewOrigin) return previewOrigin;
      const center = app.osd.viewport.getCenter(true), zoom = app.osd.viewport.getZoom(true);
      return center && [center.x, center.y, zoom].every(Number.isFinite) && zoom > 0
        ? { x: center.x, y: center.y, zoom } : null;
    },
    restoreReportMapView: view => {
      if (!poiContextReady || app.getMap() !== 'dynamic-main-branch') return;
      reportHighlights ??= new ReportMapHighlights(app.osd.viewer);
      reportHighlights.restoreView(view);
    },
    setHighValuePredicate: (pred: ((poi: any) => boolean) | null) => {
      Promise.resolve().then(() => {
        applyHighValueOverlays(pred);
      });
    },
    closePOICard,
    openPOIById: (poiId: string, opts?: { sidebarRightPx?: number; preserveReportHighlights?: boolean; fallbackX?: number; fallbackY?: number; fallbackPoi?: any; owner?: 'report' }) => {
      if (!poiContextReady || app.getMap() !== 'dynamic-main-branch') return;
      if (!opts?.preserveReportHighlights) reportHighlights?.clear(false);
      if (opts?.owner === 'report') reportHighlights ??= new ReportMapHighlights(app.osd.viewer);
      openTooltipForPOI(poiId, app.osd, { ...opts, owner: opts?.owner ?? 'map' });
    },
    openReportPOICard: (poiId, opts) => {
      if (!poiContextReady || app.getMap() !== 'dynamic-main-branch') { opts.onClose(); return; }
      if (!opts.preserveReportHighlights) reportHighlights?.clear(false);
      reportHighlights ??= new ReportMapHighlights(app.osd.viewer);
      const { returnLabel, onClose, ...navigation } = opts;
      openTooltipForPOI(poiId, app.osd, { ...navigation, owner: 'report', reportReturn: { label: returnLabel, onClose } });
    },
    showGetProModal: () => {
      AuthUI.showGetProModal();
    },
    triggerPillarSearch: (
      query: string,
      note?: { text: string; telescopeUrl: string },
      filter?: string,
      resultNotice?: string,
      rebuild?: () => string,
    ) => {
      if (!_unifiedSearch) return;
      // Swap the active category filters for the one matching this link's
      // target (or clear them) BEFORE searching, so results aren't hidden by a
      // filter left over from a previous pillar link.
      _unifiedSearch.setCategoryFilter(filter);
      // triggerSearch* set explicitShowRequested, so the results overlay opens
      // via the setResults/setNoResults wrappers without a stale-input search.
      if (note) _unifiedSearch.triggerSearchWithFallback(query, note, resultNotice, rebuild);
      else _unifiedSearch.triggerSearch(query);
      updateURLWithSearch(query, _unifiedSearch.activeFilters);
    },
  };
  window.__noitamap = proHooks;

  // Advertise lazy-feature support; cached older Pro bundles remain compatible.
  proHooks.proFeatureAPI = 1;
  const loadProBundle = createProLoader(proHooks);

  // Expose a pro-load requester so non-pro search components (AP/LC buttons)
  // can trigger pro loading after an auth check.
  (proHooks as any).requestProLoad = loadProBundle;

  // Initialize Drawing UI (Brush Button)
  // This handles the "Get Pro" modal for unauthed users and loads the pro bundle for subscribers
  const drawingUI = new DrawingUI(authContainer, {
    onEnableDrawing: () => loadProBundle("drawing"),
  });

  // Seed Report toggle button — sits next to the drawing toggle.
  // Auto-loads the Pro bundle on first click. The bundle renders the subscriber
  // tools or the existing locked/skeleton views from the resolved auth state.
  {
    const drawingWrap = document.getElementById("drawing-ui-wrapper");
    if (drawingWrap) {
      createSeedReportButton(drawingWrap, { loadProBundle: () => loadProBundle("report") });
    }
  }

  // Now that all runtime-injected navbar buttons exist (auth/Get Pro, drawing,
  // seed report), park the "..." overflow button at the very end of the row.
  placeBiomeBoundariesButton();
  placeMoreMenuLast();

  // Initialize Drop Overlay
  setupDropOverlay(i18next, () => loadProBundle("drawing"));

  // Dynamically load the pro bundle when URL requests sidebar (auth check handled inside pro bundle)
  if (!urlState.seedReportOpen) {
    if (urlState.sidebarOpen) drawingUI.openFromURL();
    else if (isDev && localStorage.getItem("noitamap-dev-drawing") === "1") loadProBundle("drawing");
  }

  // link to the app
  unifiedSearch.on("selected", (result: any) => {
    if (result.type === "spell") {
      // Fill the search box with the spell name without triggering new search
      unifiedSearch.setSearchValueWithoutTriggering(result.spell.name);
      // Hide the search overlay
      const overlay = document.getElementById("unifiedSearchResultsOverlay");
      if (overlay) {
        overlay.style.display = "none";
      }
      // Trigger overlays for the selected spell
      selectSpell(result.spell, app);
    } else {
      // Mirror the seed-report row behaviour: openTooltipForPOI handles the
      // cinematic pan AND opens the POI card once the pan settles. Pass the
      // POI itself as fallback so the card opens even if markerData hasn't
      // indexed this id for the current unlocks variant.
      const poiId = result.id;
      if (poiId && app.getMap() === "dynamic-main-branch") {
        if (poiContextReady) {
          openTooltipForPOI(poiId, app.osd, {
            fallbackX: result.x,
            fallbackY: result.y,
            fallbackPoi: result,
            owner: 'map',
          });
        }
      } else {
        app.goto(result);
      }

      // Instantly update the URL to point to this selected POI
      if (result.id || (result.x != null && result.y != null)) {
         const pid = result.id || `st-${Math.round(result.x)}_${Math.round(result.y)}`;
         const url = new URL(window.location.href);
         url.searchParams.set("poi", pid);

         const qValue = unifiedSearch.getCurrentQuery();
         if (qValue) {
            url.searchParams.set("q", qValue);
         }
         reorderParams(url);
         window.history.replaceState({}, "", url.toString());
      }
    }
  });

  const debouncedUpdateURL = debounce(100, updateURL);
  const debouncedViewportNotify = debounce(300, () => unifiedSearch.notifyViewportChanged());

  // Pause search sorting during active interaction to keep map navigation smooth
  app.osd.addHandler("canvas-drag", () => {
     unifiedSearch.setInteracting(true);
     clearTargetPoiId();
  });
  app.osd.addHandler("canvas-scroll", () => {
     unifiedSearch.setInteracting(true);
     clearTargetPoiId();
  });
  app.osd.addHandler("canvas-drag-end", () => unifiedSearch.setInteracting(false));
  app.osd.addHandler("animation-finish", () => unifiedSearch.setInteracting(false));

  // Track previous map so state-change can detect transitions away from dynamic
  let lastKnownMap: string = app.getMap();
  let renderedMap: string | undefined;

  app.on("state-change", (state) => {
    // record map / position / zoom changes to the URL when they happen
    debouncedUpdateURL(state);
    // Re-sort search results by proximity to the new viewport position
    debouncedViewportNotify();

    // Clean up dynamic map state whenever we leave the dynamic map, regardless
    // of the trigger (nav click, pro-bundle import, setMap hook, etc.)
    if (lastKnownMap === "dynamic-main-branch" && state.map !== "dynamic-main-branch") {
      clearDynamicMap(app.osd);
      unifiedSearch.setDynamicPOIs([]);
      unifiedSearch.setIndexingState('idle');
    } else if (lastKnownMap !== "dynamic-main-branch" && state.map === "dynamic-main-branch") {
      // Moving TO dynamic map — if we have a pending seed from drawing import, use it directly
      if (pendingDynamicSeed !== null) {
        const seedToRun = pendingDynamicSeed;
        pendingDynamicSeed = null;
        runDynamicMap(seedToRun, false, dynamicOpts).catch((e) => console.error("[Noitamap] Dynamic map switch (pending seed) failed:", e));
      } else {
        // Priority: URL seed > last session seed > daily
        runDynamicMapWithPriority().catch((e) => console.error("[Noitamap] Dynamic map switch failed:", e));
      }
    }
    lastKnownMap = state.map;

    // Camera frames still update URL/search above. Toolbar DOM and Bootstrap
    // instances only need work when the selected map actually changes.
    if (renderedMap === state.map) return;
    renderedMap = state.map;
    updateDynamicUIVisibility(state.map);

    const currentMapLink = document.querySelector(`#navLinksList [data-map-key='${state.map}']`);

    if (!(currentMapLink instanceof HTMLElement)) return;

    // Remove "active" class from any nav links that still have it
    document.querySelectorAll("#navLinksList .nav-link.active").forEach((el) => {
      el.classList.remove("active");
    });

    // Add "active" class to the nav-link identified by `mapName`
    currentMapLink.classList.add("active");

    // Update button text to show current map name
    updateMapSelectorText(state.map);
  });

  const loadingIndicator = assertElementById("loadingIndicator", HTMLElement);
  // show/hide loading indicator — BUT suppress while on the dynamic map
  // because OSD keeps emitting loading-change(true) as it lazily loads the
  // many biome tile images, which would keep the spinner stuck.
  app.on("loading-change", (isLoading) => {
    if (app.getMap() === "dynamic-main-branch") return;
    loadingIndicator.style.display = isLoading ? "block" : "none";
  });

  // respond to changes of map
  const mapLinksUL = createMapLinks();
  mapLinksUL.addEventListener("click", (ev) => {
    if (!(ev.target instanceof HTMLElement)) return;

    const link = ev.target.closest(`.${NAV_LINK_IDENTIFIER}`);
    if (!link || !(link instanceof HTMLElement)) return;

    const newMap = link.dataset.mapKey;
    const mapName = asMapName(newMap);
    if (!mapName) {
      console.error(`Attempted to change to an unknown map: '${newMap}'`);
      return;
    }

    // Blur to restore hotkey focus to document
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Notify pro bundle about map change (drawing reset, etc.)
    for (const cb of mapChangeCallbacks) {
      cb(mapName);
    }

    // load the new map
    app.setMap(mapName);
    // set which map we're searching
    unifiedSearch.currentMap = mapName;
  });

  // manage css classes to show / hide overlays
  const handleOverlayToggle = (ev: Event) => {
    const target = ev.target;

    // not an input element
    if (!(target instanceof HTMLInputElement)) return;

    // not a checkbox
    if (target.getAttribute("type") !== "checkbox") return;

    // overlay isn't defined on this checkbox
    const overlayKey = asOverlayKey(target.dataset.overlayKey);
    if (!overlayKey) return;

    ev.stopPropagation();

    showOverlay(overlayKey, target.checked);

    // Update URL with current overlays state
    updateURLWithOverlays(getEnabledOverlays());
  };

  addEventListenerForId("overlay-selector", "click", handleOverlayToggle);
  addEventListenerForId("biome-boundaries-ui-wrapper", "click", handleOverlayToggle);

  // Dismiss any lingering popovers left over from a pre-reload state
  document.querySelectorAll('.popover').forEach((el: Element) => el.remove());

  // Initialize Bootstrap popovers (skip elements already initialised by
  // createDynamicUI / DrawingUI / UnifiedSearch to avoid the "Bootstrap
  // doesn't allow more than one instance per element" error).
  for (const el of document.querySelectorAll('[data-bs-toggle="popover"]')) {
    if (!bootstrap.Popover.getInstance(el)) {
      new bootstrap.Popover(el);
    }
  }
  // Touch devices can't "un-hover", so hover/focus popovers stay stuck open —
  // one global pointerup listener makes them tap-to-dismiss (mobile only).
  installPopoverTouchDismiss();
  // The perfMode button uses data-bs-toggle="dropdown", so attach its popover
  // to the dropdown wrapper element.
  const perfModeBtn = document.getElementById("perfModeButton");
  const perfDropdownEl = document.getElementById("perfModeDropdown");
  if (perfDropdownEl && perfModeBtn) {
    const isPerfDropdownOpen = () =>
      perfModeBtn.getAttribute("aria-expanded") === "true" ||
      !!perfDropdownEl.querySelector(".dropdown-menu.show");
    const showPerfPopover = () => {
      if (isPerfDropdownOpen()) return;
      bootstrap.Popover.getInstance(perfDropdownEl)?.show();
    };
    const hidePerfPopover = () => {
      bootstrap.Popover.getInstance(perfDropdownEl)?.hide();
    };
    perfDropdownEl.addEventListener("mouseenter", showPerfPopover);
    perfDropdownEl.addEventListener("mouseleave", hidePerfPopover);
    perfDropdownEl.addEventListener("focus", showPerfPopover);
    perfDropdownEl.addEventListener("blur", hidePerfPopover);

    perfModeBtn.addEventListener("show.bs.dropdown", hidePerfPopover);
    perfModeBtn.addEventListener("hidden.bs.dropdown", () => {
      perfDropdownEl.querySelectorAll('[data-bs-toggle="popover"]').forEach((el: Element) => {
        bootstrap.Popover.getInstance(el)?.hide();
      });
    });

    // Bootstrap's outside-click dismiss doesn't fire reliably when the click
    // lands on the OpenSeadragon canvas (its pointer/mouse tracker swallows
    // the click event before it bubbles to document). Use capture-phase
    // listeners as a safety net so the menu and popover always dismiss.
    const closeOutside = (e: Event) => {
      const target = e.target as Node;
      const inDropdown = perfDropdownEl.contains(target);
      if (isPerfDropdownOpen() && !inDropdown) {
        bootstrap.Dropdown.getOrCreateInstance(perfModeBtn).hide();
      }
      if (!inDropdown && !perfDropdownEl.contains(target)) {
        hidePerfPopover();
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("mousedown", closeOutside, true);
    document.addEventListener("click", closeOutside, true);
  }
  // Initialize Bootstrap tooltips
  for (const el of document.querySelectorAll('[data-bs-toggle="tooltip"]')) {
    new bootstrap.Tooltip(el);
  }

  // share button with toast notification (simple URL copy â€” pro bundle patches this for drawing share)
  // Global function to build a complete share URL including map overlays and dynamic seeds
  const getShareUrl = (poiId?: string) => {
    const url = new URL(window.location.href);
    const overlays = getEnabledOverlays();
    if (overlays.length > 0) {
      url.searchParams.set("o", overlays.map(overlayToShort).join(","));
    } else {
      url.searchParams.delete("o");
    }
    url.searchParams.delete("d");

    // Pin the seed even for daily mode: ds controls unlocks, not 'load today'.
    if (app.getMap() === "dynamic-main-branch") {
      const seed = getCurrentDynamicSeed();
      const isDaily = getCurrentIsDaily();
      if (seed !== null) {
        url.searchParams.set("se", String(seed));
        if (isDaily) url.searchParams.set("ds", "1");
        else url.searchParams.delete("ds");
      }
    }

    if (poiId) {
      url.searchParams.delete("px");
      url.searchParams.delete("py");
      url.searchParams.set("poi", poiId);
    }

    // Encode the active unlock view into the link so the recipient sees the
    // same wand/spell/chest contents. `mod` (base64url full list) is left
    // as-is: it's already in the URL from the in-game deeplink, and re-sharing
    // the mod payload is useful when the recipient wants to see the sender's
    // current progress.
    try {
      const desc = getActiveDescriptor();
      if (desc === "none") url.searchParams.set("u", "none");
      else if (desc === "all") url.searchParams.set("u", "all");
      // desc === "mod": preserve whatever `u=` value is already on the URL
    } catch { /* noop */ }
    reorderParams(url);
    return url.toString();
  };
  (window as any).getShareUrl = getShareUrl;

  // ─── Console command: main-path-only biome boundaries view ──────────────
  // Dev/power-user helper. Toggling re-applies inline styles on every
  // .biome-overlay-path so:
  //   - Main-path biomes stay visible at the same opacity as a hovered
  //     boundary (~0.75) so the "active path" reads clearly.
  //   - All non-main-path boundaries are hidden completely.
  // The overlay layer must already be enabled (the biome-boundaries toggle
  // in the sidebar / `bb` URL param) for this to do anything visible.
  let mainPathBoundariesOn = false;
  const applyMainPathBoundaries = () => {
    const paths = document.querySelectorAll<HTMLElement>('.biome-overlay-path');
    paths.forEach((el) => {
      const slug = el.dataset.biomeSlug ?? '';
      const main = isMainPathBiome(slug);
      const svgPaths = el.querySelectorAll<SVGPathElement>('svg path');
      if (mainPathBoundariesOn) {
        if (main) {
          el.style.display = '';
          svgPaths.forEach((p) => {
            p.style.fillOpacity = '0.75';
            p.style.filter = '';
          });
        } else {
          el.style.display = 'none';
        }
      } else {
        // Restore defaults: clear inline overrides so CSS owns idle + hover
        // styling (.biome-overlay-path path in overlay-styles.css).
        el.style.display = '';
        svgPaths.forEach((p) => {
          p.style.fillOpacity = '';
          p.style.filter = '';
        });
      }
    });
  };
  (window as any).toggleMainPathBoundaries = (force?: boolean): boolean => {
    mainPathBoundariesOn = typeof force === 'boolean' ? force : !mainPathBoundariesOn;
    applyMainPathBoundaries();
    console.log(
      `[noitamap] main-path-only biome boundaries: ${mainPathBoundariesOn ? 'ON' : 'OFF'}` +
      (mainPathBoundariesOn
        ? ' — non-main-path boundaries hidden, main-path biomes shown at hover opacity.'
        : ' — restored to default styling.'),
    );
    return mainPathBoundariesOn;
  };
  // Re-apply whenever the overlay layer is rebuilt (map change, etc.).
  app.osd.addHandler('open', () => {
    if (mainPathBoundariesOn) setTimeout(applyMainPathBoundaries, 0);
  });

  const resolveSpawnRegions = (raw: string, mode: 'normal' | 'ng-plus' = 'normal') => {
    const dynamic = app.getMap() === 'dynamic-main-branch';
    const generation = dynamic ? getLastGenerationResult() : null;
    // The existing boundary overlay describes the normal world layout.
    // Never use it to claim an NG+ location or navigate during replacement.
    const map = dynamic && !poiContextReady ? '' : app.getMap();
    return resolveCreatureSpawnBiomes(raw, map, mode === 'ng-plus' || generation?.isNGP ? 1 : generation?.ngPlus ?? 0);
  };
  const applySpawnRegions = (raw: string, frame: boolean, source?: HTMLElement): boolean => {
    // Check again at the actual application point, including asynchronous
    // shared-link restoration and stale card actions after signing out.
    if (!isProUser()) return false;
    const result = resolveSpawnRegions(raw);
    if (!result.supported || !result.bounds) return false;
    if (frame && (app.osd.canvas.clientWidth <= 96 || app.osd.canvas.clientHeight <= 96)) return false;
    if (!focusCreatureSpawnBiomes(result, osdRootElement)) return false;
    // Closing first restores a suspended report before measuring free map
    // space. Its focus/highlight restoration must precede this new view.
    if (source) dismissEnclosingPopup(source);
    if (frame) app.osd.cancelNavigation();
    reportHighlights?.clear(false);
    if (mainPathBoundariesOn) {
      mainPathBoundariesOn = false;
      applyMainPathBoundaries();
    }
    const toggler = document.querySelector<HTMLInputElement>('input.overlayToggler[data-overlay-key="biomeBoundaries"]');
    if (toggler) toggler.checked = true;
    showOverlay('biomeBoundaries', true);
    updateURLWithOverlays(getEnabledOverlays());
    const framed = !frame || frameCreatureSpawnBiomes(app.osd, result.bounds);
    if (!framed) clearCreatureSpawnBiomeFocus(osdRootElement);
    return framed;
  };

  const viewControls = assertElementById('map-view-controls', HTMLElement);
  const dismissSpawnView = () => {
    spawnSharing?.dismiss();
    const toggler = document.querySelector<HTMLInputElement>('input.overlayToggler[data-overlay-key="biomeBoundaries"]');
    if (toggler) toggler.checked = false;
    showOverlay('biomeBoundaries', false);
    updateURLWithOverlays(getEnabledOverlays());
  };
  const spawnNotice = mountCreatureSpawnNotice(viewControls,
    () => AuthUI.showGetProModal(), dismissSpawnView);
  spawnSharing = createCreatureSpawnSharing({
    loadSpawn: async id => {
      if (!isProUser()) return null;
      await loadExtendedCreatures();
      return isProUser() ? getExtendedCreature(id)?.spawnLocation ?? null : null;
    },
    apply: applySpawnRegions,
    clearFocus: () => clearCreatureSpawnBiomeFocus(osdRootElement),
    writeRequest: updateURLWithCreatureSpawn,
    notice: status => spawnNotice.update(status),
  }, urlState.spawnCreatureId, !urlState.pos && !urlState.targetPoiId);
  spawnSharing.setMapReady(app.getMap() !== 'dynamic-main-branch' || poiContextReady);
  // subscribe() does not replay the initial state. Wait for startup auth so a
  // returning subscriber never briefly gets the free-view notice or a fetch.
  let spawnAuthReady = false;
  const syncSpawnAccess = () => spawnSharing?.setEntitled(isProUser());
  authService.subscribe(() => { if (spawnAuthReady) syncSpawnAccess(); });
  void authService.ready.then(() => { spawnAuthReady = true; syncSpawnAccess(); });

  setCreatureSpawnNavigation({
    resolve: (raw, mode) => {
      const result = resolveSpawnRegions(raw, mode);
      return { canNavigate: isProUser() && result.supported && !!result.bounds, missing: result.supported ? result.missing : [] };
    },
    navigate: (raw, source, mode, creatureId) => {
      const id = normalizeSpawnCreatureId(creatureId);
      if (!id || mode !== 'normal' || !isProUser()) return false;
      if (!applySpawnRegions(raw, true, source)) return false;
      spawnSharing!.setMapReady(true);
      if (spawnSharing!.rememberApplied(id)) {
        cueBiomeBoundariesButton();
        return true;
      }
      clearCreatureSpawnBiomeFocus(osdRootElement);
      return false;
    },
  });

  // Covers the original toggle and programmatic overlay changes too. Auth loss
  // only clears the filter, so it keeps the pending URL request for later login.
  let boundariesEnabled = osdRootElement.classList.contains('show-biomeBoundaries');
  new MutationObserver(() => {
    const enabled = osdRootElement.classList.contains('show-biomeBoundaries');
    if (boundariesEnabled && !enabled) spawnSharing?.dismiss();
    boundariesEnabled = enabled;
  }).observe(osdRootElement, { attributes: true, attributeFilter: ['class'] });

  const shareEl = assertElementById("shareButton", HTMLElement);
  shareEl.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const finalUrl = getShareUrl();

    window.navigator.clipboard
      .writeText(finalUrl)
      .then(() => {
        const toastElement = assertElementById("shareToast", HTMLElement);
        const toastBody = toastElement.querySelector(".toast-body");
        if (toastBody) {
          toastBody.innerHTML = `<i class="bi bi-check-circle me-2"></i>${i18next.t("share.copied")}`;
        }
        const toast = new bootstrap.Toast(toastElement, {
          autohide: true,
          delay: 2000,
        });
        toast.show();
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  });

  // Mouse tracker for displaying coordinates
  const { copyCoordinates } = initMouseTracker({
    osd: app.osd,
    osdElement: osdRootElement,
    tooltipElement: assertElementById("coordinate", HTMLElement),
  });
  document.addEventListener("keydown", copyCoordinates, { capture: false });

  // Handle renderer changes
  rendererForm.addEventListener("change", (ev) => {
    if (!ev.target || !(ev.target as HTMLElement).matches('input[type="radio"][name="renderer"]')) return;

    ev.stopPropagation();
    const newRenderer = (rendererForm.elements as any)["renderer"].value;

    if (isRenderer(newRenderer)) {
      setStoredRenderer(newRenderer);
      window.location.reload();
    }
  });

  // Handle spoiler-free toggle — reload page to re-render all tiles
  // (same approach as renderer toggle, OSD tile cache can't be selectively invalidated)
  const spoilerFreeToggle = document.getElementById("spoilerFreeToggle") as HTMLInputElement | null;
  const updateSpoilerControlVisibility = (baked: boolean) => {
    const label = document.querySelector<HTMLElement>('label[for="spoilerFreeToggle"]');
    if (!spoilerFreeToggle || !label) return;
    spoilerFreeToggle.hidden = baked;
    spoilerFreeToggle.disabled = baked;
    label.hidden = baked;
    label.style.display = baked ? "none" : "";
    label.style.pointerEvents = "";
    label.setAttribute("data-i18n-content", "spoilerFree.content");
    label.setAttribute("data-bs-content", i18next.t("spoilerFree.content") as string);
    const popover = bootstrap.Popover.getInstance(label);
    popover?.dispose();
    if (!baked) new bootstrap.Popover(label);
  };
  updateSpoilerControlVisibility(isBakedSeedView());
  // Baked seeds flatten wand/spell/item identities into the DZI pixels, so
  // spoiler-free cannot strip them — hide the ineffective control. The saved
  // preference is suspended (not cleared) while the baked map is active. Event fired by dynamic-map.ts whenever the baked state of
  // the current view changes.
  window.addEventListener("bakedSeedChange", ((e: CustomEvent) => {
    const baked = !!e.detail?.baked;
    loadingProgress.setBaked(baked);

    updateSpoilerControlVisibility(baked);

    // Daily baked maps already have all POIs baked in and render fast, so the
    // "Don't add creatures" / "Use simplistic map background" perf toggles serve
    // no purpose — disable them and explain why via their popovers. Each popover
    // host carries data-i18n-content-feature (its own title key) so the
    // "<feature> is unavailable for daily seeds" string interpolates and
    // survives language switches (see i18n-dom.ts).
    const perfToggles: [string, string, string][] = [
      ["skipCreaturesToggle", "skipCreaturesPopover", "skipCreatures.content"],
      ["simplisticBackgroundToggle", "simplisticBackgroundPopover", "simplisticBackground.content"],
    ];
    for (const [toggleId, popoverId, defaultContentKey] of perfToggles) {
      const toggle = document.getElementById(toggleId) as HTMLInputElement | null;
      const host = document.getElementById(popoverId);
      if (!toggle || !host) continue;
      toggle.disabled = baked;
      const featureKey = host.getAttribute("data-i18n-content-feature");
      const contentKey = baked ? "spoilerFree.unavailableDaily" : defaultContentKey;
      const opts = baked && featureKey ? { feature: i18next.t(featureKey) } : undefined;
      host.setAttribute("data-i18n-content", contentKey);
      host.setAttribute("data-bs-content", i18next.t(contentKey, opts as any) as string);
      const existing = bootstrap.Popover.getInstance(host);
      if (existing) existing.dispose();
      new bootstrap.Popover(host);
    }
  }) as EventListener);
  if (spoilerFreeToggle) {
    spoilerFreeToggle.checked = isSpoilerFree();
    spoilerFreeToggle.addEventListener("change", () => {
      setSpoilerFree(spoilerFreeToggle.checked);
      // Dispose the popover entirely and remove any leftover DOM elements
      // before reloading, to prevent it from lingering after page restore.
      const label = document.querySelector<HTMLElement>('label[for="spoilerFreeToggle"]');
      if (label) {
        const popover = bootstrap.Popover.getInstance(label);
        if (popover) popover.dispose();
        label.blur();
      }
      spoilerFreeToggle.blur();
      document.querySelectorAll('.popover').forEach((el: Element) => el.remove());
      // Defer reload briefly so the DOM cleanup above takes effect
      setTimeout(() => window.location.reload(), 50);
    });
  }

  // Handle light-mode toggle — full reload so OSD re-opens without the
  // left/right PW static tile sources. Dynamic generation is IDB-cached,
  // so the reload cost is essentially just a page refresh.
  const lightModeToggle = document.getElementById("lightModeToggle") as HTMLInputElement | null;
  if (lightModeToggle) {
    lightModeToggle.checked = isLightMode();
    lightModeToggle.addEventListener("change", () => {
      setLightMode(lightModeToggle.checked);
      lightModeToggle.blur();
      setTimeout(() => window.location.reload(), 50);
    });
  }

  // "Don't add creatures" toggle — strips enemy/prop POIs from the marker
  // layer. Doesn't need a full reload (no biome/PW change), but we re-render
  // so the marker layer rebuilds without enemies.
  const skipCreaturesToggle = document.getElementById("skipCreaturesToggle") as HTMLInputElement | null;
  if (skipCreaturesToggle) {
    skipCreaturesToggle.checked = isSkipCreatures();
    skipCreaturesToggle.addEventListener("change", () => {
      setSkipCreatures(skipCreaturesToggle.checked);
      skipCreaturesToggle.blur();
      setTimeout(() => window.location.reload(), 50);
    });
  }

  // "Use simplistic map background" toggle — swaps the streamed DZI tile
  // pyramids for a flat per-PW PNG. The choice is applied when OSD opens the
  // map (AppOSD.setMap), so reload to rebuild the viewer from scratch.
  const simplisticBackgroundToggle = document.getElementById("simplisticBackgroundToggle") as HTMLInputElement | null;
  if (simplisticBackgroundToggle) {
    simplisticBackgroundToggle.checked = isSimplisticBackground();
    simplisticBackgroundToggle.addEventListener("change", () => {
      setSimplisticBackground(simplisticBackgroundToggle.checked);
      simplisticBackgroundToggle.blur();
      setTimeout(() => window.location.reload(), 50);
    });
  }

  // "Animated portals" toggle — drives the GPU portal renderer directly, so no
  // reload: portals/index.ts subscribes to the setting and starts/stops the
  // worker in place. Available on baked and generated maps alike.
  const portalAnimationsToggle = document.getElementById("portalAnimationsToggle") as HTMLInputElement | null;
  if (portalAnimationsToggle) {
    portalAnimationsToggle.checked = isPortalAnimations();
    portalAnimationsToggle.addEventListener("change", () => {
      setPortalAnimations(portalAnimationsToggle.checked);
      portalAnimationsToggle.blur();
    });
  }

  initKonamiCode();
});
