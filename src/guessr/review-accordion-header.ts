import { bindText } from './i18n';

/** Reveal the visual on activation, including inside a vertically scrolling score table. */
export function revealReviewPreview(preview: HTMLElement, heading: HTMLElement, scoreRow?: HTMLElement) {
  requestAnimationFrame(() => {
    if (!preview.isConnected || preview.closest('details:not([open])') || !preview.getClientRects().length) return;
    const gap = parseFloat(getComputedStyle(preview).scrollMarginBlockStart) || 0;
    const offset = (top: number, bottom: number) => {
      const rect = preview.getBoundingClientRect();
      const headingTop = heading.getBoundingClientRect().top;
      const room = bottom - top - 2 * gap;
      const rowTop = scoreRow?.getBoundingClientRect().top;
      const start = rowTop !== undefined && rect.bottom - rowTop <= room ? rowTop :
        rect.bottom - headingTop <= room ? headingTop : rect.top;
      if (start >= top + gap && rect.bottom <= bottom - gap) return 0;
      return start - top - gap;
    };
    const page = document.scrollingElement || document.documentElement;
    for (let box = preview.parentElement; box && box !== page; box = box.parentElement) {
      if (box.scrollHeight <= box.clientHeight || !['auto', 'scroll'].includes(getComputedStyle(box).overflowY))
        continue;
      const top = box.getBoundingClientRect().top + box.clientTop;
      const header = box.matches('.stream-round-score-scroll') ? box.querySelector('thead') : null;
      box.scrollTop += offset(top + (header?.getBoundingClientRect().height ?? 0), top + box.clientHeight);
    }
    const view = window.visualViewport;
    const top = view?.offsetTop ?? 0;
    const delta = offset(top, top + (view?.height ?? window.innerHeight));
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'instant' });
  });
}

/** Shared Bootstrap details/summary header for the round breakdown and its player replays. */
export function reviewAccordionHeader(context: () => string, title: () => string) {
  const toggle = document.createElement('summary');
  toggle.className = 'accordion-header rounded-9';
  const thumb = document.createElement('div');
  thumb.className = 'stream-round-thumbnail border rounded-9 overflow-hidden';
  thumb.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'round-review-label';
  label.append(bindText(document.createElement('small'), context), bindText(document.createElement('strong'), title));
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('class', 'accordion-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'm3 6 5 5 5-5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  icon.append(path);
  toggle.append(thumb, label, icon);
  return { toggle, thumb };
}
