import { bindAttribute, clearTextBinding, formatGuessrNumber } from './i18n';

/** Shared by the Continue game card and every live game header. */
export function roundProgress(total: number, current: number, completed = current - 1): HTMLElement {
  const element = document.createElement('span'); element.className = 'lobby-rounds';
  element.setAttribute('role', 'progressbar'); element.setAttribute('aria-valuemin', '0');
  bindAttribute(element, 'aria-label', 'Completed rounds');
  updateRoundProgress(element, total, current, completed);
  return element;
}

export function updateRoundProgress(element: HTMLElement, total: number, current: number, completed = current - 1): void {
  total = Math.max(1, total); current = Math.max(1, Math.min(total, current)); completed = Math.max(0, Math.min(total, completed));
  const signature = `${total}/${current}/${completed}`;
  if (element.dataset.progress === signature) return;
  element.dataset.progress = signature;
  element.setAttribute('aria-valuemax', String(total)); element.setAttribute('aria-valuenow', String(completed));
  bindAttribute(element, 'aria-valuetext', '{{completed}} of {{total}} rounds completed', () => ({ completed: formatGuessrNumber(completed), total: formatGuessrNumber(total) }));
  bindAttribute(element, 'title', 'Round {{value1}} of {{value2}}', () => ({ value1: formatGuessrNumber(current), value2: formatGuessrNumber(total) }));
  if (element.children.length !== total) element.replaceChildren(...Array.from({ length: total }, () => document.createElement('span')));
  [...element.children].forEach((segment, index) => {
    const state = index < completed ? 'complete' : index === current - 1 ? 'current' : '';
    if (segment.className !== state) segment.className = state;
  });
}

export function showRoundProgress(container: HTMLElement, total: number, current: number, completed = current - 1): void {
  let progress = container.querySelector<HTMLElement>(':scope > .lobby-rounds');
  if (!progress) { clearTextBinding(container); progress = roundProgress(total, current, completed); container.replaceChildren(progress); }
  else updateRoundProgress(progress, total, current, completed);
}
