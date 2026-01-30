import i18next, { SUPPORTED_LANGUAGES } from './i18n';
import { App } from './app';
import {
  parseURL,
  updateURL,
  getEnabledOverlays,
  updateURLWithOverlays,
  updateURLWithDrawing,
  updateURLWithSidebar,
} from './data_sources/url';
import { asOverlayKey, showOverlay, selectSpell, OverlayKey } from './data_sources/overlays';
import { UnifiedSearch } from './search/unifiedsearch';
import { asMapName } from './data_sources/tile_data';
import { addEventListenerForId, assertElementById, debounce } from './util';
import { createMapLinks, NAV_LINK_IDENTIFIER } from './nav';
import { initMouseTracker } from './mouse_tracker';
import { isRenderer, getStoredRenderer, setStoredRenderer } from './renderer_settings';
import { createLanguageSelector } from './language-selector';
import { updateTranslations } from './i18n-dom';
import { initKonamiCode } from './konami';
import { AuthUI } from './auth/auth-ui';
import { DrawingSidebar } from './drawing/sidebar';
import { createDrawingManager, DrawingManager } from './drawing/doodle-integration';
import { DrawingSession } from './drawing/storage';
import { decodeShapesFromUrl, encodeShapesWithInfo } from './drawing/url-encoder';
import { captureScreenshot } from './drawing/screenshot';

// Global reference to unified search for translation updates
let globalUnifiedSearch: UnifiedSearch | null = null;

// Global references for drawing feature
let globalDrawingManager: DrawingManager | null = null;
let globalDrawingSession: DrawingSession | null = null;
let globalDrawingSidebar: DrawingSidebar | null = null;

// Dev console commands (only on dev.noitamap.com, localhost, or file://)
const isDev = window.location.hostname === 'dev.noitamap.com'
  || window.location.hostname === 'localhost'
  || window.location.protocol === 'file:';
if (isDev) {
  (window as any).noitamap = {
    enableDrawing: () => {
      localStorage.setItem('noitamap-dev-drawing', '1');
      console.log('Drawing dev mode enabled. Refresh and open the sidebar.');
    },
    disableDrawing: () => {
      localStorage.removeItem('noitamap-dev-drawing');
      console.log('Drawing dev mode disabled. Refresh to see changes.');
    },
  };
}

