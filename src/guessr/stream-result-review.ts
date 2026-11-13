import { ClueViewport } from './clue-viewport';
import { sharedRoundResults } from './stream-round-results';
import { resultClue, resultMapConfig, resultRoundView } from './result-review-data';
import type { ImageGameConfig } from './image-game';
import type { StreamResult } from './stream-types';
import type { StreamRoundView } from './stream-round-data';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, tr } from './i18n';

/** Results expand in document flow. Opening a review never enters live play. */
export function streamResultReviews(result: StreamResult, fallback?: ImageGameConfig) {
  return roundResultReviews(result.rounds.map((_, index) => resultRoundView(result, index)), resultMapConfig(result, fallback));
}

/** Bootstrap 6 uses native details/summary accordions. Independent disclosures
 * do not collapse a different round above the reader and move the clicked row. */
export function roundResultReviews(rounds: StreamRoundView[], config?: ImageGameConfig, openRounds: number[] = []) {
  let destroyed = false;
  const element = document.createElement('div'); element.className = 'accordion stream-result-reviews';
  const destroyers: (() => void)[] = [];
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); loads.get(entry.target)?.(); }
  }, { rootMargin: '100px' });
  const loads = new Map<Element, () => void>();
  rounds.forEach(data => {
    const item = document.createElement('details'); item.className = 'accordion-item'; item.dataset.round = String(data.round);
    const toggle = document.createElement('summary'); toggle.className = 'accordion-header';
    const panel = document.createElement('div'); panel.className = 'accordion-body';
    const thumb = document.createElement('div'); thumb.className = 'stream-round-thumbnail'; thumb.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    bindText(label, () => `${tr('Round {{round}}', { round: formatGuessrNumber(data.round) })}: ${guessrGameTerm(data.label)}`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16'); icon.setAttribute('class', 'accordion-icon'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'm3 6 5 5 5-5'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
    icon.append(path);
    toggle.append(thumb, label, icon); item.append(toggle, panel); element.append(item);
    const clue = config && resultClue(config, data.answer);
    const unavailable = (target: HTMLElement) => {
      const text = bindText(document.createElement('span'), 'Preview unavailable'); text.className = 'stream-preview-unavailable'; target.replaceChildren(text);
    };
    if (clue) {
      const viewport = new ClueViewport(thumb, clue); destroyers.push(() => viewport.destroy());
      loads.set(thumb, () => { void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => unavailable(thumb)); });
      if (observer) observer.observe(thumb); else loads.get(thumb)!();
    } else unavailable(thumb);
    let closeReview: (() => void) | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      clearTimeout(closeTimer);
      if (destroyed) return;
      if (closeReview) return;
      const preview = document.createElement('div'); preview.className = 'stream-round-preview clue loading';
      bindAttribute(preview, 'aria-label', 'Round {{round}} clue', { round: formatGuessrNumber(data.round) });
      const viewport = clue ? new ClueViewport(preview, clue) : undefined;
      if (viewport) void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => unavailable(preview)); else unavailable(preview);
      const cleanup = config ? sharedRoundResults(panel, config, data, document.createElement('div'), { inline: true, clue: preview }) : undefined;
      if (!config) panel.append(preview);
      closeReview = () => { cleanup?.(); viewport?.destroy(); panel.replaceChildren(); closeReview = undefined; };
    };
    // Prepare content before the browser starts its native downward transition.
    toggle.addEventListener('click', () => { if (!item.open) open(); });
    item.addEventListener('toggle', () => {
      if (destroyed) return;
      if (item.open) open();
      else closeTimer = setTimeout(() => { if (!item.open) closeReview?.(); }, 250);
    });
    if (openRounds.includes(data.round)) { open(); item.open = true; }
    destroyers.push(() => { clearTimeout(closeTimer); closeReview?.(); });
  });
  return { element, destroy() {
    destroyed = true;
    observer?.disconnect(); destroyers.forEach(destroy => destroy());
  } };
}
