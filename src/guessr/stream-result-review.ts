import { revealReviewPreview, reviewAccordionHeader } from './review-accordion-header';
import { ClueViewport } from './clue-viewport';
import { sharedRoundResults } from './stream-round-results';
import { resultClue, resultMapConfig, resultRoundView } from './result-review-data';
import type { ImageGameConfig } from './image-game';
import type { StreamResult } from './stream-types';
import type { StreamRoundView } from './stream-round-data';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, tr } from './i18n';
import type { ReplayLoader } from './clue-replay';

/** Results expand in document flow. Opening a review never enters live play. */
export function streamResultReviews(result: StreamResult, fallback?: ImageGameConfig, readReplay?: ReplayLoader) {
  return roundResultReviews(result.rounds.map((_, index) => resultRoundView(result, index)), resultMapConfig(result, fallback),
    [], readReplay);
}

/** Bootstrap 6 uses native details/summary accordions. Independent disclosures
 * do not collapse a different round above the reader and move the clicked row. */
export function roundResultReviews(rounds: StreamRoundView[], config?: ImageGameConfig, openRounds: number[] = [], readReplay?: ReplayLoader) {
  let destroyed = false;
  const element = document.createElement('div'); element.className = 'accordion stream-result-reviews';
  const destroyers: (() => void)[] = [];
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); loads.get(entry.target)?.(); }
  }, { rootMargin: '100px' });
  const loads = new Map<Element, () => void>();
  let group: HTMLElement;
  rounds.forEach((data, index) => {
    if (index % 5 === 0) {
      group = document.createElement('div'); group.className = 'round-review-group';
      group.style.setProperty('--review-round-count', String(Math.min(5, rounds.length - index))); element.append(group);
    }
    const item = document.createElement('details'); item.className = 'accordion-item rounded-9'; item.dataset.round = String(data.round);
    const { toggle, thumb } = reviewAccordionHeader(
      () => tr('Round {{round}}', { round: formatGuessrNumber(data.round) }) + ': ', () => guessrGameTerm(data.label));
    const panel = document.createElement('div'); panel.className = 'accordion-body rounded-9';
    item.append(toggle, panel); group.append(item);
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
      const preview = document.createElement('div'); preview.className = 'stream-round-preview clue loading border rounded-9 overflow-hidden';
      bindAttribute(preview, 'aria-label', 'Round {{round}} clue', { round: formatGuessrNumber(data.round) });
      const viewport = clue ? new ClueViewport(preview, clue) : undefined;
      if (viewport) void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => unavailable(preview)); else unavailable(preview);
      const cleanup = config ? sharedRoundResults(panel, config, data, document.createElement('div'), { inline: true, clue: preview, readReplay }) : undefined;
      if (!config) panel.append(preview);
      closeReview = () => { cleanup?.(); viewport?.destroy(); panel.replaceChildren(); closeReview = undefined; };
    };
    // Prepare content before the browser starts its native downward transition.
    toggle.addEventListener('click', () => {
      if (item.open) return;
      open();
      const preview = panel.querySelector<HTMLElement>('.stream-round-preview');
      if (preview) revealReviewPreview(preview, toggle);
    });
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