// Export function to refresh search translations
export const refreshSearchTranslations = () => {
  if (globalUnifiedSearch) {
    globalUnifiedSearch.refreshTranslations();
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await i18next.init({
      fallbackLng: 'en',
      debug: false,
      detection: {
        order: ['querystring', 'cookie', 'localStorage', 'sessionStorage', 'navigator', 'htmlTag'],
        lookupQuerystring: 'lng',
        lookupCookie: 'i18next',
        lookupLocalStorage: 'i18nextLng',
        lookupSessionStorage: 'i18nextLng',
        caches: ['localStorage', 'cookie'],
      },
      backend: {
        loadPath: './locales/{{lng}}/translation.json',
        requestOptions: {
          cache: 'no-store',
        },
      },
      interpolation: {
        escapeValue: false,
      },
      supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
      load: 'languageOnly',
      cleanCode: true,
      nonExplicitSupportedLngs: true,
    });

    createLanguageSelector();
    updateTranslations();
  } catch (error) {
    console.error('i18next initialization failed:', error);
  }

  // TODO: probably most of this should be part of the "App" class, or the "App" class should be removed.
  // i'm not sure i'm happy with the abstraction

  const navbarBrandElement = assertElementById('navbar-brand', HTMLElement);
  const osdRootElement = assertElementById('osContainer', HTMLElement);
  const searchForm = assertElementById('search-form', HTMLFormElement);
  const overlayButtonsElement = assertElementById('overlay-selector', HTMLDivElement);
  const mapSelectorButton = assertElementById('mapSelectorButton', HTMLButtonElement);
  const tooltipElement = assertElementById('coordinate', HTMLElement);
  const coordinatesText = tooltipElement.innerText;
  const rendererForm = assertElementById('renderer-form', HTMLFormElement);

  // Initialize renderer from storage
  const storedRenderer = getStoredRenderer();
  rendererForm.elements['renderer'].value = storedRenderer;

  // Parse URL state including overlays and drawing
  const urlState = parseURL();

  const app = await App.create({
    mountTo: osdRootElement,
    overlayButtons: overlayButtonsElement,
    initialState: urlState,
    useWebGL: storedRenderer === 'webgl',
  });

  const initialMapName = app.getMap();

  // Apply overlays from URL
  if (urlState.overlays && urlState.overlays.length > 0) {
    for (const overlayKey of urlState.overlays) {
      const toggler = document.querySelector(
        `input.overlayToggler[data-overlay-key="${overlayKey}"]`
      ) as HTMLInputElement | null;
      if (toggler && !toggler.disabled) {
        toggler.checked = true;
        showOverlay(overlayKey, true);
      }
    }
  }

  // Initialize auth UI in navbar (before the donate button)
  const authContainer = document.createElement('div');
  authContainer.id = 'auth-container';
  const donoButton = document.querySelector('.bg-glow');
  if (donoButton && donoButton.parentElement) {
    donoButton.parentElement.insertBefore(authContainer, donoButton);
  }
  new AuthUI(authContainer);

  // Initialize drawing feature
  let drawingManager: DrawingManager | null = null;
  let drawingSession: DrawingSession | null = null;
  let drawingSidebar: DrawingSidebar | null = null;
  let drawToggleCheckbox: HTMLInputElement | null = null;

  try {
    // Create drawing session first (needed for the callback)
    drawingSession = new DrawingSession(initialMapName, {
      onSave: drawing => {
        // Encode shapes and update URL when auto-saved
        if (!drawing) return;
        const result = encodeShapesWithInfo(drawing.shapes);
        if (result) {
          updateURLWithDrawing(result.encoded);
          // Warn user if drawing was significantly simplified for URL
          if (result.simplified) {
            window.dispatchEvent(new CustomEvent('drawing-simplified'));
          }
        }
      },
    });
    globalDrawingSession = drawingSession;

    // Create drawing manager with shape change callback for auto-save
    drawingManager = await createDrawingManager(app.osd, {
      onShapeChange: () => {
        if (!drawingManager || !drawingSession) return;
        const shapes = drawingManager.getShapes();
        const viewport = app.osd.viewport;
        const center = viewport.getCenter();
        const zoom = viewport.getZoom();
        drawingSession.updateShapes(shapes, {
          x: center.x,
          y: center.y,
          zoom: zoom,
        });
      },
    });
    globalDrawingManager = drawingManager;

    // Get sidebar container
    const sidebarContainer = document.getElementById('drawing-sidebar-container');
    if (sidebarContainer) {
      // Create draw toggle button first (using btn-check pattern like overlay buttons)
      const drawToggleWrapper = document.createElement('div');
      drawToggleWrapper.className = 'btn-group me-2';
      drawToggleWrapper.innerHTML = `
        <input type="checkbox" class="btn-check" id="drawToggleBtn" autocomplete="off">
        <label class="icon-button btn btn-sm btn-outline-light text-nowrap" for="drawToggleBtn"
          data-bs-toggle="popover" data-bs-placement="top" data-bs-trigger="hover focus"
          data-i18n-title="drawing.toggle.title" data-bs-title="${i18next.t('drawing.toggle.title')}"
          data-i18n-content="drawing.toggle.content" data-bs-content="${i18next.t('drawing.toggle.content')}">
          <i class="bi bi-brush"></i>
        </label>
      `;

      // Insert before the auth container
      const authCont = document.getElementById('auth-container');
      if (authCont && authCont.parentElement) {
        authCont.parentElement.insertBefore(drawToggleWrapper, authCont);
      }

      drawToggleCheckbox = drawToggleWrapper.querySelector('#drawToggleBtn') as HTMLInputElement;
      const drawToggleLabel = drawToggleWrapper.querySelector('label') as HTMLLabelElement;

      // Initialize popover for the label
      new bootstrap.Popover(drawToggleLabel);

      // Initialize sidebar
      drawingSidebar = new DrawingSidebar(sidebarContainer, {
        drawingManager,
        session: drawingSession,
        onScreenshot: async () => {
          const shapes = drawingManager?.getShapes() ?? [];
          const strokeWidth = drawingManager?.getStrokeWidth() ?? 5;
          // Get viewport info for coordinate transformation
          const viewport = app.osd.viewport;
          const containerSize = viewport.getContainerSize();
          // Create a conversion function using OpenSeadragon's coordinate system
          const worldToPixel = (x: number, y: number) => {
            const point = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x, y));
            return { x: point.x, y: point.y };
          };
          // Get map bounds in viewport coordinates for cropping
          const mapBoundsRect = app.osd.getCombinedItemsRect();
          const boundsTopLeft = viewport.viewportToViewerElementCoordinates(
            new OpenSeadragon.Point(mapBoundsRect.x, mapBoundsRect.y)
          );
          const boundsBottomRight = viewport.viewportToViewerElementCoordinates(
            new OpenSeadragon.Point(mapBoundsRect.x + mapBoundsRect.width, mapBoundsRect.y + mapBoundsRect.height)
          );
          const viewportInfo = {
            containerSize: { x: containerSize.x, y: containerSize.y },
            worldToPixel,
            mapBounds: {
              left: boundsTopLeft.x,
              top: boundsTopLeft.y,
              right: boundsBottomRight.x,
              bottom: boundsBottomRight.y,
            },
          };
          await captureScreenshot(osdRootElement, null, app.getMap(), shapes, viewportInfo, strokeWidth);
        },
        onSave: async () => {
          // Encode shapes and update URL
          const shapes = drawingManager?.getShapes() ?? [];
          const result = encodeShapesWithInfo(shapes);
          if (result) {
            updateURLWithDrawing(result.encoded);
          }
        },
        onClose: () => {
          // Sync toggle checkbox when sidebar closed via X button
          drawToggleCheckbox.checked = false;
          updateURLWithSidebar(false);
        },
        onMapChange: async (mapName: string) => {
          // Switch to the requested map
          const validMapName = asMapName(mapName);
          if (validMapName) {
            await app.setMap(validMapName);
            unifiedSearch.currentMap = validMapName;
          }
        },
      });
      globalDrawingSidebar = drawingSidebar;

      // Toggle sidebar on checkbox change
      drawToggleCheckbox.addEventListener('change', () => {
        if (drawToggleCheckbox.checked) {
          drawingSidebar?.open();
          updateURLWithSidebar(true);
        } else {
          drawingSidebar?.close();
          updateURLWithSidebar(false);
        }
      });

      // Restore sidebar state from URL
      if (urlState.sidebarOpen) {
        drawToggleCheckbox.checked = true;
        drawingSidebar?.open();
      }
    }

    // Load drawing from URL if present
    if (urlState.drawing && drawingManager) {
      const shapes = decodeShapesFromUrl(urlState.drawing);
      if (shapes && shapes.length > 0) {
        drawingManager.loadShapes(shapes);
      }
    }
  } catch (error) {
    console.error('Failed to initialize drawing feature:', error);
  }

  navbarBrandElement.addEventListener('click', ev => {
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

  // link to the app
  unifiedSearch.on('selected', (result: any) => {
    if (result.type === 'spell') {
      // Fill the search box with the spell name without triggering new search
      unifiedSearch.setSearchValueWithoutTriggering(result.spell.name);
      // Hide the search overlay
      const overlay = document.getElementById('unifiedSearchResultsOverlay');
      if (overlay) {
        overlay.style.display = 'none';
      }
      // Trigger overlays for the selected spell
      selectSpell(result.spell, app);
    } else {
      app.goto(result);
    }
  });

  const debouncedUpdateURL = debounce(100, updateURL);
  app.on('state-change', state => {
    // record map / position / zoom changes to the URL when they happen
    debouncedUpdateURL(state);

    const currentMapLink = document.querySelector(`#navLinksList [data-map-key='${state.map}']`);

    if (!(currentMapLink instanceof HTMLElement)) return;

    // Remove "active" class from any nav links that still have it
    document.querySelectorAll('#navLinksList .nav-link.active').forEach(el => {
      el.classList.remove('active');
    });

    // Add "active" class to the nav-link identified by `mapName`
    currentMapLink.classList.add('active');
  });

  const loadingIndicator = assertElementById('loadingIndicator', HTMLElement);
  // show/hide loading indicator
  app.on('loading-change', isLoading => {
    loadingIndicator.style.display = isLoading ? 'block' : 'none';
  });

  // respond to changes of map
  const mapLinksUL = createMapLinks();
  mapLinksUL.addEventListener('click', ev => {
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

    // Reset drawing when changing maps (drawings are per-map)
    if (drawingSidebar?.isOpened()) {
      drawingSidebar.close();
    }
    if (drawToggleCheckbox) {
      drawToggleCheckbox.checked = false;
    }
    if (drawingManager) {
      drawingManager.clearShapes();
    }
    if (drawingSession) {
      drawingSession.setMap(mapName);
    }
    // Clear drawing from URL
    updateURLWithDrawing(null);
    updateURLWithSidebar(false);

    // load the new map
    app.setMap(mapName);
    // set which map we're searching
    unifiedSearch.currentMap = mapName;
  });

  // manage css classes to show / hide overlays
  addEventListenerForId('overlay-selector', 'click', ev => {
    const target = ev.target;

    // not an input element
    if (!(target instanceof HTMLInputElement)) return;

    // not a checkbox
    if (target.getAttribute('type') !== 'checkbox') return;

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

  // share button with toast notification
  const shareEl = assertElementById('shareButton', HTMLElement);
  shareEl.addEventListener('click', ev => {
    ev.preventDefault();

    // Build URL with current state including overlays and drawing
    const url = new URL(window.location.href);

    // Add overlays to URL
    const overlays = getEnabledOverlays();
    if (overlays.length > 0) {
      url.searchParams.set('overlays', overlays.join(','));
    } else {
      url.searchParams.delete('overlays');
    }

    // Add drawing to URL if present
    if (drawingManager) {
      const shapes = drawingManager.getShapes();
      if (shapes.length > 0) {
        const result = encodeShapesWithInfo(shapes);
        if (result) {
          url.searchParams.set('drawing', result.encoded);
        }
      } else {
        url.searchParams.delete('drawing');
      }
    }

    window.navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        // Update toast text with translation
        const toastElement = assertElementById('shareToast', HTMLElement);
        const toastBody = toastElement.querySelector('.toast-body');
        if (toastBody) {
          toastBody.innerHTML = `<i class="bi bi-check-circle me-2"></i>${i18next.t('share.copied')}`;
        }
        const toast = new bootstrap.Toast(toastElement, {
          autohide: true,
          delay: 2000,
        });
        toast.show();
      })
      .catch(err => {
        console.error('Failed to copy to clipboard:', err);
      });
  });

  // Mouse tracker for displaying coordinates
  const { copyCoordinates } = initMouseTracker({
    osd: app.osd,
    osdElement: osdRootElement,
    tooltipElement: assertElementById('coordinate', HTMLElement),
  });
  document.addEventListener('keydown', copyCoordinates, { capture: false });

  // Uncomment and implement annotations if needed
  // drawingToggleSwitch.addEventListener("change", (event) => {
  //   if (event.currentTarget.checked && os.areAnnotationsActive() == false) {
  //     os.initializeAnnotations();
  //     console.log("checked");
  //   } else {
  //     os.shutdownAnnotations();
  //     console.log("not checked");
  //   }
  // });

  // Handle renderer changes
  rendererForm.addEventListener('change', ev => {
    if (!ev.target.matches('input[type="radio"][name="renderer"]')) return;

    ev.stopPropagation();
    const newRenderer = rendererForm.elements['renderer'].value;

    if (isRenderer(newRenderer)) {
      setStoredRenderer(newRenderer);
      window.location.reload();
    }
  });
  initKonamiCode();
});
