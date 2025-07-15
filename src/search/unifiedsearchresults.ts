import { TargetOfInterest } from '../data_sources/overlays';
import { Spell } from '../data_sources/overlays';

export type UnifiedSearchResult =
  | TargetOfInterest
  | { type: 'spell'; spell: Spell; displayName: string; displayText: string };

export interface UnifiedSearchResults {
  on(event: 'selected', listener: (target: UnifiedSearchResult) => void): this;
  on(event: 'blur', listener: () => void): this;
}

export class UnifiedSearchResults extends EventEmitter2 {
  private targetByElement = new WeakMap<Element, UnifiedSearchResult>();
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

    const listItem = ev.target instanceof HTMLLIElement ? ev.target : (ev.target as Element).closest('li');

    if (!(listItem instanceof HTMLLIElement)) return;

    // when we've selected an element, find the data
    // we stored for that element, and emit it
    const target = this.targetByElement.get(listItem);
    if (!target) return;

    ev.stopPropagation();

    this.emit('selected', target);

    // Hide the search results overlay after selection
    const overlay = document.getElementById('unifiedSearchResultsOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
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

  setResults(results: UnifiedSearchResult[]) {
    this.clearResults(results.length === 0);

    for (const [idx, result] of results.entries()) {
      const listItem = document.createElement('li');
      listItem.classList.add('list-group-item', 'search-result');
      listItem.tabIndex = idx;
      this.targetByElement.set(listItem, result);

      if ('type' in result && result.type === 'spell') {
        // Handle spell results with image
        listItem.classList.add('d-flex', 'align-items-center');
        const img = document.createElement('img');
        img.src = `./assets/icons/spells/${result.spell.sprite}`;
        img.classList.add('pixelated-image', 'me-2');
        img.alt = result.spell.name;
        img.style.width = '32px';
        img.style.height = '32px';
        img.onerror = () => {
          img.src = './assets/icons/spells/missing.png';
          img.alt = 'Missing';
        };
        listItem.appendChild(img);
        const textDiv = document.createElement('div');
        textDiv.textContent = result.displayText;
        listItem.appendChild(textDiv);
      } else if ('overlayType' in result) {
        // Handle map overlay results with translated names
        switch (result.overlayType) {
          case 'poi':
            // Use displayName if available (translated), otherwise fall back to name
            const displayName = 'displayName' in result ? result.displayName : result.name;
            listItem.textContent = displayName;
            if ('aliases' in result && result.aliases) {
              listItem.textContent += ` (${result.aliases.join(', ')})`;
            }
            break;

          case 'aoi':
            // Use displayText if available (translated), otherwise fall back to text
            const displayText = 'displayText' in result ? result.displayText : result.text;
            if (Array.isArray(displayText)) {
              listItem.textContent = displayText.join('; ');
            } else {
              listItem.textContent = displayText || result.text.join('; ');
            }
            break;
        }
      }

      this.wrapper.appendChild(listItem);
    }
  }
}
