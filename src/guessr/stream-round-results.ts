import { mapControls } from './map-controls';
import { MapBoard } from './map-board';
import { streamRoundData, type StreamRoundView } from './stream-round-data';
import type { ImageGameConfig } from './image-game';
import type { StreamGame } from './stream-types';
import { bindText, formatGuessrNumber, guessrGameTerm, guessrLocale, onGuessrLanguageChanged, tr } from './i18n';
import { playerColor } from './player-color';

export function streamRoundResults(main: HTMLElement, game: StreamGame, index: number, actions: HTMLElement): () => void {
  return sharedRoundResults(main, game.session.config, streamRoundData(game, index), actions);
}
export function sharedRoundResults(main: HTMLElement, config: ImageGameConfig, data: StreamRoundView, actions: HTMLElement): () => void {
  const index = data.round - 1;
  const grid = document.createElement('div'); grid.className = 'game-grid stream-round-results-layout';
  const mapPanel = document.createElement('section'); mapPanel.className = 'game-panel';
  const mapTitle = document.createElement('div'); mapTitle.className = 'panel-bar';
  bindText(mapTitle, () => guessrGameTerm(data.label));
  const map = document.createElement('div'); map.className = 'map-board';
  mapPanel.append(mapTitle, map);
  const scores = document.createElement('section'); scores.className = 'game-panel';
  const heading = document.createElement('div'); heading.className = 'panel-bar';
  bindText(heading, 'Round {{round}} results', { round: formatGuessrNumber(index + 1) });
  const wrap = document.createElement('div'); wrap.className = 'stream-round-score-scroll';
  const table = document.createElement('table'); table.className = 'table stream-score-table stream-round-score-table';
  const head = document.createElement('thead'), header = document.createElement('tr'), body = document.createElement('tbody');
  head.append(header); table.append(head, body); wrap.append(table); scores.append(heading, wrap, actions); grid.append(mapPanel, scores); main.append(grid);
  const board = new MapBoard(map, config.bounds, config.overview, () => {}, config.map); board.setLocked(true);
  mapPanel.insertBefore(mapControls(board), map);
  const rows = new Map<string, HTMLTableRowElement>();
  let selected: string | undefined;
  const select = (id: string) => {
    if (selected) rows.get(selected)?.classList.remove('selected');
    selected = id; rows.get(id)?.classList.add('selected'); board.highlightPlayer(id);
  };
  const players = data.players;
  const roundOrder = [...players].sort((a, b) => b.score - a.score || b.total - a.total);
  const ranks = new Map<string, number>();
  roundOrder.forEach((p, i) => ranks.set(p.id, i && p.score === roundOrder[i - 1].score
    ? ranks.get(roundOrder[i - 1].id)! : i + 1));
  board.setPlayers(players.map(p => ({ id: p.id, name: p.name, color: playerColor(p, data.host.id), guess: p.guess })), data.answer, select);
  let sort: 'rank' | 'name' | 'round' | 'total' = 'round', direction = -1;
  const columns = [['rank', 'Rank'], ['name', 'Player'], ['round', 'Round score'], ['total', 'Total']] as const;
  const headers: HTMLTableCellElement[] = [];
  for (const [key, label] of columns) {
    const th = document.createElement('th'), button = document.createElement('button');
    th.scope = 'col'; if (key !== 'name') th.className = 'numeric';
    button.type = 'button'; button.className = 'stream-table-sort'; bindText(button, label);
    button.onclick = () => { direction = sort === key ? -direction : key === 'rank' || key === 'name' ? 1 : -1; sort = key; render(); };
    th.append(button); header.append(th); headers.push(th);
  }
  function render() {
    columns.forEach(([key], i) => headers[i].setAttribute('aria-sort', key === sort ? direction === 1 ? 'ascending' : 'descending' : 'none'));
    const ordered = [...players].sort((a, b) => direction * (sort === 'name' ? a.name.localeCompare(b.name, guessrLocale())
      : sort === 'rank' ? ranks.get(a.id)! - ranks.get(b.id)! : sort === 'round' ? a.score - b.score : a.total - b.total));
    rows.clear(); const fragment = document.createDocumentFragment();
    for (const player of ordered) {
      const row = document.createElement('tr'); row.tabIndex = 0; row.dataset.player = player.id;
      if (player.id === data.host.id) row.classList.add('stream-host-row');
      if (player.id === selected) row.classList.add('selected');
      row.onmouseenter = row.onfocus = row.onclick = () => select(player.id);
      row.onmouseleave = row.onblur = () => { rows.get(player.id)?.classList.remove('selected'); selected = undefined; board.highlightPlayer(''); };
      for (const [column, text] of [formatGuessrNumber(ranks.get(player.id)!), player.name,
        player.guess ? formatGuessrNumber(player.score) : '—', formatGuessrNumber(player.total)].entries()) {
        const cell = document.createElement('td'); cell.textContent = text;
        if (column !== 1) cell.className = 'numeric';
        if (column === 2 && player.score === 5000) cell.classList.add('score-perfect');
        else cell.style.color = playerColor(player, data.host.id);
        if (column === 2 && !player.guess) cell.setAttribute('aria-label', tr('No guess recorded by the streamer'));
        row.append(cell);
      }
      rows.set(player.id, row); fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  render(); const unsubscribe = onGuessrLanguageChanged(render);
  return () => { unsubscribe(); board.destroy(); };
}
