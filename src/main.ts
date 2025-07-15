import i18next, { SUPPORTED_LANGUAGES } from './i18n';
import { App } from './app';
import { parseURL, updateURL } from './data_sources/url';
import { asOverlayKey, showOverlay, selectSpell } from './data_sources/overlays';
import { UnifiedSearch } from './search/unifiedsearch';
import { asMapName } from './data_sources/tile_data';
import { addEventListenerForId, assertElementById, debounce } from './util';
import { createMapLinks, NAV_LINK_IDENTIFIER } from './nav';
import { initMouseTracker } from './mouse_tracker';
import { isRenderer, getStoredRenderer, setStoredRenderer } from './renderer_settings';
import { createLanguageSelector } from './language-selector';
import { updateTranslations } from './i18n-dom';

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
        loadPath: 'https://noitamap-translations.acidflow.stream/locales/{{lng}}/translation.json',
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

  const app = await App.create({
    mountTo: osdRootElement,
    overlayButtons: overlayButtonsElement,
    initialState: parseURL(),
    useWebGL: storedRenderer === 'webgl',
  });

  const initialMapName = app.getMap();

  navbarBrandElement.addEventListener('click', ev => {
    ev.preventDefault();
    app.home();
  });

  // create unified search
  const unifiedSearch = UnifiedSearch.create({
    currentMap: app.getMap(),
    form: searchForm,
  });

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
    window.navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        // Show toast notification
        const toastElement = assertElementById('shareToast', HTMLElement);
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
});
