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
import { overlayToShort } from './data_sources/param-mappings';
import { UnifiedSearch } from './search/unifiedsearch';
// DISABLED: Simplification preview no longer needed - drawings are shared via catbox.moe image upload
// import {
//   createSimplificationPreview,
//   createSimplificationSlider,
//   type SimplificationPreview,
// } from './drawing/simplification-preview';
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
// DISABLED: URL encoding no longer needed - drawings are shared via catbox.moe image upload
import { decodeShapesFromUrl, encodeShapesWithInfo } from './drawing/url-encoder';
import { captureScreenshot, downloadBlob, screenshotFilename, extractDrawingData } from './drawing/screenshot';
import { uploadToCatbox, fetchFromCatbox, isCatboxRef, extractCatboxFileId, createCatboxParam } from './drawing/catbox';
import { shortenUrl } from './drawing/link-shortener';

// Global reference to unified search for translation updates
let globalUnifiedSearch: UnifiedSearch | null = null;

// Global references for drawing feature
let globalDrawingManager: DrawingManager | null = null;
let globalDrawingSession: DrawingSession | null = null;
let globalDrawingSidebar: DrawingSidebar | null = null;

// DISABLED: Simplification preview no longer needed
// let globalSimplificationPreview: SimplificationPreview | null = null;
// let globalSimplificationStatusUpdate: (() => void) | null = null;
let globalApp: App | null = null;

// Dev console commands (only on dev.noitamap.com, localhost, or file://)
const isDev =
  window.location.hostname === 'dev.noitamap.com' ||
  window.location.hostname === 'localhost' ||
  window.location.protocol === 'file:';
