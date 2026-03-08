import i18next, { SUPPORTED_LANGUAGES } from "./i18n";
import { setupDropOverlay } from "./drop-overlay";
import { createDynamicUI, updateDynamicUIVisibility, setDynamicUISeed } from "./dynamic_ui";
import {
  runDynamicMapFromURL,
  runDynamicMap,
  clearDynamicMap,
  getCurrentDynamicSeed,
  getCurrentIsDaily,
  getLastGenerationResult,
} from "./dynamic-map";
import type { DynamicPOI } from "./dynamic-map";

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
  updateURLWithCanvas,
} from "./data_sources/url";
import { asOverlayKey, showOverlay, selectSpell, OverlayKey } from "./data_sources/overlays";
import { overlayToShort } from "./data_sources/param-mappings";
import { UnifiedSearch } from "./search/unifiedsearch";
import { asMapName, MapName } from "./data_sources/tile_data";
import { addEventListenerForId, assertElementById, debounce } from "./util";
import { createMapLinks, NAV_LINK_IDENTIFIER } from "./nav";
import { initMouseTracker } from "./mouse_tracker";
import { isRenderer, getStoredRenderer, setStoredRenderer } from "./renderer_settings";
import { createLanguageSelector } from "./language-selector";
import { updateTranslations } from "./i18n-dom";
import { initKonamiCode } from "./konami";
import { AuthUI } from "./auth/auth-ui";
import { authService } from "./auth/auth-service";
import { DrawingUI } from "./drawing/drawing-ui";

// Global reference to unified search for translation updates
let globalUnifiedSearch: UnifiedSearch | null = null;

let globalApp: App | null = null;

// Map-change callbacks registered by the pro bundle via onMapChange hook
const mapChangeCallbacks: Array<(mapName: string) => void> = [];

// Reference to unified search so the pro hook can update it
let _unifiedSearch: UnifiedSearch | null = null;

