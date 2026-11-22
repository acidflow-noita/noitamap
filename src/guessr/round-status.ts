import { bindAttribute, bindText, formatGuessrNumber, tr } from './i18n';
import { maximumScore, type ClueProgress } from './rules';
import type { AreaDifficulty } from './area-rules';

export function formatRoundTime(seconds: number): string {
  const twoDigits = { minimumIntegerDigits: 2 };
  return `${formatGuessrNumber(Math.floor(seconds / 60), twoDigits)}:${formatGuessrNumber(seconds % 60, twoDigits)}`;
}

/** Numeric headers use the same clock face for both players. The overlay and
 * accessible name retain the translated count-in message. */
export function showRoundTime(timer: HTMLElement | null, value: number | string, countingIn = false): string {
  const numeric = typeof value === 'number';
  const text = numeric ? (countingIn ? formatGuessrNumber(value) : formatRoundTime(value)) : value;
  const label = numeric && countingIn ? tr('Starting in {{seconds}}', { seconds: text }) : text;
  if (timer) {
    if (timer.textContent !== text) timer.textContent = text;
    if (timer.dataset.clock !== String(numeric)) timer.dataset.clock = String(numeric);
    if (label !== text) timer.setAttribute('aria-label', label);
    else timer.removeAttribute('aria-label');
  }
  return label;
}

const liveLabels = new WeakMap<HTMLElement, { render: () => string }>();
function updateLabel(node: HTMLElement, render: () => string) {
  let binding = liveLabels.get(node);
  if (!binding) {
    binding = { render }; liveLabels.set(node, binding);
    bindText(node, () => binding!.render());
  } else {
    binding.render = render;
    const text = render();
    // Transport/timer refreshes must not repeatedly announce unchanged scores.
    if (node.textContent !== text) node.textContent = text;
  }
}

export function difficultyLabel(tier?: string | null): string {
  const labels: Record<string, string> = { easy: 'Easy difficulty', normal: 'Normal difficulty', hard: 'Hard difficulty' };
  return tier && Object.hasOwn(labels, tier) ? tr(labels[tier]) : `${tr('Difficulty')}: —`;
}
export function difficultyIndicator(): HTMLElement {
  const label = document.createElement('span');
  label.className = 'badge badge-subtle clue-difficulty'; label.dataset.clueDifficulty = '';
  label.hidden = true;
  return label;
}
export function updateDifficultyIndicators(root: ParentNode, tier?: string | null) {
  const labels: Record<string, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  const known = !!tier && Object.hasOwn(labels, tier);
  for (const label of root.querySelectorAll<HTMLElement>('[data-clue-difficulty]')) {
    label.hidden = !known;
    label.dataset.difficulty = known ? tier : '';
    updateLabel(label, () => known ? tr(labels[tier]) : '');
    bindAttribute(label, 'aria-label', () => difficultyLabel(tier));
  }
}
export function maximumIndicator(): HTMLOutputElement {
  const value = document.createElement('output');
  value.className = 'badge round-points round-maximum'; value.dataset.clueMaximum = '';
  value.setAttribute('aria-live', 'polite');
  const full = document.createElement('span'); full.className = 'maximum-label';
  const compact = document.createElement('span'); compact.className = 'maximum-compact'; compact.setAttribute('aria-hidden', 'true');
  value.append(full, compact);
  return value;
}
export function roundPanelHeader(...rows: HTMLElement[]): HTMLElement {
  const header = document.createElement('header');
  header.className = 'round-panel-header';
  header.append(...rows);
  return header;
}

export function clueTitleBar(maximum = maximumIndicator()): HTMLElement {
  const row = document.createElement('div'); row.className = 'panel-bar clue-title-row';
  const title = document.createElement('span'); title.className = 'panel-title';
  bindText(title, 'Where is this spot?');
  const details = document.createElement('div'); details.className = 'clue-details';
  details.append(difficultyIndicator(), maximum);
  row.append(title, details);
  return row;
}

export function updateRoundIndicators(root: ParentNode, progress: ClueProgress, tier?: AreaDifficulty | null) {
  updateDifficultyIndicators(root, tier);
  for (const value of root.querySelectorAll<HTMLOutputElement>('[data-clue-maximum]')) {
    const maximum = maximumScore(progress);
    const description = () => tr('Up to {{points}} points', { count: maximum, points: formatGuessrNumber(maximum) });
    updateLabel(value.querySelector<HTMLElement>('.maximum-label')!, description);
    bindAttribute(value, 'title', description);
    bindAttribute(value.querySelector('.maximum-compact')!, 'data-label', () => `≤ ${formatGuessrNumber(maximum)}`);
  }
}
