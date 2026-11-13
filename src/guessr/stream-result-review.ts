import Collapse from 'bootstrap/js/dist/collapse.js';
import { ClueViewport } from './clue-viewport';
import { sharedRoundResults } from './stream-round-results';
import { resultClue, resultMapConfig, resultRoundView } from './result-review-data';
import type { ImageGameConfig } from './image-game';
import type { StreamResult } from './stream-types';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, tr } from './i18n';

let sequence = 0;
/** Results expand in document flow. Opening a review never enters live play. */
export function streamResultReviews(result: StreamResult, fallback?: ImageGameConfig) {
  const element = document.createElement('div'); element.className = 'accordion stream-result-reviews';
  element.id = `guessr-round-reviews-${++sequence}`;
  const config = resultMapConfig(result, fallback);
  const destroyers: (() => void)[] = [];
  const panels: HTMLElement[] = [];
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); loads.get(entry.target)?.(); }
  }, { rootMargin: '100px' });
  const loads = new Map<Element, () => void>();
  result.rounds.forEach((round, index) => {
    const item = document.createElement('section'); item.className = 'accordion-item';
    const heading = document.createElement('h2'); heading.className = 'accordion-header';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'accordion-button collapsed';
    const panel = document.createElement('div'); panel.className = 'accordion-collapse collapse'; panel.id = `${element.id}-${index}`;
    toggle.dataset.bsToggle = 'collapse'; toggle.dataset.bsTarget = '#' + panel.id;
    toggle.setAttribute('aria-controls', panel.id); toggle.setAttribute('aria-expanded', 'false');
    panel.dataset.bsParent = '#' + element.id;
    const thumb = document.createElement('div'); thumb.className = 'stream-round-thumbnail'; thumb.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    bindText(label, () => `${tr('Round {{round}}', { round: formatGuessrNumber(index + 1) })}: ${guessrGameTerm(round.name)}`);
    toggle.append(thumb, label); heading.append(toggle); item.append(heading, panel); element.append(item); panels.push(panel);
    const clue = config && resultClue(config, round.answer);
    const unavailable = (target: HTMLElement) => {
      const text = bindText(document.createElement('span'), 'Preview unavailable'); text.className = 'stream-preview-unavailable'; target.replaceChildren(text);
    };
    if (clue) {
      const viewport = new ClueViewport(thumb, clue); destroyers.push(() => viewport.destroy());
      loads.set(thumb, () => { void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => unavailable(thumb)); });
      if (observer) observer.observe(thumb); else loads.get(thumb)!();
    } else unavailable(thumb);
    let closeReview: (() => void) | undefined;
    const open = () => {
      if (closeReview) return;
      const body = document.createElement('div'); body.className = 'accordion-body'; panel.append(body);
      const preview = document.createElement('div'); preview.className = 'stream-round-preview clue loading';
      bindAttribute(preview, 'aria-label', 'Round {{round}} clue', { round: formatGuessrNumber(index + 1) });
      const viewport = clue ? new ClueViewport(preview, clue) : undefined;
      if (viewport) void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => unavailable(preview)); else unavailable(preview);
      const cleanup = config ? sharedRoundResults(body, config, resultRoundView(result, index), document.createElement('div'), { inline: true, clue: preview }) : undefined;
      if (!config) body.append(preview);
      closeReview = () => { cleanup?.(); viewport?.destroy(); panel.replaceChildren(); closeReview = undefined; };
    };
    panel.addEventListener('show.bs.collapse', open);
    panel.addEventListener('hidden.bs.collapse', () => closeReview?.());
    destroyers.push(() => closeReview?.());
  });
  return { element, destroy() {
    observer?.disconnect(); for (const panel of panels) Collapse.getInstance(panel)?.dispose(); destroyers.forEach(destroy => destroy());
  } };
}
