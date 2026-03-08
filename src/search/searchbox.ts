import { searchOverlays } from '../flexsearch';
import { MapName } from '../data_sources/tile_data';
import { debounce } from '../util';
import { SearchResults } from './searchresults';
import { TargetOfInterest } from '../data_sources/overlays';

export type SearchBoxCreateOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
};

type SearchBoxConstructOptions = {
  currentMap: MapName;
  form: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchResults: SearchResults;
};

export interface SearchBox {
  on(event: 'selected', listener: (target: TargetOfInterest) => void): this;
}
export class SearchBox extends EventEmitter2 {
  private lastSearchText: string = '';

  private form: HTMLFormElement;
  private searchInput: HTMLInputElement;
  private searchResults: SearchResults;

  public currentMap: MapName;

  private constructor({ currentMap, form, searchInput, searchResults }: SearchBoxConstructOptions) {
    super();

    this.currentMap = currentMap;
    this.form = form;
    this.searchInput = searchInput;
    this.searchResults = searchResults;

    this.bindEvents();
  }

  private bindEvents() {
    this.searchResults.on('selected', toi => this.emit('selected', toi));

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
  }

  private updateSearchResults() {
    const searchText = this.searchInput.value;
    if (this.lastSearchText === searchText) return;
    this.lastSearchText = searchText;

    const results = searchText === '' ? [] : searchOverlays(this.currentMap, searchText, new Set());

    this.searchResults.setResults(results);
  }

  static create({ currentMap, form }: SearchBoxCreateOptions) {
    const searchInput = document.createElement('input');
    searchInput.classList.add('form-control');
    searchInput.id = 'unified-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search… e.g. Kolmi';
    searchInput.ariaLabel = 'Search';

    const searchResultsUL = document.createElement('ul');
    searchResultsUL.id = 'searchResults';
    form.innerHTML = '';
    form.appendChild(searchInput);
    form.appendChild(searchResultsUL);

    const searchResults = new SearchResults(searchResultsUL);

    return new SearchBox({
      currentMap,
      form,
      searchInput,
      searchResults,
    });
  }
}
