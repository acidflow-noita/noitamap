import { searchOverlays } from '../flexsearch';
import { resetBiomeOverlays } from '../data_sources/overlays';
import { MapName } from '../data_sources/tile_data';
import { debounce } from '../util';
import { UnifiedSearchResults, UnifiedSearchResult } from './unifiedsearchresults';
import { TargetOfInterest, Spell } from '../data_sources/overlays';
import { gameTranslator } from '../game-translations/translator';
import i18next from '../i18n';
import spells from '../data/spells.json';
import { EventEmitter2 } from 'eventemitter2';

export type UnifiedSearchCreateOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
};

type UnifiedSearchConstructOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchResults: UnifiedSearchResults;
};

export interface UnifiedSearch {
  on(event: 'selected', listener: (target: TargetOfInterest | { type: 'spell'; spell: any }) => void): this;
}

export class UnifiedSearch extends EventEmitter2 {
  private lastSearchText: string = '';
  private lastSearchFilters: Set<string> = new Set();

  private form: HTMLFormElement;
  private searchInput: HTMLInputElement;
  private activeFilters: Set<string> = new Set();
  private searchResults: UnifiedSearchResults;

  public currentMap: MapName;

  private constructor({ currentMap, form, searchInput, searchResults }: UnifiedSearchConstructOptions) {
    super();

    this.currentMap = currentMap;
    this.form = form;
    this.searchInput = searchInput;
    this.searchResults = searchResults;

    this.bindEvents();
  }

  private bindEvents() {
    this.searchResults.on('selected', (result: any) => {
      this.emit('selected', result);
    });

    const debounced = debounce(100, () => this.updateSearchResults());

    // never submit the form
    this.form.addEventListener('submit', ev => {
      ev.preventDefault();
      // if the "search" event isn't present, still update the search
      // results when the user hits enter in the search box
      debounced();
    });

    // nonstandard event for when user hits enter (or clicks the x) in
    // an <input type="search">
    this.searchInput.addEventListener('search', debounced);

    // "live" search - show list of results as the user types
    this.searchInput.addEventListener('keyup', ev => {
      if (!(ev.altKey || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.isComposing)) {
        switch (ev.key) {
          case 'Escape':
            this.searchInput.value = '';
            this.updateSearchResults();
            break;
          case 'ArrowDown':
            this.searchResults.focusNext();
            return;
          case 'ArrowUp':
            this.searchResults.focusPrevious();
            return;
        }
      }
      debounced();
    });

    this.searchResults.on('blur', () => {
      this.searchInput.focus();
    });

    for (const filterCheckbox of document.querySelectorAll<HTMLInputElement>(
      '#unifiedSearchFilterBox input[type="checkbox"]'
    )) {
      filterCheckbox.addEventListener('change', () => {
        if (filterCheckbox.checked) {
          this.activeFilters.add(filterCheckbox.value);
        } else {
          this.activeFilters.delete(filterCheckbox.value);
        }
        this.updateSearchResults();
      });
    }
  }

  setSearchValueWithoutTriggering(value: string) {
    this.searchInput.value = value;
    this.lastSearchText = value;
  }

  // Method to refresh search results with new translations
  refreshTranslations() {
    if (this.searchInput.value.trim() !== '') {
      // Force update by clearing lastSearchText and calling updateSearchResults
      this.lastSearchText = '';
      this.updateSearchResults();
    }
  }

  private updateSearchResults() {
    const searchText = this.searchInput.value;
    if (this.lastSearchText === searchText && this.lastSearchFilters === this.activeFilters) return;
    this.lastSearchText = searchText;
    this.lastSearchFilters = new Set(this.activeFilters);

    if (searchText === '') {
      resetBiomeOverlays();
      this.searchResults.setResults([]);
      return;
    }

    // Search for map overlays (these will be translated by the overlay search function)
    const mapResults = searchOverlays(this.currentMap, searchText, this.activeFilters);

    // Combine results, prioritizing map results first
    const combinedResults: any[] = [...mapResults];

    if (this.activeFilters.has('spells') || this.activeFilters.size === 0) {
      // Search for spells with translation support
      const spellResults = spells
        .filter(spell => {
          const translatedName = gameTranslator.translateSpell(spell.name);
          const originalName = spell.name.toLowerCase();
          const translatedNameLower = translatedName.toLowerCase();
          const searchLower = searchText.toLowerCase();

          return (
            originalName.includes(searchLower) ||
            translatedNameLower.includes(searchLower) ||
            spell.id.toLowerCase().includes(searchLower)
          );
        })
        .map(spell => {
          const translatedName = gameTranslator.translateSpell(spell.name);
          const currentLang = i18next.language;

          // Create display text with English fallback for non-English languages
          let spellDisplayName = translatedName;
          if (currentLang !== 'en' && translatedName !== spell.name) {
            spellDisplayName = `${translatedName} (${spell.name})`;
          }

          return {
            type: 'spell' as const,
            spell,
            displayName: translatedName,
            displayText: `${i18next.t('spell_prefix', 'Spell')}: ${spellDisplayName} (${i18next.t('tiers_prefix', 'Tiers')}: ${Object.keys(spell.spawnProbabilities).join(', ')})`,
          };
        });

      combinedResults.push(...spellResults);
    }

    this.searchResults.setResults(combinedResults);
  }

