import i18next, { SUPPORTED_LANGUAGES } from "./i18n";
import { setupDropOverlay } from "./drop-overlay";
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
import { rebuildAltLayers, getAllPOIsFlat, exportBiomeRegionImages, prepareDecorationExport, exportDecorationCell, releaseDecorationExport } from "./telescope/telescope-osd-bridge";
import { getUnlocksFromURL } from "./unlocks";
import type { GenerationResult } from "./telescope/telescope-adapter";
import { isRenderer, getStoredRenderer, setStoredRenderer, clearStoredRenderer } from "./renderer_settings";

// --- Dev Console Commands (Early Initialization) ---
const isDev =
  /dev\.noitamap\.com|localhost|127\.0\.0\.1/.test(window.location.hostname) || window.location.protocol === "file:";

if (isDev) {
  (window as any).noitamap = {
    enableDrawing: () => {
      localStorage.setItem("noitamap-dev-drawing", "1");
      console.log("Drawing dev mode enabled. Refresh and open the sidebar.");
    },
    disableDrawing: () => {
      localStorage.removeItem("noitamap-dev-drawing");
      console.log("Drawing dev mode disabled. Refresh to hide the sidebar.");
    },
    exportData: () => {
      const result = getLastGenerationResult();
      if (!result) {
        console.warn("No dynamic generation data available to export.");
        return;
      }
      // Prepare serializable copy
      const exportable = {
        seed: result.seed,
        ngPlus: result.ngPlus,
        isNGP: result.isNGP,
        worldSize: result.worldSize,
        worldCenter: result.worldCenter,
        poisByPW: Object.entries(result.poisByPW).reduce((acc, [pw, pois]) => {
          acc[pw] = pois.map((p) => {
            const { x, y, type, ...rest } = p;
            return { x, y, type, data: rest };
          });
          return acc;
        }, {} as any),
        pixelScenesByPW: Object.entries(result.pixelScenesByPW).reduce((acc, [pw, scenes]) => {
          acc[pw] = scenes.map((s) => ({ x: s.x, y: s.y, name: s.name, key: s.key }));
          return acc;
        }, {} as any),
        eyes: result.eyes,
        parallelWorlds: result.parallelWorlds,
        biomes: result.tileLayers.map((l) => ({ name: l.biomeName, x: l.correctedX, y: l.correctedY, w: l.w, h: l.h })),
      };
      const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `noitamap-seed-${result.seed}.json`;
      a.click();
      URL.revokeObjectURL(url);
      console.log(`Exported data for seed ${result.seed}`);
    },
    // Biomes are ready once a full render has completed (lastResult is set
    // after renderGenerationResult, which awaits the biome pass). Used by
    // build-daily-seed-images.cjs to wait for biomes, not POIs.
    biomesReady: () => {
      const r = getLastGenerationResult();
      return !!(r && r.tileLayers && r.tileLayers.length);
    },
    exportBiomeRegions: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      return exportBiomeRegionImages(result);
    },
    // Serialized generation result (POIs, pixel scenes, biome map) for the
    // bake pipeline. build-daily-seed-images.cjs writes this as
    // generation.json; stitch-dzis.cjs splits it per world; the live map
    // loads it from the static workers and skips telescope entirely.
    exportGenerationData: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      const { serializeGenerationForBake } = await import("./telescope/baked-generation");
      return serializeGenerationForBake(result);
    },
    // Decoration bake (pixel scenes + POI marker sprites) at native scale.
    // build-daily-seed-images.cjs calls prepareDecorationExport() once, then
    // exportDecorationCell(cx, cy) per non-empty 2048px world-grid cell; the
    // upscale step composites those cells onto the region fulls before stitch,
    // so the deployed pyramids carry scenes + creatures in their pixels.
    prepareDecorationExport: async () => {
      const result = getLastGenerationResult();
      if (!result) return null;
      return prepareDecorationExport(result);
    },
    exportDecorationCell: (cx: number, cy: number) => exportDecorationCell(cx, cy),
    releaseDecorationExport: () => releaseDecorationExport(),
    // Dev-only OSD drawer override. Default everywhere is "canvas" (the prod
    // setting in renderer_settings.ts). On localhost/dev.noitamap.com this
    // hook flips it via localStorage so we can A/B test perf and baked-DZI
    // edge fringing at zoom without shipping webgl to users.
    //   noitamap.setRenderer("webgl")  -> opt in, reload page
    //   noitamap.setRenderer("canvas") -> opt back to default, reload
    //   noitamap.getRenderer()         -> see what the next reload will use
    //   noitamap.clearRenderer()       -> wipe override, fall back to default
    setRenderer: (r: "canvas" | "webgl") => {
      if (r !== "canvas" && r !== "webgl") {
        console.warn('Use "canvas" or "webgl"'); return;
      }
      setStoredRenderer(r);
      console.log(`[Noitamap] Renderer set to "${r}". Reload the page to apply.`);
    },
    getRenderer: () => getStoredRenderer(),
    clearRenderer: () => {
      clearStoredRenderer();
      console.log("[Noitamap] Renderer override cleared. Reload to use the default.");
    },
  };
  console.log('[Noitamap] Dev mode detected, "noitamap" commands available.');
}

