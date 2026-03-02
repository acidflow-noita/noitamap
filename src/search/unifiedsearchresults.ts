import { TargetOfInterest } from '../data_sources/overlays';
import { Spell } from '../data_sources/overlays';
import { EventEmitter2 } from 'eventemitter2';
import i18next from '../i18n';
import { getSpellAvailability } from '../util';

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
        listItem.classList.add('d-flex', 'align-items-start');
        const img = document.createElement('img');
        img.src = `./assets/icons/spells/${result.spell.sprite}`;
        img.classList.add('pixelated-image', 'me-2', 'flex-shrink-0');
        img.alt = result.spell.name;
        img.style.width = '32px';
        img.style.height = '32px';
        img.style.marginTop = '2px';
        img.onerror = () => {
          img.src = './assets/icons/spells/missing.png';
          img.alt = 'Missing';
        };
        listItem.appendChild(img);

        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'spell-search-content';

        // Parse the displayText to extract components
        const currentLang = i18next.language;
        const spellPrefix = i18next.t('spell_prefix', 'Spell');
        const tiersPrefix = i18next.t('tiers_prefix', 'Tiers');
        const availabilityString = getSpellAvailability(result.spell, i18next);
        const translatedName = result.displayName;
        const tiers = Object.keys(result.spell.spawnProbabilities).join(', ');

        // Main spell line with translated name
        const mainDiv = document.createElement('div');
        mainDiv.className = 'spell-main-line';
        mainDiv.textContent = `${spellPrefix}: ${translatedName}`;
        contentDiv.appendChild(mainDiv);

        // English name on second line if not in English and different
        if (currentLang !== 'en' && translatedName !== result.spell.name) {
          const englishDiv = document.createElement('div');
          englishDiv.className = 'spell-english-line';
          englishDiv.textContent = result.spell.name;
          englishDiv.style.fontSize = '0.85em';
          englishDiv.style.color = '#888';
          englishDiv.style.fontStyle = 'italic';
          contentDiv.appendChild(englishDiv);
        }

        // Tiers and availability on third line
        const infoDiv = document.createElement('div');
        infoDiv.className = 'spell-info-line';

        const tiersSpan = document.createElement('span');
        tiersSpan.className = 'spell-tiers-line';
        tiersSpan.textContent = `${tiersPrefix}: ${tiers}`;
        infoDiv.appendChild(tiersSpan);

        const availabilitySpan = document.createElement('span');
        availabilitySpan.className = 'spell-availability-line';
        availabilitySpan.textContent = availabilityString;
        infoDiv.appendChild(availabilitySpan);

        contentDiv.appendChild(infoDiv);

        listItem.appendChild(contentDiv);
      } else if ('overlayType' in result) {
        // Handle map overlay results with translated names
        switch (result.overlayType) {
          case 'poi':
            // Use displayName if available (translated), otherwise fall back to name
            const displayName = ('displayName' in result ? (result as any).displayName : result.name) as string;
            const currentLang = i18next.language;

            // Create content container for multi-line display
            const contentDiv = document.createElement('div');
            contentDiv.className = 'overlay-search-content';

            // Main name line with translated name
            const nameDiv = document.createElement('div');
            nameDiv.className = 'overlay-main-line';

            // For dynamic POIs, show "~X chunks away" proximity hint
            if ((result as any).isDynamic && (result as any).chunksAway !== null) {
              const chunksAway = (result as any).chunksAway as number;
              nameDiv.textContent = displayName;
              const proximitySpan = document.createElement('span');
              proximitySpan.className = 'ms-2 text-secondary';
              proximitySpan.style.fontSize = '0.8em';
              proximitySpan.textContent = `~${chunksAway} chunks away`;
              nameDiv.appendChild(proximitySpan);
            } else {
              nameDiv.textContent = displayName;
            }
            contentDiv.appendChild(nameDiv);

            // English name on second line if not in English and different
            if (currentLang !== 'en' && displayName !== result.name) {
              const englishDiv = document.createElement('div');
              englishDiv.className = 'overlay-english-line';
              englishDiv.textContent = result.name;
              englishDiv.style.fontSize = '0.85em';
              englishDiv.style.color = '#888';
              englishDiv.style.fontStyle = 'italic';
              contentDiv.appendChild(englishDiv);
            }

            // Aliases on third line if they exist
            if ('aliases' in result && result.aliases) {
              const aliasDiv = document.createElement('div');
              aliasDiv.className = 'overlay-aliases-line';
              aliasDiv.textContent = `(${result.aliases.join(', ')})`;
              aliasDiv.style.fontSize = '0.85em';
              aliasDiv.style.color = '#666';
              contentDiv.appendChild(aliasDiv);
            }

            listItem.appendChild(contentDiv);
            break;

          case 'aoi':
            // Use displayText if available (translated), otherwise fall back to text
            const displayText = ('displayText' in result ? (result as any).displayText : result.text) as string | string[];
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