// Export function to refresh search translations
export const refreshSearchTranslations = () => {
  if (globalUnifiedSearch) {
    globalUnifiedSearch.refreshTranslations();
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  // Start preloading the atlas for search results immediately
  import("./telescope/poi-spatial-index").then(m => m.loadSpritesheetAndAtlas()).catch(e => console.warn("[Noitamap] Atlas preload failed:", e));

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

  // Handle map loading progress UI (two-segment bar)
  const _getLoadingOverlay = () => document.getElementById("map-loading-overlay");
  const _getDownloadBar = () => document.getElementById("loading-bar-download") as HTMLElement | null;
  const _getGenerationBar = () => document.getElementById("loading-bar-generation") as HTMLElement | null;
  const _getItemsBar = () => document.getElementById("loading-bar-items") as HTMLElement | null;
  const _getStatusText = () => document.getElementById("map-loading-status");
  const _getTitle = () => document.getElementById("map-loading-title");
  const _getSubtitle = () => document.getElementById("map-loading-subtitle");

  window.addEventListener("dataZipProgress", ((e: CustomEvent) => {
    const overlay = _getLoadingOverlay();
    const bar = _getDownloadBar();
    const status = _getStatusText();
    const title = _getTitle();
    if (!overlay || !bar) return;

    // Always show the overlay when loading starts
    overlay.style.display = "flex";

    if (e.detail.percentage < 100) {
      // Segment 1 fills left third (0–33.3% total)
      bar.style.width = `${e.detail.percentage}%`;
      bar.setAttribute("aria-valuenow", e.detail.percentage.toString());
      if (title) title.setAttribute("data-i18n", "loading.mapData.downloading");
      if (status) status.textContent = `${Math.round(e.detail.percentage / 3)}%`;
    } else {
      // Download done – keep bar at max and switch title to generation phase
      bar.style.width = "100%";
      if (title) title.setAttribute("data-i18n", "loading.mapData.generating");
      if (title)
        title.textContent = i18next.isInitialized ? i18next.t("loading.mapData.generating") : "Generating Biomes";
      const subtitle = _getSubtitle();
      if (subtitle) subtitle.style.display = "none";
      if (status) status.textContent = "33%";
    }
  }) as EventListener);

  window.addEventListener("biomeGenerationProgress", ((e: CustomEvent) => {
    const overlay = _getLoadingOverlay();
    const bar = _getGenerationBar();
    const status = _getStatusText();
    if (!overlay || !bar) return;

    overlay.style.display = "flex";
    bar.style.width = `${e.detail.percentage}%`;
    bar.setAttribute("aria-valuenow", e.detail.percentage.toString());
    if (status) status.textContent = `${Math.round(33 + e.detail.percentage / 3)}%`;        

    if (e.detail.percentage >= 100) {
      const title = _getTitle();
      if (title) {
        title.removeAttribute("data-i18n");
        title.textContent = "Adding items and wands to the map";
      }
      bar.style.width = "100%";
      if (status) status.textContent = "66%";
    }
  }) as EventListener);

  window.addEventListener("itemsGenerationProgress", ((e: CustomEvent) => {
    const overlay = _getLoadingOverlay();
    const bar = _getItemsBar();
    const status = _getStatusText();
    if (!overlay || !bar) return;

    overlay.style.display = "flex";
    bar.style.width = `${e.detail.percentage}%`;
    bar.setAttribute("aria-valuenow", e.detail.percentage.toString());
    if (status) status.textContent = `${Math.round(66 + e.detail.percentage / 3)}%`;        

    if (e.detail.percentage >= 100) {
      const overlay = _getLoadingOverlay();
      if (overlay) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const o = _getLoadingOverlay();
            if (o) o.style.display = "none";
            // Reset all bars for the next generation
            const dl = _getDownloadBar();
            const gen = _getGenerationBar();
            const it = _getItemsBar();
            if (dl) dl.style.width = "0%";
            if (gen) gen.style.width = "0%";
            if (it) it.style.width = "0%";
            const subtitle = _getSubtitle();
            if (subtitle) subtitle.style.display = "";
          });
        });
      }
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
  });

  // Store global reference for translation updates
  globalUnifiedSearch = unifiedSearch;
  _unifiedSearch = unifiedSearch;

  // ── Dynamic map setup ─────────────────────────────────────────────────────
  const dynamicOpts = {
    viewer: app.osd,
    onLoadingChange: (isLoading: boolean) => {
      loadingIndicator.style.display = isLoading ? "block" : "none";
    },
    onSeedResolved: (seed: number, isDaily: boolean) => {
      setDynamicUISeed(seed, isDaily);
    },
    onPOIsReady: (pois: DynamicPOI[]) => {
      unifiedSearch.setDynamicPOIs(pois);
    },
  };

  createDynamicUI(dynamicOpts);
  updateDynamicUIVisibility(app.getMap());

  // Auto-start generation if landing on dynamic map
  if (app.getMap() === "dynamic-main-branch") {
    runDynamicMapFromURL(dynamicOpts).catch((e) => console.error("[Noitamap] Dynamic map init failed:", e));
  }

  // Expose hooks for the pro bundle via window.__noitamap
  const proHooks: NoitamapProHooks = {
    i18next,
    authService,
    osd: app.osd,
    osdElement: osdRootElement,
    getMap: () => app.getMap(),
    setMap: (mapName: string) => app.setMap(asMapName(mapName) ?? (mapName as any)),
    updateURLWithSidebar,
    urlState: { sidebarOpen: urlState.sidebarOpen, canvas: urlState.canvas },
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
  };
  window.__noitamap = proHooks;

  // Function to load pro bundle
  const loadProBundle = async (): Promise<boolean> => {
    // If already loaded, return true
    if ((window as any).noitamap_pro_loaded) return true;

    try {
      const proUrl = "https://noitamap-pro.acidflow.stream/pro.js";
      console.log("[Noitamap] Fetching pro features...");

      const response = await fetch(proUrl);

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const code = await response.text();
      const blob = new Blob([code], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);

      const proModule = await import(
        // @ts-ignore â€” remote ES module loaded at runtime
        /* @vite-ignore */ blobUrl
      );

      URL.revokeObjectURL(blobUrl);

      await proModule.init(proHooks);
      (window as any).noitamap_pro_loaded = true;
      console.log("[Noitamap] Pro features loaded.");
      return true;
    } catch (error) {
      console.error("[Noitamap] Failed to load pro features:", error);
      return false;
    }
  };

  // Initialize Drawing UI (Brush Button)
  // This handles the "Get Pro" modal for unauthed users and loads the pro bundle for subscribers
  new DrawingUI(authContainer, {
    onEnableDrawing: loadProBundle,
  });

  // Initialize Drop Overlay
  setupDropOverlay(i18next, loadProBundle);

  // Dynamically load the pro bundle when drawing is enabled (legacy check) OR if URL requests sidebar
  if (localStorage.getItem("noitamap-dev-drawing") === "1" || urlState.sidebarOpen) {
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
      app.goto(result);
    }
  });

  const debouncedUpdateURL = debounce(100, updateURL);
  const debouncedViewportNotify = debounce(300, () => unifiedSearch.notifyViewportChanged());

  // Pause search sorting during active interaction to keep map navigation smooth
  app.osd.addHandler("canvas-drag", () => unifiedSearch.setInteracting(true));
  app.osd.addHandler("canvas-scroll", () => unifiedSearch.setInteracting(true));
  app.osd.addHandler("canvas-drag-end", () => unifiedSearch.setInteracting(false));
  app.osd.addHandler("animation-finish", () => unifiedSearch.setInteracting(false));

  app.on("state-change", (state) => {
    // record map / position / zoom changes to the URL when they happen
    debouncedUpdateURL(state);
    // Re-sort search results by proximity to the new viewport position
    debouncedViewportNotify();

    const currentMapLink = document.querySelector(`#navLinksList [data-map-key='${state.map}']`);

    if (!(currentMapLink instanceof HTMLElement)) return;

    // Remove "active" class from any nav links that still have it
    document.querySelectorAll("#navLinksList .nav-link.active").forEach((el) => {
      el.classList.remove("active");
    });

    // Add "active" class to the nav-link identified by `mapName`
    currentMapLink.classList.add("active");
  });

  const loadingIndicator = assertElementById("loadingIndicator", HTMLElement);
  // show/hide loading indicator
  app.on("loading-change", (isLoading) => {
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

    // Switching AWAY from dynamic → clear overlays and POI index
    if (app.getMap() === "dynamic-main-branch" && mapName !== "dynamic-main-branch") {
      clearDynamicMap(app.osd);
      unifiedSearch.setDynamicPOIs([]);
    }

    // load the new map
    app.setMap(mapName);
    // set which map we're searching
    unifiedSearch.currentMap = mapName;

    // Show/hide dynamic toolbar
    updateDynamicUIVisibility(mapName);

    // Switching TO dynamic → start generation
    if (mapName === "dynamic-main-branch") {
      runDynamicMapFromURL(dynamicOpts).catch((e) => console.error("[Noitamap] Dynamic map switch failed:", e));
    }
  });

  // manage css classes to show / hide overlays
  addEventListenerForId("overlay-selector", "click", (ev) => {
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
  });

  // Initialize Bootstrap popovers
  for (const el of document.querySelectorAll('[data-bs-toggle="popover"]')) {
    new bootstrap.Popover(el);
  }
  // Initialize Bootstrap tooltips
  for (const el of document.querySelectorAll('[data-bs-toggle="tooltip"]')) {
    new bootstrap.Tooltip(el);
  }

  // share button with toast notification (simple URL copy â€” pro bundle patches this for drawing share)
  const shareEl = assertElementById("shareButton", HTMLElement);
  shareEl.addEventListener("click", async (ev) => {
    ev.preventDefault();

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

    const finalUrl = url.toString();

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
  initKonamiCode();
});
