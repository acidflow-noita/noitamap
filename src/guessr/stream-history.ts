import { StreamApi } from './stream-api';
import { StreamResultArchive, type ArchivedStreamResult } from './stream-result-archive';
import { streamHostName } from './stream-display-name';
import { bindAttribute, bindText, formatGuessrNumber, guessrLocale, tr } from './i18n';
import { localizedError } from './messages';
import { guessRouteUrl } from './routes';
import { readPublishedStreamVisits } from './stream-history-records';
import Combobox from '../bootstrap-combobox';
import { savedTwitchViewerId } from './twitch-viewer';
import { streamHistorySummary, type StreamHistorySummary } from './stream-history-summary';

interface HistoryRow {
  id: string; finishedAt: number; hostName: string; channel: string;
  players: number | null; published: boolean; pending: boolean;
  summary?: StreamHistorySummary;
}

/** One indexed request per requested page. Local unpublished games remain
 * discoverable; neither pagination nor rendering fetches individual results. */
let historyPickerId = 0;
export async function streamHistorySection(main: HTMLElement, channel?: string): Promise<() => void> {
  const section = document.createElement('section'); section.className = 'stream-history';
  if (!channel) {
    const heading = document.createElement('h2'); bindText(heading, 'Multiplayer results'); section.append(heading);
  }
  const status = document.createElement('p'); status.className = 'fine-print'; status.setAttribute('role', 'status');
  bindText(status, 'Loading results…'); section.append(status); main.append(section);
  const picker = document.createElement('div'); picker.className = 'stream-history-player'; section.append(picker);
  let selected = savedTwitchViewerId() ?? ':host', optionsKey = '', disposePicker = () => {};
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'table stream-score-table';
  const head = document.createElement('tr'), thead = document.createElement('thead'), body = document.createElement('tbody');
  for (const label of channel ? ['Date', 'Rank', 'Score', 'Results'] : ['Date', 'Created by', 'Rank', 'Score', 'Results']) {
    const cell = document.createElement('th'); cell.scope = 'col';
    if (label === 'Rank') cell.className = 'numeric stream-rank-column';
    if (label === 'Score') cell.className = 'numeric';
    bindText(cell, label); head.append(cell);
  }
  thead.append(head); table.append(thead, body); wrap.append(table); section.append(wrap);
  const more = document.createElement('button'); more.className = 'btn btn-outline theme-secondary stream-history-more'; more.type = 'button'; more.hidden = true;
  bindText(more, 'Load more'); section.append(more);
  const remote = new Map<string, HistoryRow>();
  const archive = new StreamResultArchive();
  let archived: ArchivedStreamResult[] = [], localLimit = 20;
  let local: HistoryRow[] = [], loading = !!channel, localLoaded = false, failure: unknown, cursor: string | undefined;
  const visibleLocal = () => local.filter(game => !channel || !game.published || failure);
  const confirmPublished = () => {
    for (const entry of archived) if (!entry.published && remote.has(entry.result.id)) {
      entry.published = true; delete entry.pendingToken;
      const row = local.find(game => game.id === entry.result.id);
      if (row) { row.published = true; row.pending = false; }
      // The history response confirms publication. Persist that fact locally so
      // opening an acknowledged result cannot offer a spurious upload retry.
      void archive.save(entry).catch(() => {});
    }
  };

  const row = (game: HistoryRow) => {
    const line = document.createElement('tr'); line.dataset.gameId = game.id;
    const date = document.createElement('td'), time = document.createElement('time');
    time.dateTime = new Date(game.finishedAt).toISOString();
    bindText(time, () => new Date(game.finishedAt).toLocaleString(guessrLocale(), { dateStyle: 'medium', timeStyle: 'short' }));
    date.append(time); line.append(date);
    if (!channel) {
      const host = document.createElement('td'), link = document.createElement('a'); link.textContent = game.hostName;
      link.href = guessRouteUrl('history', location.origin, { channel: game.channel }).href; host.append(link); line.append(host);
    }
    const person = game.summary?.standings.find(([id]) => id === (selected === ':host' ? game.summary?.hostId : selected));
    const rank = document.createElement('td'), score = document.createElement('td');
    rank.className = 'numeric stream-rank-column'; score.className = 'numeric';
    if (person && game.summary) {
      bindText(rank, () => `${formatGuessrNumber(person[2])} / ${formatGuessrNumber(game.players ?? game.summary!.standings.length)}`);
      bindAttribute(rank, 'aria-label', 'Rank {{rank}} of {{players}}', () => ({ rank: formatGuessrNumber(person[2]), players: formatGuessrNumber(game.players ?? game.summary!.standings.length) }));
      bindText(score, () => `${formatGuessrNumber(person[3])} / ${formatGuessrNumber(game.summary!.maximum)}`);
    } else if (game.summary) {
      rank.colSpan = 2; rank.className = 'muted'; bindText(rank, 'This player did not join the game.');
    } else { rank.textContent = '—'; score.textContent = '—'; }
    const result = document.createElement('td'), open = document.createElement('a'); open.className = 'btn btn-sm btn-outline theme-secondary';
    open.href = guessRouteUrl('stream-result', location.origin, { result: game.id }).href;
    bindText(open, game.pending ? 'Retry publishing' : 'View results'); result.append(open);
    if (!game.published) {
      const note = document.createElement('div'); note.className = 'fine-print';
      bindText(note, 'Saved on this device. Not published yet.'); result.append(note);
    }
    line.append(rank); if (rank.colSpan !== 2) line.append(score); line.append(result); return line;
  };
  const renderPicker = (entries: Iterable<HistoryRow>) => {
    const players = new Map<string, string>();
    for (const game of [...entries].sort((a, b) => b.finishedAt - a.finishedAt))
      for (const [id, name] of game.summary?.standings ?? []) if (!players.has(id)) players.set(id, name);
    if (selected !== ':host' && !players.has(selected)) players.set(selected, tr('You'));
    const names = [...players].sort((a, b) => a[1].localeCompare(b[1]));
    const key = JSON.stringify(names);
    if (key === optionsKey) return;
    optionsKey = key; disposePicker(); picker.replaceChildren();
    const label = bindText(document.createElement('span'), 'Player'); label.id = `history-player-${++historyPickerId}`;
    const container = document.createElement('div'); container.className = 'combobox';
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.className = 'btn btn-outline theme-secondary combobox-toggle'; toggle.dataset.bsToggle = 'combobox';
    toggle.setAttribute('role', 'combobox'); toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-labelledby', label.id);
    const value = document.createElement('span'); value.className = 'combobox-value'; toggle.append(value);
    const menu = document.createElement('div'); menu.className = 'menu'; menu.id = label.id + '-options';
    menu.setAttribute('role', 'listbox'); toggle.setAttribute('aria-controls', menu.id);
    const search = document.createElement('input'); search.type = 'search'; search.className = 'form-control combobox-search-input';
    bindAttribute(search, 'placeholder', 'Find a player'); bindAttribute(search, 'aria-label', 'Find a player'); menu.append(search);
    for (const [id, name] of [[':host', tr('Streamer')], ...names]) {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'menu-item';
      option.dataset.bsValue = id; option.tabIndex = -1; option.setAttribute('role', 'option');
      if (id === ':host') bindText(option, 'Streamer'); else option.textContent = name;
      option.setAttribute('aria-selected', String(selected === id)); option.classList.toggle('selected', selected === id);
      menu.append(option);
    }
    container.append(toggle, menu); picker.append(label, container);
    const combo = new Combobox(toggle, { search: true, placement: 'bottom-start' });
    bindText(value, () => selected === ':host' ? tr('Streamer') : players.get(selected) ?? tr('You'));
    const choose = (event: Event) => {
      const id = (event as Event & { value?: string }).value;
      if (id && (id === ':host' || players.has(id)) && id !== selected) { selected = id; render(); }
    };
    toggle.addEventListener('change.bs.combobox', choose);
    disposePicker = () => { combo.dispose(); toggle.removeEventListener('change.bs.combobox', choose); };
  };
  const render = () => {
    if (!main.isConnected) return;
    const entries = new Map<string, HistoryRow>();
    const localRows = visibleLocal();
    for (const game of localRows.slice(0, localLimit)) entries.set(game.id, game);
    for (const [id, game] of remote) entries.set(id, game);
    renderPicker(entries.values());
    const fragment = document.createDocumentFragment();
    for (const game of entries.values()) fragment.append(row(game));
    body.replaceChildren(fragment);
    const waiting = loading || !channel && !localLoaded;
    if (!entries.size && waiting) {
      for (let n = 0; n < 3; n++) {
        const line = document.createElement('tr'); line.className = 'placeholder-glow'; line.setAttribute('aria-hidden', 'true');
        for (let column = 0; column < head.children.length; column++) {
          const cell = document.createElement('td'), placeholder = document.createElement('span');
          placeholder.className = 'placeholder'; placeholder.style.inlineSize = column ? '5rem' : '10rem';
          cell.append(placeholder); line.append(cell);
        }
        body.append(line);
      }
    }
    wrap.hidden = !body.childElementCount;
    if (failure) { status.hidden = false; bindText(status, () => localizedError(failure)); }
    else if (waiting) { status.hidden = false; bindText(status, 'Loading results…'); }
    else {
      status.hidden = channel ? !!entries.size : false;
      bindText(status, channel ? 'No published game results yet.' : entries.size
        ? 'Select a streamer to see their saved game results.' : 'No completed games yet.');
    }
    table.setAttribute('aria-busy', String(waiting));
    more.disabled = loading || !channel && !localLoaded; more.hidden = !failure && !cursor && localRows.length <= localLimit;
    bindText(more, failure ? 'Try again' : 'Load more');
  };
  const loadLocal = async () => {
    localLoaded = false; if (!channel) failure = undefined; render();
    try {
      const entries = await archive.list(); archived = entries;
      local = entries.filter(entry => !channel || entry.result.host.login.toLowerCase() === channel).map(entry => ({
        id: entry.result.id, finishedAt: entry.result.finishedAt,
        hostName: streamHostName(entry.result.host, entry.result.players.find(player => player.id === entry.result.host.id)),
        channel: entry.result.host.login, players: entry.result.players.length,
        summary: streamHistorySummary(entry.result),
        published: entry.published, pending: !entry.published && !!entry.pendingToken,
      }));
      if (!channel) for (const game of readPublishedStreamVisits()) if (!local.some(entry => entry.id === game.id))
        local.push({ id: game.id, finishedAt: game.at, channel: game.channel, hostName: game.channel, players: null, published: true, pending: false });
      local.sort((a, b) => b.finishedAt - a.finishedAt || b.id.localeCompare(a.id));
      confirmPublished();
    } catch (error) { if (!channel) failure = error; }
    finally { localLoaded = true; render(); }
  };
  const api = new StreamApi();
  const load = async () => {
    if (!channel || !main.isConnected) return;
    loading = true; failure = undefined; render();
    try {
      const page = await api.history(channel, cursor);
      if (!main.isConnected) return;
      for (const game of page.games) remote.set(game.id, { ...game, channel, published: true, pending: false });
      cursor = page.next;
      confirmPublished();
    } catch (error) { failure = error; }
    finally { loading = false; render(); }
  };
  more.onclick = () => {
    if (loading || !channel && !localLoaded) return;
    if (!failure && visibleLocal().length > localLimit) { localLimit += 20; render(); }
    else if (channel) void load();
    else void loadLocal();
  };
  render();
  await Promise.all([loadLocal(), channel ? load() : Promise.resolve()]);
  return () => { disposePicker(); };
}
