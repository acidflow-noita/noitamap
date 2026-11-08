import { bindAttribute, bindText, formatGuessrNumber, tr } from './i18n';
import { maximumScore, type ClueProgress } from './rules';
import type { AreaDifficulty } from './area-rules';

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
  return value;
}
export function updateRoundIndicators(root: ParentNode, progress: ClueProgress, tier?: AreaDifficulty | null) {
  updateDifficultyIndicators(root, tier);
  for (const value of root.querySelectorAll<HTMLOutputElement>('[data-clue-maximum]'))
    updateLabel(value, () => tr('Up to {{points}} points', {
      count: maximumScore(progress), points: formatGuessrNumber(maximumScore(progress)),
    }));
}
