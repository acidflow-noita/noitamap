import i18next, { SUPPORTED_LANGUAGES } from "./i18n";
import { setupDropOverlay } from "./drop-overlay";

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
  };
  console.log('[Noitamap] Dev mode detected, "noitamap" commands available.');
}

import { App } from "./app";
import {
  parseURL,
  updateURL,
  getEnabledOverlays,
  updateURLWithOverlays,
  updateURLWithSidebar,
} from "./data_sources/url";
import { asOverlayKey, showOverlay, selectSpell, OverlayKey } from "./data_sources/overlays";
import { overlayToShort } from "./data_sources/param-mappings";
import { UnifiedSearch } from "./search/unifiedsearch";
import { asMapName } from "./data_sources/tile_data";
import { addEventListenerForId, assertElementById, debounce } from "./util";
import { createMapLinks, NAV_LINK_IDENTIFIER } from "./nav";
import { initMouseTracker } from "./mouse_tracker";
import { isRenderer, getStoredRenderer, setStoredRenderer } from "./renderer_settings";
import { createLanguageSelector } from "./language-selector";
import { updateTranslations } from "./i18n-dom";
import { initKonamiCode } from "./konami";
import { AuthUI } from "./auth/auth-ui";
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
  rendererForm.elements["renderer"].value = storedRenderer;

  // Parse URL state including overlays and drawing
  const urlState = parseURL();

  const app = await App.create({
    mountTo: osdRootElement,
    overlayButtons: overlayButtonsElement,
    initialState: urlState,
    useWebGL: storedRenderer === "webgl",
  });
  globalApp = app;
  console.log(`[Noitamap] Active OSD drawer: ${(app.osd as any).drawer?.getType?.() ?? storedRenderer}`);

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

  // Expose hooks for the pro bundle via window.__noitamap
  const proHooks: NoitamapProHooks = {
    i18next,
    osd: app.osd,
    osdElement: osdRootElement,
    getMap: () => app.getMap(),
    setMap: (mapName: string) => app.setMap(asMapName(mapName) ?? (mapName as any)),
    updateURLWithSidebar,
    urlState: { sidebarOpen: urlState.sidebarOpen },
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
  app.on("state-change", (state) => {
    // record map / position / zoom changes to the URL when they happen
    debouncedUpdateURL(state);

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

    // jQuery isn't in scope, so we can't manually hide the toggle after
    // the user clicks an item. let the event bubble so Bootstrap can close
    // the dropdown after a click
    // ev.stopPropagation();

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