// temporary comment to force deploy to CF
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
} from "./data_sources/url";
import { asOverlayKey, showOverlay, selectSpell, OverlayKey } from "./data_sources/overlays";
import { isMainPathBiome } from "./data_sources/main-path-biomes";
import { overlayToShort } from "./data_sources/param-mappings";
import { UnifiedSearch } from "./search/unifiedsearch";
import { asMapName, MapName } from "./data_sources/tile_data";
import { addEventListenerForId, assertElementById, debounce } from "./util";
import { createMapLinks, NAV_LINK_IDENTIFIER, getMapLabel, renderMapBadges, refreshBadgePopovers } from "./nav";
import { getAllMapDefinitions } from "./data_sources/map_definitions";
import { initMouseTracker } from "./mouse_tracker";
import { isSpoilerFree, setSpoilerFree, onSpoilerFreeChange } from "./spoiler-free";
import { isLightMode, setLightMode } from "./light-mode";
import { isSkipCreatures, setSkipCreatures } from "./skip-creatures";
import { isSimplisticBackground, setSimplisticBackground } from "./simplistic-background";
import { createLanguageSelector } from "./language-selector";
import { updateTranslations } from "./i18n-dom";
import { initKonamiCode } from "./konami";
import { AuthUI } from "./auth/auth-ui";
import { authService } from "./auth/auth-service";
import { DrawingUI } from "./drawing/drawing-ui";
import { createSeedReportButton } from "./seed-report-button";
import { initChunkGrid, showChunkGrid, isChunkGridVisible } from "./drawing/chunk-grid";
import { getMaterialInfo, primeMaterialInfo } from "./material-info";

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
  // Start preloading the atlas for search results immediately
  import("./telescope/poi-spatial-index")
    .then((m) => m.loadSpritesheetAndAtlas())
    .catch((e) => console.warn("[Noitamap] Atlas preload failed:", e));

  try {
    await i18next.init({
      fallbackLng: "en",
      debug: false,
      showSupportNotice: false,
      detection: {
        order: ["querystring", "cookie", "localStorage", "sessionStorage", "navigator", "htmlTag"],
        lookupQuerystring: "lng",
        lookupCookie: "i18next",
        lookupLocalStorage: "i18nextLng",
        lookupSessionStorage: "i18nextLng",
        caches: ["localStorage", "cookie"],
      },
      backend: {
        loadPath: "./locales/{{lng}}/translation.json",
        requestOptions: {
          cache: "no-store",
        },
      },
      interpolation: {
        escapeValue: false,
      },
      supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
      load: "languageOnly",
      cleanCode: true,
      nonExplicitSupportedLngs: true,
    });

    createLanguageSelector();
    updateTranslations();
  } catch (error) {
    console.error("i18next initialization failed:", error);
  }

  // Handle map loading progress UI (non-blocking strip)
  const _getDownloadBar = () => document.getElementById("loading-bar-download") as HTMLElement | null;
  const _getGenerationBar = () => document.getElementById("loading-bar-generation") as HTMLElement | null;
  const _getItemsBar = () => document.getElementById("loading-bar-items") as HTMLElement | null;
  const _getStatusText = () => document.getElementById("map-loading-status");
  const _getTitle = () => document.getElementById("map-loading-title");

  // Pin the phase label column to the widest of the three phase translations
  // in the current language, so the percent column never shifts when the
  // phase text changes. Re-measure on language change.
  const _phaseKeys = [
    "loading.mapData.downloading",
    "loading.mapData.generating",
    "loading.mapData.addingItems",
  ];
  const _recomputePhaseMinWidth = () => {
    const phaseEl = _getTitle();
    if (!phaseEl) return;
    const probe = document.createElement("span");
    const cs = getComputedStyle(phaseEl);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.style.fontFeatureSettings = cs.fontFeatureSettings;
    document.body.appendChild(probe);
    let maxW = 0;
    for (const k of _phaseKeys) {
      probe.textContent = i18next.isInitialized ? i18next.t(k) : k;
      if (probe.offsetWidth > maxW) maxW = probe.offsetWidth;
    }
    probe.remove();
    const fontSizePx = parseFloat(cs.fontSize) || 16;
    phaseEl.style.minWidth = `${(maxW / fontSizePx).toFixed(3)}em`;
  };
  if (i18next.isInitialized) _recomputePhaseMinWidth();
  else i18next.on("initialized", _recomputePhaseMinWidth);
  i18next.on("languageChanged", _recomputePhaseMinWidth);

  window.addEventListener("dataZipProgress", ((e: CustomEvent) => {
    const bar = _getDownloadBar();
    const status = _getStatusText();
    const title = _getTitle();
    if (!bar) return;

    showLoadingStrip();

    if (e.detail.percentage < 100) {
      bar.style.width = `${e.detail.percentage}%`;
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.downloading") : "Downloading World Data";
      if (status) status.textContent = `${Math.round(e.detail.percentage / 3)}%`;
    } else {
      bar.style.width = "100%";
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.generating") : "Generating Biomes";
      if (status) status.textContent = "33%";
      // Add indeterminate animation to the track so the loading bar doesn't appear frozen
      const track = document.querySelector(".loading-strip-bar-track");
      if (track) track.classList.add("indeterminate");
    }
  }) as EventListener);

  window.addEventListener("biomeGenerationProgress", ((e: CustomEvent) => {
    const bar = _getGenerationBar();
    const status = _getStatusText();
    if (!bar) return;

    // Stop indeterminate animation once real progress arrives
    const track = document.querySelector(".loading-strip-bar-track");
    if (track) track.classList.remove("indeterminate");
    showLoadingStrip();
    bar.style.width = `${e.detail.percentage}%`;
    if (status) status.textContent = `${Math.round(33 + e.detail.percentage / 3)}%`;

    if (e.detail.percentage >= 100) {
      const title = _getTitle();
      if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.addingItems") : "Adding items and wands";
      bar.style.width = "100%";
      if (status) status.textContent = "66%";
    }
  }) as EventListener);

  window.addEventListener("itemsGenerationProgress", ((e: CustomEvent) => {
    const bar = _getItemsBar();
    const status = _getStatusText();
    if (!bar) return;

    showLoadingStrip();
    // Baked fast path: download/generation phases never ran (their bars are
    // untouched), so the items phase is the WHOLE strip — title it correctly
    // and show a true 0-100% instead of the 3-phase 66-100% tail.
    const itemsOnly =
      !parseFloat(_getDownloadBar()?.style.width || "0") && !parseFloat(_getGenerationBar()?.style.width || "0");
    const title = _getTitle();
    if (title) title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.addingItems") : "Adding items and wands";
    bar.style.width = `${e.detail.percentage}%`;
    if (status) {
      status.textContent = itemsOnly
        ? `${Math.round(e.detail.percentage)}%`
        : `${Math.round(66 + e.detail.percentage / 3)}%`;
    }

    if (e.detail.percentage >= 100) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          hideLoadingStrip();
          // Reset all bars for the next generation
          const dl = _getDownloadBar();
          const gen = _getGenerationBar();
          const it = _getItemsBar();
          if (dl) dl.style.width = "0%";
          if (gen) gen.style.width = "0%";
          if (it) it.style.width = "0%";
        });
      });
    }
  }) as EventListener);

  // TODO: probably most of this should be part of the "App" class, or the "App" class should be removed.
  // i'm not sure i'm happy with the abstraction

  const navbarBrandElement = assertElementById("navbar-brand", HTMLElement);
  const osdRootElement = assertElementById("osContainer", HTMLElement);
  const searchForm = assertElementById("search-form", HTMLFormElement);
  const overlayButtonsElement = assertElementById("overlay-selector", HTMLDivElement);
  const mapSelectorButton = assertElementById("mapSelectorButton", HTMLButtonElement);
  const tooltipElement = assertElementById("coordinate", HTMLElement);
  const coordinatesText = tooltipElement.innerText;
  const rendererForm = assertElementById("renderer-form", HTMLFormElement);

  // Initialize renderer from storage
  const storedRenderer = getStoredRenderer();
  (rendererForm.elements as any)["renderer"].value = storedRenderer;

  // Parse URL state including overlays and drawing
  const urlState = parseURL();

  const app = await App.create({
    mountTo: osdRootElement,
    overlayButtons: overlayButtonsElement,
    initialState: urlState,
    useWebGL: storedRenderer === "webgl",
  }).catch(async (e) => {
    // The default or URL-specified map failed to open (e.g. CORS block on a new domain).
    // Fall back to a known-good map so the rest of the app still initializes.
    console.warn("[Noitamap] Map failed to open, falling back to regular-main-branch:", e);
    return App.create({
      mountTo: osdRootElement,
      overlayButtons: overlayButtonsElement,
      initialState: { ...urlState, map: "regular-main-branch" as MapName },
      useWebGL: storedRenderer === "webgl",
    });
  });
  globalApp = app;
  console.log(`[Noitamap] Active OSD drawer: ${(app.osd as any).drawer?.getType?.() ?? storedRenderer}`);

  // Kick the daily baked-overlay fast path off NOW, in parallel with all the UI
  // wiring below. With no custom seed in the URL we know it's today's daily, so
  // its seed + baked-manifest round-trips run during init and are already
  // resolved by the time the dynamic pipeline (line ~681) reaches its probe —
  // letting the daily biome DZIs queue onto OSD nearly as early as the static
  // background instead of after all the setup + serial fetches.
  startDailyFastPath();

  // Helper to update the map selector button: shows the current map's full
  // label plus icon-only versions of its badges. Hover popovers on the badges
  // provide the full badge labels (same content as the dropdown items).
  const updateMapSelectorText = (mapName: string) => {
    const defs = getAllMapDefinitions();
    const match = defs.find(([key]) => key === mapName);
    if (!match) return;
    const def = match[1];
    mapSelectorButton.removeAttribute('data-i18n');
    mapSelectorButton.innerHTML = '';
    mapSelectorButton.classList.add('d-inline-flex', 'align-items-center', 'gap-1');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'me-2';
    labelSpan.textContent = getMapLabel(def);
    mapSelectorButton.appendChild(labelSpan);

    renderMapBadges(mapSelectorButton, def, true);
    refreshBadgePopovers(mapSelectorButton);
  };
  // Set initial button text
  updateMapSelectorText(app.getMap());
  i18next.on('languageChanged', () => updateMapSelectorText(app.getMap()));

  // Chunk grid toggle
  initChunkGrid(app.osd.viewer);
  const chunkGridToggler = document.getElementById("chunkGridToggler") as HTMLInputElement | null;
  if (chunkGridToggler) {
    chunkGridToggler.checked = isChunkGridVisible();
    if (chunkGridToggler.checked) showChunkGrid(true);
    chunkGridToggler.addEventListener("change", () => showChunkGrid(chunkGridToggler.checked));
  }

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
    initialTargetPoiId = undefined;
    setTimeout(() => {
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

  const dynamicOpts = {
    viewer: app.osd,
    onLoadingChange: (isLoading: boolean) => {
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
      lastSessionSeed = seed;
      lastSessionIsDaily = isDaily;
    },
    onPOIsReady: (pois: DynamicPOI[]) => {
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
      // Capture the value NOW before clearing the variable — the dynamic import
      // is async so the .then() callback would otherwise see undefined.
      if (initialTargetPoiId) {
        const capturedPoiId = initialTargetPoiId;
        initialTargetPoiId = undefined;
        // If the URL also requested the seed-report sidebar (?sr=1), wait a
        // brief moment for it to mount + open before triggering the tooltip
        // pan — otherwise the cinematic pan would compute its sidebar offset
        // before the sidebar is visible and the POI ends up behind the panel.
        const waitForSidebar = async (): Promise<void> => {
          const urlState = (await import("./data_sources/url")).parseURL();
          if (!urlState.seedReportOpen) return;
          for (let i = 0; i < 30; i++) {
            const el = document.getElementById("seed-report-sidebar");
            if (el && el.classList.contains("open")) return;
            await new Promise((r) => setTimeout(r, 100));
          }
        };
        Promise.all([
          import('./telescope/telescope-osd-bridge'),
          waitForSidebar(),
        ]).then(([m]) => {
          m.openTooltipForPOI(capturedPoiId, app.osd);
        });
      }
    },
  };

  /** Run dynamic map using seed priority: URL param → last session seed → daily */
  async function runDynamicMapWithPriority(): Promise<void> {
    const urlState = (await import("./data_sources/url")).parseURL();
    if (urlState.seed !== undefined && !urlState.dailySeed) {
      // URL has explicit non-daily seed — highest priority
      await runDynamicMap(urlState.seed, false, dynamicOpts);
    } else if (lastSessionSeed !== null) {
      // Restore the last seed the user was viewing
      updateURLWithSeed(lastSessionSeed, lastSessionIsDaily);
      await runDynamicMap(lastSessionSeed, lastSessionIsDaily, dynamicOpts);
    } else {
      // Fall back to daily seed resolution
      await (await import("./dynamic-map")).runDynamicMapFromURL(dynamicOpts);
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
    getSeedParams: () => ({ seed: getCurrentDynamicSeed() ?? undefined, isDaily: getCurrentIsDaily() }),
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
     * Full POI list (no skip-creatures filter applied). Used by the pro
     * Seed Report so creature axes stay populated even with the perf toggle
     * active.
     */
    getAllDynamicPOIs: () => _allDynamicPOIs,
    isSpoilerFree: () => isSpoilerFree(),
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
        const { getCachedGeneration } = await import("./telescope/tile-cache");
        const { getAllPOIsFlat } = await import("./telescope/telescope-osd-bridge");
        const cached = await getCachedGeneration(dailyCacheKey(seed));
        if (cached?.poisByPW) return getAllPOIsFlat({ poisByPW: cached.poisByPW } as any);
        // The comparison target is ALWAYS a daily seed, whose POIs are already
        // baked + served as generation.json by the CI pipeline. Fetch them
        // directly (instant) instead of regenerating client-side. Try today's
        // and yesterday's worker origins; fetchBakedGeneration validates the
        // seed, so a mismatch just falls through.
        const { fetchBakedGeneration } = await import("./telescope/baked-generation");
        const { isLightMode } = await import("./light-mode");
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
    getWandIconUrl: async (sprite: string): Promise<string | null> => {
      try {
        const { getPOISpriteFirstFrame } = await import("./telescope/telescope-osd-bridge");
        return await getPOISpriteFirstFrame({ type: "wand", sprite });
      } catch (e) {
        console.warn("[Noitamap] getWandIconUrl failed:", e);
        return null;
      }
    },
    setHighValuePredicate: (pred: ((poi: any) => boolean) | null) => {
      import("./telescope/telescope-osd-bridge").then(({ applyHighValueOverlays }) => {
        applyHighValueOverlays(pred);
      });
    },
    openPOIById: (poiId: string, opts?: { sidebarRightPx?: number }) => {
      import("./telescope/telescope-osd-bridge").then((m) => {
        m.openTooltipForPOI(poiId, app.osd, opts);
      });
    },
    showGetProModal: () => {
      AuthUI.showGetProModal();
    },
  };
  window.__noitamap = proHooks;

  // Function to load pro bundle
  const loadProBundle = async (): Promise<boolean> => {
    // If already loaded, return true
    if ((window as any).noitamap_pro_loaded) return true;

    try {
      const proUrl = "https://noitamap-pro.acidflow.stream/pro.js";
      let proModule;
      // @ts-ignore
      if (import.meta.env.DEV) {
        // @ts-ignore
        proModule = await import("../../noitamap-pro/src/pro-entry.ts");
      } else {
        const response = await fetch(proUrl);

        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}`);
        }

        const code = await response.text();
        const blob = new Blob([code], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);

        proModule = await import(
          // @ts-ignore — remote ES module loaded at runtime
          /* @vite-ignore */ blobUrl
        );

        URL.revokeObjectURL(blobUrl);
      }

      await proModule.init(proHooks);
      (window as any).noitamap_pro_loaded = true;
      console.log("[Noitamap] Pro features loaded.");
      return true;
    } catch (error) {
      console.error("[Noitamap] Failed to load pro features:", error);
      return false;
    }
  };

  // Expose a pro-load requester so non-pro search components (AP/LC buttons)
  // can trigger pro loading after an auth check.
  (proHooks as any).requestProLoad = loadProBundle;

  // Initialize Drawing UI (Brush Button)
  // This handles the "Get Pro" modal for unauthed users and loads the pro bundle for subscribers
  new DrawingUI(authContainer, {
    onEnableDrawing: loadProBundle,
  });

  // Seed Report toggle button — sits next to the drawing toggle.
  // Auto-loads the pro bundle on first click.
  {
    const drawingWrap = document.getElementById("drawing-ui-wrapper");
    if (drawingWrap) {
      createSeedReportButton(drawingWrap, { loadProBundle });
    }
  }

  // Initialize Drop Overlay
  setupDropOverlay(i18next, loadProBundle);

  // Dynamically load the pro bundle when URL requests sidebar (auth check handled inside pro bundle)
  if ((isDev && localStorage.getItem("noitamap-dev-drawing") === "1") || urlState.sidebarOpen) {
    loadProBundle();
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
        import("./telescope/telescope-osd-bridge").then((m) => {
          m.openTooltipForPOI(poiId, app.osd, {
            fallbackX: result.x,
            fallbackY: result.y,
            fallbackPoi: result,
          });
        });
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

    // Show/hide dynamic toolbar on map change
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

    // Include seed params when on dynamic map so shared link reproduces the same map
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
        // Restore defaults: visible, idle opacity, no filter.
        el.style.display = '';
        svgPaths.forEach((p) => {
          p.style.fillOpacity = '0.3';
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
  // Baked seeds flatten wand/spell/item identities into the DZI pixels, so
  // spoiler-free cannot strip them — disable the toggle and explain why in
  // the popover. Event fired by dynamic-map.ts whenever the baked state of
  // the current view changes.
  window.addEventListener("bakedSeedChange", ((e: CustomEvent) => {
    const label = document.querySelector<HTMLElement>('label[for="spoilerFreeToggle"]');
    if (!spoilerFreeToggle || !label) return;
    const baked = !!e.detail?.baked;
    spoilerFreeToggle.disabled = baked;
    // Bootstrap's .btn-check:disabled + .btn sets pointer-events: none, which
    // would also kill the hover popover that explains the disabling. Restore.
    label.style.pointerEvents = baked ? "auto" : "";
    const contentKey = baked ? "spoilerFree.unavailableDaily" : "spoilerFree.content";
    label.setAttribute("data-i18n-content", contentKey);
    label.setAttribute("data-bs-content", i18next.t(contentKey));
    const existing = bootstrap.Popover.getInstance(label);
    if (existing) existing.dispose();
    new bootstrap.Popover(label);
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

  initKonamiCode();

  // After the page is up, preload every supported language's translation
  // bundle in the background so language switches are instant. The user's
  // active language is already loaded by the i18next init above; we kick off
  // the rest from an idle callback so it doesn't compete with map rendering.
  const preloadAllLocales = () => {
    const all = Object.keys(SUPPORTED_LANGUAGES);
    const loaded = (i18next.languages as string[] | undefined) ?? [i18next.language];
    const toLoad = all.filter((lng) => !loaded.includes(lng));
    if (toLoad.length === 0) return;
    i18next
      .loadLanguages(toLoad)
      .catch((err) => console.warn("[Noitamap] Preload of locales failed:", err));
  };
  const idle = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (typeof idle === "function") {
    idle(preloadAllLocales, { timeout: 5000 });
  } else {
    setTimeout(preloadAllLocales, 2000);
  }
});