if (isDev) {
  (window as any).noitamap = {
    enableDrawing: () => {
      localStorage.setItem('noitamap-dev-drawing', '1');
      console.log('Drawing dev mode enabled. Refresh and open the sidebar.');
    },
    disableDrawing: () => {
      localStorage.removeItem('noitamap-dev-drawing');
      console.log('Drawing dev mode disabled. Refresh to hide the sidebar.');
    },
    // DISABLED: Simplification preview no longer needed - drawings are shared via catbox.moe
    // enableSimplificationPreview: () => { ... },
    // disableSimplificationPreview: () => { ... },
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
  globalApp = app;

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

  // Initialize auth UI in navbar (at the end of the button container)
  const authContainer = document.createElement('div');
  authContainer.id = 'auth-container';
  // Find the container div that holds all the buttons
  const buttonContainer = document.querySelector('.collapse.navbar-collapse .d-flex.flex-wrap');
  if (buttonContainer) {
    buttonContainer.appendChild(authContainer);
  }
  new AuthUI(authContainer);

  // Initialize drawing feature
  let drawingManager: DrawingManager | null = null;
  let drawingSession: DrawingSession | null = null;
  let drawingSidebar: DrawingSidebar | null = null;
  let drawToggleCheckbox: HTMLInputElement | null = null;
  let isDrawLoading = false; // Flag to prevent URL updates during loading

  try {
    // Create drawing session first (needed for the callback)
    drawingSession = new DrawingSession(initialMapName, {
      // DISABLED: URL encoding of drawings no longer needed - sharing via catbox.moe image upload
      onSave: drawing => {
        if (!drawing || isDrawLoading) return;
        // Encode drawing to URL for local state visibility
        const mapName = drawingSession?.getMapName() ?? '';
        const sw = drawingManager?.getStrokeWidth() ?? 5;
        const result = encodeShapesWithInfo(drawing.shapes, undefined, mapName, sw);
        if (result) {
          updateURLWithDrawing(result.encoded);
        }
      },
    });
    globalDrawingSession = drawingSession;

    // Create drawing manager with shape change callback for auto-save
    drawingManager = await createDrawingManager(app.osd, {
      onShapeChange: () => {
        const shapes = drawingManager.getShapes();
        const viewport = app.osd.getZoomPos();
        drawingSession.updateShapes(shapes, viewport);
      },
      onToolChange: (tool) => {
        // drawingSidebar is created later, so check if it exists
        if (drawingSidebar) {
          drawingSidebar.updateSelectedTool(tool);
        }
      },
      onTextSelect: (shape) => {
        // Update sidebar UI to match selected text's properties
        if (drawingSidebar && shape) {
          if (shape.color) {
            drawingSidebar.setColor(shape.color);
          }
          if (shape.fontSize) {
            drawingSidebar.setFontSize(shape.fontSize);
          }
        }
      }
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
          const blob = await captureScreenshot(osdRootElement, null, app.getMap(), shapes, viewportInfo, strokeWidth);
          if (blob) {
            downloadBlob(blob, screenshotFilename(app.getMap()));
          }
        },
        onSave: async () => {
          // DISABLED: URL encoding no longer needed - drawings saved locally and shared via catbox
          // const shapes = drawingManager?.getShapes() ?? [];
          // const result = encodeShapesWithInfo(shapes);
          // if (result) {
          //   updateURLWithDrawing(result.encoded);
          // }
        },
        onNew: () => {
          // Clear drawing from URL when starting new drawing
          updateURLWithDrawing(null);
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

    // Load drawing from catbox.moe if d=cb:{fileId} param present (check FIRST)
    if (urlState.drawing && drawingManager && isCatboxRef(urlState.drawing)) {
      const fileId = extractCatboxFileId(urlState.drawing);
      if (fileId) {
        // Show loading indicator while fetching
        const loadingToastEl = document.getElementById('catboxLoadingToast');
        let loadingToast: bootstrap.Toast | null = null;
        if (loadingToastEl) {
          const body = loadingToastEl.querySelector('.toast-body span');
          if (body) body.textContent = i18next.t('share.downloadingCloud');
          loadingToast = new bootstrap.Toast(loadingToastEl, { autohide: false });
          loadingToast.show();
        }

        const blob = await fetchFromCatbox(fileId);

        // Hide loading indicator
        loadingToast?.hide();

        if (blob) {
          const result = await extractDrawingData(blob);
          if (result && result.shapes.length > 0) {
            // Switch to the correct map if embedded map name differs from current
            if (result.mapName) {
              const validMapName = asMapName(result.mapName);
              if (validMapName && validMapName !== app.getMap()) {
                await app.setMap(validMapName);
                drawingSession.setMap(validMapName);
              }
            }

            isDrawLoading = true;
            drawingManager.loadShapes(result.shapes);
            isDrawLoading = false;
            if (result.strokeWidth) {
              drawingManager.setStrokeWidth(result.strokeWidth);
              drawingSidebar?.setStrokeWidth(result.strokeWidth);
            }

            // Auto-download the WebP as a backup for the user
            const mapName = result.mapName ?? app.getMap();
            const downloadToastEl = document.getElementById('downloadToast');
            let downloadToast: bootstrap.Toast | null = null;
            if (downloadToastEl) {
              const body = downloadToastEl.querySelector('.toast-body');
              if (body) body.innerHTML = `<i class="bi bi-download me-2"></i>${i18next.t('share.downloading')}`;
              downloadToast = new bootstrap.Toast(downloadToastEl, { autohide: false });
              downloadToast.show();
            }
            downloadBlob(blob, screenshotFilename(mapName));
            // Hide toast after a short delay (download initiated)
            setTimeout(() => downloadToast?.hide(), 1500);

            // Auto-open sidebar when loading shared drawing
            if (drawToggleCheckbox && drawingSidebar) {
              drawToggleCheckbox.checked = true;
              drawingSidebar.open();
              drawingSidebar.setCatboxSource(fileId);
              updateURLWithSidebar(true);
            }
          }
        } else {
          // File not found on catbox - show error toast
          showCatboxErrorToast();
        }
      }
    }
    // Load drawing from URL param if present (only if not a catbox ref)
    else if (urlState.drawing && drawingManager) {
      const decoded = decodeShapesFromUrl(urlState.drawing);
      if (decoded && decoded.shapes.length > 0) {
        isDrawLoading = true;
        drawingManager.loadShapes(decoded.shapes);
        isDrawLoading = false;
        // Apply the decoded stroke width to both manager and sidebar UI
        drawingManager.setStrokeWidth(decoded.strokeWidth);
        drawingSidebar?.setStrokeWidth(decoded.strokeWidth);
      }
    }
  } catch (error) {
    console.error('Failed to initialize drawing feature:', error);
  }

  // Drag-and-drop import: accept WebP files dropped anywhere on the page
  {
    let dragCounter = 0;
    const dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.setAttribute('data-text', i18next.t('drawing.import.dropHint', 'Drop WebP file to import drawing'));
    document.body.appendChild(dropOverlay);

    document.body.addEventListener('dragenter', e => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) {
        dragCounter++;
        dropOverlay.classList.add('visible');
      }
    });

    document.body.addEventListener('dragleave', e => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.remove('visible');
      }
    });

    document.body.addEventListener('dragover', e => {
      e.preventDefault();
    });

    document.body.addEventListener('drop', async e => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove('visible');

      const file = e.dataTransfer?.files[0];
      if (!file || !file.name.endsWith('.webp')) return;

      const result = await extractDrawingData(file);
      if (!result || result.shapes.length === 0) {
        console.warn('[DragDrop] No drawing data found in dropped file');
        return;
      }

      // Switch to correct map if needed
      if (result.mapName) {
        const validMapName = asMapName(result.mapName);
        if (validMapName && validMapName !== app.getMap()) {
          await app.setMap(validMapName);
          drawingSession?.setMap(validMapName);
        }
      }

      if (drawingManager) {
        isDrawLoading = true;
        drawingManager.loadShapes(result.shapes);
        isDrawLoading = false;
        if (result.strokeWidth) {
          drawingManager.setStrokeWidth(result.strokeWidth);
          drawingSidebar?.setStrokeWidth(result.strokeWidth);
        }
        // Update URL with imported drawing data
        const mapName = drawingSession?.getMapName() ?? '';
        const sw = result.strokeWidth ?? drawingManager.getStrokeWidth();
        const encoded = encodeShapesWithInfo(result.shapes, undefined, mapName, sw);
        if (encoded) {
          updateURLWithDrawing(encoded.encoded);
        }
      }

      // Auto-open sidebar
      if (drawToggleCheckbox && drawingSidebar) {
        drawToggleCheckbox.checked = true;
        drawingSidebar.open();
        updateURLWithSidebar(true);
      }

      console.log('[DragDrop] Imported', result.shapes.length, 'shapes from dropped file');
    });
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

    // Blur to restore hotkey focus to document
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // Reset drawing when changing maps (drawings are per-map)
    // Preserve sidebar state - don't open or close it
    if (drawingManager) {
      drawingManager.resetShapes(); // Clear shapes AND history
    }
    if (drawingSession) {
      drawingSession.setMap(mapName);
    }
    // Clear drawing from URL but preserve sidebar state
    updateURLWithDrawing(null);

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
  shareEl.addEventListener('click', async ev => {
    ev.preventDefault();

    const shapes = drawingManager?.getShapes() ?? [];

    // If there are drawings, upload to catbox and share the short link
    if (shapes.length > 0 && drawingManager) {
      const strokeWidth = drawingManager.getStrokeWidth();

      // Show "uploading" feedback
      const toastElement = assertElementById('shareToast', HTMLElement);
      const toastBody = toastElement.querySelector('.toast-body');
      if (toastBody) {
        toastBody.innerHTML = `<i class="bi bi-hourglass-split me-2"></i>${i18next.t('share.uploading')}`;
      }
      const uploadingToast = new bootstrap.Toast(toastElement, { autohide: false });
      uploadingToast.show();

      try {
        // Capture screenshot with embedded drawing data
        const viewport = app.osd.viewport;
        const containerSize = viewport.getContainerSize();
        const worldToPixel = (x: number, y: number) => {
          const point = viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(x, y));
          return { x: point.x, y: point.y };
        };
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

        const blob = await captureScreenshot(osdRootElement, null, app.getMap(), shapes, viewportInfo, strokeWidth);
        if (!blob) {
          uploadingToast.hide();
          if (toastBody) {
            toastBody.innerHTML = `<i class="bi bi-x-circle me-2"></i>${i18next.t('share.screenshotFailed')}`;
          }
          const errorToast = new bootstrap.Toast(toastElement, { autohide: true, delay: 3000 });
          errorToast.show();
          return;
        }

        // Auto-download the image to user's PC as backup
        downloadBlob(blob, screenshotFilename(app.getMap()));

        // Upload to catbox
        const fileId = await uploadToCatbox(blob);
        uploadingToast.hide();

        if (!fileId) {
          if (toastBody) {
            toastBody.innerHTML = `<i class="bi bi-x-circle me-2"></i>${i18next.t('share.uploadFailed')}`;
          }
          const errorToast = new bootstrap.Toast(toastElement, { autohide: true, delay: 4000 });
          errorToast.show();
          return;
        }

        // Build URL with catbox param
        const url = new URL(window.location.href);
        const overlays = getEnabledOverlays();
        if (overlays.length > 0) {
          url.searchParams.set('o', overlays.map(overlayToShort).join(','));
        } else {
          url.searchParams.delete('o');
        }
        url.searchParams.set('d', createCatboxParam(fileId));

        // Update current URL with catbox param
        updateURLWithDrawing(createCatboxParam(fileId));

        // Show "Open on Catbox" link in sidebar
        drawingSidebar?.setCatboxSource(fileId);

        // Shorten URL if possible
        let finalUrl = url.toString();
        const shortUrl = await shortenUrl(finalUrl);
        if (shortUrl) {
          finalUrl = shortUrl;
        }

        // Copy to clipboard
        window.navigator.clipboard
          .writeText(finalUrl)
          .then(() => {
            if (toastBody) {
              toastBody.innerHTML = `<i class="bi bi-check-circle me-2"></i>${i18next.t('share.copiedWithDrawing')}`;
            }
            const successToast = new bootstrap.Toast(toastElement, { autohide: true, delay: 3000 });
            successToast.show();
          })
          .catch(err => {
            console.error('Failed to copy to clipboard:', err);
          });
      } catch (error) {
        console.error('[Share] Error during upload:', error);
        uploadingToast.hide();
        if (toastBody) {
          toastBody.innerHTML = `<i class="bi bi-x-circle me-2"></i>${i18next.t('share.uploadFailed')}`;
        }
        const errorToast = new bootstrap.Toast(toastElement, { autohide: true, delay: 4000 });
        errorToast.show();
      }
    } else {
      // No drawings - just copy the current URL
      const url = new URL(window.location.href);
      const overlays = getEnabledOverlays();
      if (overlays.length > 0) {
        url.searchParams.set('o', overlays.map(overlayToShort).join(','));
      } else {
        url.searchParams.delete('o');
      }
      url.searchParams.delete('d');

      // Shorten URL if possible
      let finalUrl = url.toString();
      const shortUrl = await shortenUrl(finalUrl);
      if (shortUrl) {
        finalUrl = shortUrl;
      }

      window.navigator.clipboard
        .writeText(finalUrl)
        .then(() => {
          const toastElement = assertElementById('shareToast', HTMLElement);
          const toastBody = toastElement.querySelector('.toast-body');
          if (toastBody) {
            toastBody.innerHTML = `<i class="bi bi-check-circle me-2"></i>${i18next.t('share.copied')}`;
          }
          const toast = new bootstrap.Toast(toastElement, { autohide: true, delay: 2000 });
          toast.show();
        })
        .catch(err => {
          console.error('Failed to copy to clipboard:', err);
        });
    }
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

  // Listen for corrupted shape data warnings
  window.addEventListener('drawing-shapes-skipped', (event: any) => {
    const toastEl = document.getElementById('skippedShapesToast');
    if (toastEl) {
      // You could customize the message with event.detail.count if you want
      const toast = new bootstrap.Toast(toastEl);
      toast.show();
    }
  });
});

/**
 * Show error toast when catbox drawing file is not found
 */
function showCatboxErrorToast(): void {
  const toastEl = document.getElementById('drawingWarningToast') ?? document.getElementById('shareToast');
  if (!toastEl) return;

  const toastBody = toastEl.querySelector('.toast-body');
  if (toastBody) {
    toastBody.innerHTML = `
      <i class="bi bi-exclamation-triangle me-2 text-warning"></i>
      ${i18next.t('share.drawingNotFound', 'The shared drawing could not be found. It may have been deleted from the host. Ask the person who shared the link to send you the source image file, then use the Import button in the drawing panel.')}
    `;
  }
  const titleEl = toastEl.querySelector('.toast-header strong');
  if (titleEl) {
    titleEl.textContent = i18next.t('share.drawingNotFoundTitle', 'Drawing Not Found');
  }
  const toast = new bootstrap.Toast(toastEl, { autohide: false });
  toast.show();
}
