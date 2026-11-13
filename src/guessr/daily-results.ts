import type { DailyResultSummary, RankedState } from './api';
import { ClueViewport } from './clue-viewport';
import { bindAttribute, bindText, formatGuessrNumber, guessrGameTerm, tr } from './i18n';
import { localizedDistance } from './messages';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; return node;
}
function numberCell(value: number | null | undefined, score = false, round = false): HTMLTableCellElement {
  const cell = element('td', score ? 'numeric score' : 'numeric');
  cell.classList.toggle('score-perfect', round && value === 5000);
  bindText(cell, () => value === null || value === undefined ? '—' : formatGuessrNumber(value)); return cell;
}
function subtotal(results: NonNullable<RankedState['results']> | DailyResultSummary['results'], key: 'area_score' | 'position_score'): number | null {
  return results.some(result => result.guess && typeof result.guess[key] !== 'number')
    ? null : results.reduce((sum, result) => sum + (result.guess?.[key] ?? 0), 0);
}

/** Score-only sharing must not construct previews or start image requests. */
export function dailyScoreTable(state: DailyResultSummary): HTMLElement {
  const wrap = element('div', 'table-wrap'), table = element('table', 'table daily-results-table');
  const caption = element('caption', 'sr-only'); bindText(caption, 'Daily result');
  const thead = element('thead'), head = element('tr'), body = element('tbody');
  for (const label of ['Round', 'Area', 'Proximity', 'Points']) {
    const cell = element('th', 'numeric'); cell.scope = 'col'; bindText(cell, label); head.append(cell);
  }
  thead.append(head);
  for (const result of [...state.results].sort((a, b) => a.ordinal - b.ordinal)) {
    const row = element('tr');
    row.append(numberCell(result.ordinal + 1), numberCell(result.guess?.area_score),
      numberCell(result.guess?.position_score), numberCell(result.guess?.score ?? 0, true, true));
    body.append(row);
  }
  const foot = element('tfoot'), totals = element('tr'), label = element('th'); label.scope = 'row'; bindText(label, 'Total');
  totals.append(label, numberCell(subtotal(state.results, 'area_score')), numberCell(subtotal(state.results, 'position_score')), numberCell(state.score, true));
  foot.append(totals); table.append(caption, thead, body, foot); wrap.append(table);
  return wrap;
}

/** Reuses the exact starting crop and prepared Pages images. No new game/API
 * requests are needed to render a completed Daily or its previews. */
export function dailyResultsTable(state: RankedState, review: (ordinal: number) => void) {
  const wrap = element('div', 'table-wrap'), table = element('table', 'table table-hover daily-results-table');
  const caption = element('caption', 'sr-only'); bindText(caption, 'Daily result');
  const thead = element('thead'), head = element('tr');
  for (const [index, label] of ['Round', 'Location', 'Distance', 'Area', 'Proximity', 'Points', 'Review'].entries()) {
    const cell = element('th', index === 0 || index >= 3 && index <= 5 ? 'numeric' : ''); cell.scope = 'col';
    if (index === 6) { const text = element('span', 'sr-only'); bindText(text, label); cell.append(text); }
    else bindText(cell, label);
    head.append(cell);
  }
  thead.append(head); table.append(caption, thead);
  const body = element('tbody'), previews: ClueViewport[] = [];
  const results = [...state.results ?? []].sort((a, b) => a.ordinal - b.ordinal);
  for (const result of results) {
    const row = element('tr'), location = element('td'), identity = element('div', 'result-location');
    const preview = element('div', 'result-preview'), clue = element('div', 'clue loading');
    clue.setAttribute('aria-hidden', 'true');
    const open = element('button', 'btn result-preview-open'); open.type = 'button';
    const label = () => tr('Review {{round}}: {{location}}', {
      round: formatGuessrNumber(result.ordinal + 1), location: guessrGameTerm(result.name),
    });
    bindAttribute(open, 'aria-label', label); open.onclick = () => review(result.ordinal);
    preview.append(clue, open);
    const unavailable = () => {
      clue.classList.remove('loading');
      const fallback = element('span', 'result-preview-fallback'); bindText(fallback, 'Review'); clue.replaceChildren(fallback);
    };
    if (result.clue) {
      const viewport = new ClueViewport(clue, result.clue); previews.push(viewport);
      void viewport.show({ dx: 0, dy: 0, level: 0 }).catch(() => {
        viewport.destroy(); if (wrap.isConnected) unavailable();
      });
    } else unavailable();
    const name = element('span'); bindText(name, () => guessrGameTerm(result.name));
    identity.append(preview, name); location.append(identity);
    const distance = element('td', 'result-distance'); bindText(distance, () => localizedDistance(result.guess?.distance ?? null));
    const action = element('td', 'result-action'), button = element('button', 'small secondary'); button.type = 'button';
    bindText(button, 'Review'); bindAttribute(button, 'aria-label', label); button.onclick = () => review(result.ordinal); action.append(button);
    row.append(numberCell(result.ordinal + 1), location, distance, numberCell(result.guess?.area_score),
      numberCell(result.guess?.position_score), numberCell(result.guess?.score ?? 0, true, true), action);
    body.append(row);
  }
  const foot = element('tfoot'), totals = element('tr'), totalLabel = element('th'); totalLabel.colSpan = 3; totalLabel.scope = 'row';
  bindText(totalLabel, 'Total');
  totals.append(totalLabel, numberCell(subtotal(results, 'area_score')), numberCell(subtotal(results, 'position_score')),
    numberCell(state.score ?? results.reduce((sum, result) => sum + (result.guess?.score ?? 0), 0), true), element('td'));
  foot.append(totals); table.append(body, foot); wrap.append(table);
  return { element: wrap, destroy: () => previews.forEach(preview => preview.destroy()) };
}
