function heightAfter(viewport: HTMLElement): number {
  let height = 0;
  for (let item = viewport.nextElementSibling; item; item = item.nextElementSibling) {
    const { display, position } = getComputedStyle(item);
    if (display !== 'none' && position !== 'absolute' && position !== 'fixed') {
      height += item.getBoundingClientRect().height;
    }
  }
  return height;
}

/** Fit the fixed clue crop and guess map without changing either camera.
 * Width comes from the parent, never from the grid being resized. */
export function fitGameFrame(grid: HTMLElement): () => void {
  let frame = 0, stopped = false, parent: HTMLElement | null = null;
  const watched = new Set<Element>(), sizes = new WeakMap<Element, { width: number; height: number }>();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      const old = sizes.get(entry.target), { width, height } = entry.contentRect;
      // Canvas output can change the parent's height. Only its width is input.
      if (!old || old.width !== width || entry.target !== parent && old.height !== height) changed = true;
      sizes.set(entry.target, { width, height });
    }
    if (changed) queue();
  }) : undefined;
  const watch = (inputs: Element[]) => {
    const next = new Set(inputs);
    for (const old of watched) if (!next.has(old)) { resize?.unobserve(old); watched.delete(old); }
    for (const input of next) if (!watched.has(input)) { watched.add(input); resize?.observe(input); }
  };
  const clear = () => { if (grid.dataset.roundFrame) delete grid.dataset.roundFrame; };
  const fit = () => {
    frame = 0;
    if (stopped || !grid.isConnected) return;
    parent = grid.parentElement;
    if (!parent) return;
    const clue = grid.querySelector<HTMLElement>('.clue-stage') ?? grid.querySelector<HTMLElement>('.clue');
    const map = grid.querySelector<HTMLElement>('.game-panel--map > .map-board, .stream-picker > .map-board');
    const left = clue?.closest<HTMLElement>('.game-panel'), right = map?.closest<HTMLElement>('.game-panel');
    const inputs: Element[] = [parent, ...parent.querySelectorAll(':scope > .stream-banner, :scope > .game-hud'),
      ...grid.querySelectorAll(':scope > .stream-connection-bar')];
    const legend = parent.querySelector<HTMLElement>(':scope > .round-map-legend');
    if (legend) inputs.push(legend);
    if (parent.parentElement) inputs.push(...parent.parentElement.querySelectorAll(':scope > .site-header, :scope > .guessr-poll-bar'));
    if (left && right) inputs.push(...[...left.children, ...right.children].filter(child => child !== clue && child !== map));
    inputs.push(...grid.querySelectorAll('.round-panel-header > *'));
    watch(inputs);
    const style = getComputedStyle(parent);
    const width = parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const bottom = (parseFloat(style.paddingBottom) || 0)
      + (legend ? legend.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0) : 0);
    const shortLandscape = innerHeight < 650 && innerWidth >= 720 && innerWidth > innerHeight;
    if (!clue || !map || !left || !right || left.hidden || right.hidden || map.hidden || grid.hidden
      || getComputedStyle(left).display === 'none' || getComputedStyle(right).display === 'none') {
      clear();
      grid.style.removeProperty('--round-map-height');
      return;
    }
    const useSplit = shortLandscape ? width >= 690 : width >= 960 && innerWidth >= 1024;
    if (!useSplit) {
      clear();
      // The clue and touch controls keep their natural sizes. Give the map
      // the space below them and reserve the footer even before a receipt.
      const room = innerHeight - (map.getBoundingClientRect().top + scrollY) - bottom - heightAfter(map);
      const height = Math.max(192, Math.min(448, Math.floor(room))) + 'px';
      if (grid.style.getPropertyValue('--round-map-height') !== height) grid.style.setProperty('--round-map-height', height);
      return;
    }
    grid.style.removeProperty('--round-map-height');
    if (grid.dataset.roundFrame !== 'split') grid.dataset.roundFrame = 'split';
    // Measure intrinsic header rows before giving both sides their shared height.
    grid.style.removeProperty('--round-head-height');
    const head = (viewport: HTMLElement, panel: HTMLElement) =>
      viewport.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    const mapMinimum = Math.max(shortLandscape ? 308 : 384, Math.min(512, width * .36));
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
    const maxWidth = Math.floor(width - gap - mapMinimum);
    const minWidth = Math.min(maxWidth, shortLandscape ? 320 : 400);
    const room = innerHeight - (left.getBoundingClientRect().top + scrollY) - bottom;
    const px = (value: number) => Math.round(value * 100) / 100 + 'px';
    const setSize = (key: string, number: number) => {
      const value = px(number);
      if (grid.style.getPropertyValue(key) !== value) grid.style.setProperty(key, value);
    };
    // A smaller width can add or remove a row of controls. Measure at each
    // candidate width before paint and only shrink during this fit.
    let clueWidth = maxWidth;
    for (;;) {
      setSize('--round-clue-width', clueWidth);
      setSize('--round-canvas-height', clueWidth / 2.25);
      const clueHead = head(clue, left), mapHead = head(map, right), top = Math.max(clueHead, mapHead);
      const footer = Math.max(heightAfter(clue), heightAfter(map));
      const fitsWidth = Math.max(minWidth, Math.floor((room - top - footer) * 2.25));
      if (fitsWidth >= clueWidth) {
        setSize('--round-head-height', top);
        break;
      }
      clueWidth = fitsWidth;
    }
  };
  function queue() { if (!stopped && !frame) frame = requestAnimationFrame(fit); }
  const mutation = new MutationObserver(records => {
    if (records.some(record => {
      if (record.target instanceof Element && record.target.closest('.map-board')) return false;
      if (record.type === 'attributes') return record.oldValue !== (record.target as Element).getAttribute(record.attributeName!);
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE);
    })) queue();
  });
  mutation.observe(grid, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class', 'data-clock'] });
  window.addEventListener('resize', queue); queue();
  return () => { stopped = true; resize?.disconnect(); mutation.disconnect(); watched.clear(); window.removeEventListener('resize', queue); if (frame) cancelAnimationFrame(frame); };
}
