import { bindAttribute, bindText, formatGuessrNumber, tr } from './i18n';
import { playerColor } from './player-color';
import { featureLabel } from './release-features';
import type { StreamPlayer } from './stream-types';

interface SummaryScore extends StreamPlayer {
  rank: number;
  total: number;
  roundScore?: number | null;
}

/** Keep the streamer and the current viewer in rank order, independent of the full table's sort and filter. */
export function scoreSummary(players: readonly SummaryScore[], streamer: string, viewer: string | undefined,
  jump: (id: string) => void): HTMLElement | undefined {
  if (!streamer || players.length <= 2) return;
  const featured = players.filter(p => p.id === streamer || p.id === viewer).sort((a, b) => a.rank - b.rank);
  if (!featured.length) return;
  const section = document.createElement('section');
  section.className = 'score-summary';
  const title = document.createElement('h3');
  title.append(featureLabel('scoreSummary'));
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap stream-score-frame rounded-9';
  const table = document.createElement('table');
  table.className = 'table stream-score-table score-summary-table';
  bindAttribute(table, 'aria-label', 'Score summary');
  const round = featured[0].roundScore !== undefined;
  const head = table.createTHead().insertRow();
  for (const label of round ? ['Rank', 'Player', 'Round score', 'Total'] : ['Rank', 'Player', 'Total']) {
    const th = bindText(document.createElement('th'), label);
    th.scope = 'col';
    if (label !== 'Player') th.className = 'numeric';
    head.append(th);
  }
  const body = table.createTBody();
  for (const [index, p] of featured.entries()) {
    if (index && p.rank > featured[index - 1].rank + 1) {
      const gap = body.insertRow(); gap.className = 'score-summary-gap'; gap.setAttribute('aria-hidden', 'true');
      const cell = gap.insertCell(); cell.colSpan = head.cells.length; cell.textContent = '…';
    }
    const row = body.insertRow(); row.dataset.player = p.id;
    row.classList.toggle('stream-host-row', p.id === streamer);
    row.classList.toggle('stream-viewer-row', p.id === viewer);
    const number = (n: number | null) => {
      const cell = row.insertCell(); cell.className = 'numeric';
      return bindText(cell, () => n === null ? '—' : formatGuessrNumber(n));
    };
    number(p.rank);
    const name = row.insertCell();
    const button = document.createElement('button'); button.type = 'button'; button.className = 'score-summary-jump';
    button.style.color = playerColor(p, streamer);
    button.append(bindText(document.createElement('span'), () => p.name +
      (p.id === streamer ? tr(', Streamer') : '') + (p.id === viewer ? tr(', You') : '')));
    const arrow = document.createElement('i'); arrow.className = 'bi bi-arrow-down'; arrow.setAttribute('aria-hidden', 'true');
    button.append(arrow); name.append(button);
    const destination = () => tr('Show {{player}} in the full table', { player: p.name });
    bindAttribute(button, 'aria-label', destination); bindAttribute(button, 'title', destination);
    row.onclick = () => jump(p.id);
    if (round) number(p.roundScore ?? null).classList.toggle('score-perfect', p.roundScore === 5000);
    number(p.total);
  }
  wrap.append(table); section.append(title, wrap);
  return section;
}

export function focusScoreRow(row?: HTMLTableRowElement) {
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
}
