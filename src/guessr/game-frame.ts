/** Fit the fixed clue crop and guess map without changing either camera. */
export function fitGameFrame(grid: HTMLElement): () => void {
  let frame = 0, stopped = false;
  const fit = () => {
    frame = 0;
    if (stopped || !grid.isConnected) return;
    const clue = grid.querySelector<HTMLElement>('.clue-stage') ?? grid.querySelector<HTMLElement>('.clue');
    const map = grid.querySelector<HTMLElement>('.game-panel--map > .map-board, .stream-picker > .map-board');
    const left = clue?.closest<HTMLElement>('.game-panel'), right = map?.closest<HTMLElement>('.game-panel');
    if (!clue || !map || !left || !right || left.hidden || right.hidden || grid.clientWidth < 960 || innerWidth < 1024) {
      delete grid.dataset.roundFrame;
      return;
    }
    grid.dataset.roundFrame = 'split';
    const head = (viewport: HTMLElement, panel: HTMLElement) =>
      viewport.getBoundingClientRect().top - panel.getBoundingClientRect().top - (parseFloat(getComputedStyle(viewport).marginTop) || 0);
    const clueHead = head(clue, left), mapHead = head(map, right), top = Math.max(clueHead, mapHead);
    const available = innerHeight - left.getBoundingClientRect().top - top - 64;
    const mapMinimum = Math.max(384, Math.min(512, grid.clientWidth * .36));
    const width = Math.floor(Math.min(grid.clientWidth - 16 - mapMinimum, Math.max(400, available * 2.25)));
    for (const [key, value] of Object.entries({
      '--round-clue-width': width + 'px', '--round-canvas-height': width / 2.25 + 'px',
      '--clue-head-gap': Math.max(0, top - clueHead) + 'px', '--map-head-gap': Math.max(0, top - mapHead) + 'px',
    })) if (grid.style.getPropertyValue(key) !== value) grid.style.setProperty(key, value);
  };
  const queue = () => { if (!stopped && !frame) frame = requestAnimationFrame(fit); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(queue) : undefined;
  const mutation = new MutationObserver(records => {
    if (records.some(record => !(record.target instanceof Element && record.target.closest('.map-board'))
      && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE))) queue();
  });
  resize?.observe(grid); mutation.observe(grid, { childList: true, subtree: true });
  window.addEventListener('resize', queue); queue();
  return () => { stopped = true; resize?.disconnect(); mutation.disconnect(); window.removeEventListener('resize', queue); if (frame) cancelAnimationFrame(frame); };
}
