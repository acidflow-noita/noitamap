import i18next, { currentLanguage, languageLocale, SUPPORTED_LANGUAGES, type SupportedLanguage } from './i18n';
import Combobox from './bootstrap-combobox';
import '../public/css/language-selector.css';

export interface LanguageSelectorOptions {
  button: HTMLButtonElement;
  menu: HTMLElement;
  label?: (languageName: string) => string;
  onLanguageChanged?: () => void;
}

const selectors = new WeakMap<HTMLButtonElement, { refresh: () => void }>();
const selectorButtons = new Set<WeakRef<HTMLButtonElement>>();
i18next.on('languageChanged', () => {
  for (const reference of selectorButtons) {
    const button = reference.deref();
    if (button) selectors.get(button)?.refresh();
    else selectorButtons.delete(reference);
  }
});

function flagImage(flag: string): HTMLImageElement {
  const image = document.createElement('img');
  image.src = `/flags/${flag}.svg`;
  image.className = 'flag-icon';
  image.width = 16;
  image.height = 12;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}

/** One Bootstrap combobox for the map and Guessr, sharing saved preferences. */
export function mountLanguageSelector(options: LanguageSelectorOptions): { refresh: () => void; destroy: () => void } {
  const { button, menu } = options;
  button.parentElement?.classList.add('language-selector');
  button.classList.add('combobox-toggle');
  button.dataset.bsToggle = 'combobox';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', menu.id);
  const value = document.createElement('span'); value.className = 'combobox-value';
  const caret = document.createElement('span'); caret.className = 'combobox-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="m3 6 5 5 5-5z"/></svg>';
  button.replaceChildren(value, caret);
  const links = new Map<SupportedLanguage, HTMLAnchorElement>();
  menu.replaceChildren();
  for (const [code, { name, flag }] of Object.entries(SUPPORTED_LANGUAGES)) {
    const link = document.createElement('a');
    link.href = '#';
    link.dataset.lang = code;
    link.dataset.bsValue = code;
    link.lang = languageLocale(code);
    link.className = 'menu-item';
    link.tabIndex = -1;
    link.setAttribute('role', 'option');
    link.append(flagImage(flag), document.createTextNode(name));
    links.set(code as SupportedLanguage, link);
    menu.append(link);
  }
  menu.setAttribute('role', 'listbox');

  const refresh = () => {
    const language = currentLanguage();
    const info = SUPPORTED_LANGUAGES[language];
    value.replaceChildren(flagImage(info.flag));
    button.setAttribute('aria-label', options.label?.(info.name) ?? info.name);
    for (const [code, link] of links) {
      const selected = code === language;
      link.classList.toggle('selected', selected);
      link.setAttribute('aria-selected', String(selected));
    }
    options.onLanguageChanged?.();
  };
  const choose = (event: Event) => {
    const language = (event as Event & { value?: string }).value;
    if (!language || !Object.hasOwn(SUPPORTED_LANGUAGES, language)) return;
    value.replaceChildren(flagImage(SUPPORTED_LANGUAGES[language as SupportedLanguage].flag));
    // An explicit old URL override must not undo a newly selected preference
    // on reload. Keep every map/room parameter and fragment intact.
    const url = new URL(location.href);
    if (url.searchParams.has('lng')) {
      url.searchParams.set('lng', language);
      history.replaceState(history.state, '', url);
    }
    void i18next.changeLanguage(language);
  };
  button.addEventListener('change.bs.combobox', choose);
  // A removed Guessr header must not keep its menu alive via the global i18next
  // emitter. The map's single long-lived selector uses the same lifecycle.
  const reference = new WeakRef(button);
  selectors.set(button, { refresh });
  selectorButtons.add(reference);
  refresh();
  const combobox = new Combobox(button, { placement: 'bottom-start' });
  // The combobox renders option text initially; our compact toggle uses its flag.
  refresh();
  return { refresh, destroy: () => {
    combobox.dispose();
    button.removeEventListener('change.bs.combobox', choose);
    selectors.delete(button);
    selectorButtons.delete(reference);
  } };
}
