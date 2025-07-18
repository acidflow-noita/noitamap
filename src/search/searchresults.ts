import { TargetOfInterest } from '../data_sources/overlays';
import i18next from '../i18n';
import { EventEmitter2 } from 'eventemitter2';

export interface SearchResults {
  on(event: 'selected', listener: (target: TargetOfInterest) => void): this;
  on(event: 'blur', listener: () => void): this;
}

export class SearchResults extends EventEmitter2 {
  private targetByElement = new WeakMap<Element, TargetOfInterest>();
  private currentElement: Element | null = null;

  private wrapper: HTMLUListElement;
  constructor(wrapper: HTMLUListElement) {
    super();

    this.wrapper = wrapper;
    this.wrapper.innerHTML = '';
    this.bindEvents();
  }

  private bindEvents() {
    this.wrapper.addEventListener('keyup', ev => {
      if (ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.isComposing) return;

      let handled = true;
      switch (ev.key) {
        case 'Escape':
          this.blur();
          break;
        case 'Enter':
          this.onSelected(ev);
          break;
        case 'ArrowDown':
          this.focusNext();
          break;
        case 'ArrowUp':
          this.focusPrevious();
          break;
        default:
          handled = false;
          break;
      }

      if (handled) ev.stopPropagation();
    });

    this.wrapper.addEventListener('click', ev => this.onSelected(ev));
  }

  private onSelected(ev: MouseEvent | KeyboardEvent) {
    if (!ev.target) return;

    if (!(ev.target instanceof HTMLLIElement)) return;

    // when we've selected an element, find the TargetOfInterest data
    // we stored for that element, and emit it
    const target = this.targetByElement.get(ev.target);
    if (!target) return;

    ev.stopPropagation();

    this.emit('selected', target);
  }

  private blur() {
    this.currentElement = null;
    this.emit('blur');
  }

  private focus(target: Element | null) {
    if (!(target instanceof HTMLElement)) return;
    this.currentElement = target;
    target.focus();
  }

  focusPrevious() {
    // when we select the previous and we're already at the top, allow
    // the search input to retrieve the focus
    if (this.currentElement === this.wrapper.firstElementChild) {
      this.blur();
    } else {
      this.focus(this.currentElement?.previousElementSibling ?? null);
    }
  }

  focusNext() {
    this.focus(this.currentElement ? this.currentElement.nextElementSibling : this.wrapper.firstElementChild);
  }

  private clearResults(hide: boolean = true) {
    this.currentElement = null;
    this.wrapper.innerHTML = '';
    // this.wrapper.style.display = hide ? 'none' : 'block';
  }

  setResults(overlays: TargetOfInterest[]) {
    this.clearResults(overlays.length === 0);

    for (const [idx, overlay] of overlays.entries()) {
      const listItem = document.createElement('li');
      listItem.classList.add('search-result');
      listItem.tabIndex = idx;
      this.targetByElement.set(listItem, overlay);

      switch (overlay.overlayType) {
        case 'poi':
          // Use displayName if available (from search system), otherwise use name
          const displayName = (overlay as any).displayName || overlay.name;
          const currentLang = i18next.language;

          // Create the main content div
          const contentDiv = document.createElement('div');
          contentDiv.className = 'search-result-content';

          // Add the translated name
          const nameDiv = document.createElement('div');
          nameDiv.className = 'search-result-name';
          nameDiv.textContent = displayName;
          contentDiv.appendChild(nameDiv);

          // Add English fallback on a new line if not in English and translation differs
          if (currentLang !== 'en' && displayName !== overlay.name) {
            const englishDiv = document.createElement('div');
            englishDiv.className = 'search-result-english';
            englishDiv.textContent = overlay.name;
            englishDiv.style.fontSize = '0.85em';
            englishDiv.style.color = '#888';
            englishDiv.style.fontStyle = 'italic';
            contentDiv.appendChild(englishDiv);
          }

          // Add aliases if they exist
          if (overlay.aliases) {
            const aliasDiv = document.createElement('div');
            aliasDiv.className = 'search-result-aliases';
            aliasDiv.textContent = `(${overlay.aliases.join(', ')})`;
            aliasDiv.style.fontSize = '0.85em';
            aliasDiv.style.color = '#666';
            contentDiv.appendChild(aliasDiv);
          }

          listItem.appendChild(contentDiv);
          break;

        case 'aoi':
          listItem.textContent = overlay.text.join('; ');
          break;
      }

      this.wrapper.appendChild(listItem);
    }
  }
}
