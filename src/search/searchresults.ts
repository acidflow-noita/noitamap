import { TargetOfInterest } from '../data_sources/overlays';

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
          listItem.textContent = `${overlay.name} (${overlay.aliases?.join(', ')})`;
          break;

        case 'aoi':
          listItem.textContent = overlay.text.join('; ');
          break;
      }

      this.wrapper.appendChild(listItem);
    }
  }
}