  static create({ currentMap, form }: UnifiedSearchCreateOptions) {
    // Use the existing search input from HTML instead of creating a new one
    const searchInput = document.getElementById('unified-search-input') as HTMLInputElement;
    if (!searchInput) {
      throw new Error('Search input element not found. Make sure #unified-search-input exists in the HTML.');
    }

    // Create an absolutely-positioned overlay container for search results
    let searchResultsOverlay = document.getElementById('unifiedSearchResultsOverlay');
    if (!searchResultsOverlay) {
      searchResultsOverlay = document.createElement('div');
      searchResultsOverlay.id = 'unifiedSearchResultsOverlay';
      document.body.appendChild(searchResultsOverlay);
    } else {
      searchResultsOverlay.innerHTML = '';
    }
    // Type assertion to satisfy linter
    const overlayDiv = searchResultsOverlay as HTMLDivElement;

    const filterBox = document.createElement('div');
    filterBox.id = 'unifiedSearchFilterBox';

    const filters = [
      { type: 'spells', iconSrc: 'assets/icons/spells/light_bullet.png' },
      { type: 'structures', iconSrc: 'assets/icons/overlay-toggles/icon-structures.svg' },
      { type: 'bosses', iconSrc: 'assets/icons/overlay-toggles/icon-bosses.webp' },
      { type: 'items', iconSrc: 'assets/icons/overlay-toggles/icon-items.webp' },
      { type: 'orbs', iconSrc: 'assets/icons/overlay-toggles/icon-orbs.webp' },
      { type: 'spatialAwareness', iconSrc: 'assets/icons/overlay-toggles/icon-spatial-awareness.webp' },
      { type: 'hiddenMessages', iconSrc: 'assets/icons/overlay-toggles/icon-hidden-messages.webp' },
    ];

    for (const filter of filters) {
      const filterLabel = document.createElement('label');
      filterLabel.tabIndex = 0;
      const filterCheckbox = document.createElement('input');
      filterCheckbox.type = 'checkbox';
      filterCheckbox.value = filter.type;
      filterLabel.appendChild(filterCheckbox);
      const filterIcon = document.createElement('img');
      filterIcon.src = filter.iconSrc;
      filterIcon.alt = '';
      filterIcon.classList.add('pixelated-image');
      filterIcon.draggable = false;
      filterLabel.appendChild(filterIcon);
      filterBox.appendChild(filterLabel);
    }
    overlayDiv.appendChild(filterBox);

    const searchResultsUL = document.createElement('ul');
    searchResultsUL.id = 'unifiedSearchResults';
    overlayDiv.appendChild(searchResultsUL);

    // Position overlay below the input
    function positionOverlay() {
      const rect = searchInput.getBoundingClientRect();
      overlayDiv.style.left = `${rect.left + window.scrollX}px`;
      overlayDiv.style.top = `${rect.bottom + window.scrollY}px`;
      overlayDiv.style.width = `${rect.width}px`;
    }

    let isOverlayVisible = false;

    searchInput.addEventListener('focus', () => {
      positionOverlay();
      overlayDiv.style.display = 'block';
      isOverlayVisible = true;
    });

    const hideOverlay = () => {
      setTimeout(() => {
        if (!overlayDiv.matches(':focus-within') && document.activeElement !== searchInput) {
          overlayDiv.style.display = 'none';
          isOverlayVisible = false;
        }
      }, 200);
    };

    searchInput.addEventListener('blur', hideOverlay);
    overlayDiv.addEventListener('blur', hideOverlay);

    window.addEventListener('resize', () => {
      if (isOverlayVisible) positionOverlay();
    });
    window.addEventListener(
      'scroll',
      () => {
        if (isOverlayVisible) positionOverlay();
      },
      true
    );

    const searchResults = new UnifiedSearchResults(searchResultsUL);

    // Show overlay when results are updated
    const origSetResults = searchResults.setResults.bind(searchResults);
    searchResults.setResults = (...args) => {
      origSetResults(...args);
      if (args[0].length > 0 && document.activeElement === searchInput) {
        positionOverlay();
        overlayDiv.style.display = 'block';
        isOverlayVisible = true;
      }
    };

    return new UnifiedSearch({
      currentMap,
      form,
      searchInput,
      searchResults,
    });
  }
}
