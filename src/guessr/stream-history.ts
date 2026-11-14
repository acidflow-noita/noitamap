import { StreamApi } from './stream-api';
import { StreamResultArchive, type ArchivedStreamResult } from './stream-result-archive';
import { streamHostName } from './stream-display-name';
import { bindText, formatGuessrNumber, guessrLocale } from './i18n';
import { localizedError } from './messages';
import { guessRouteUrl } from './routes';
import { readPublishedStreamVisits } from './stream-history-records';

interface HistoryRow {
  id: string; finishedAt: number; hostName: string; channel: string;
  players: number | null; published: boolean; pending: boolean;
}

/** One indexed request per requested page. Local unpublished games remain
 * discoverable; neither pagination nor rendering fetches individual results. */
export async function streamHistorySection(main: HTMLElement, channel?: string): Promise<void> {
  const section = document.createElement('section'); section.className = 'stream-history';
  if (!channel) {
    const heading = document.createElement('h2'); bindText(heading, 'Multiplayer results'); section.append(heading);
  }
  const status = document.createElement('p'); status.className = 'fine-print'; status.setAttribute('role', 'status');
  bindText(status, 'Loading results…'); section.append(status); main.append(section);
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'table stream-score-table';
  const head = document.createElement('tr'), thead = document.createElement('thead'), body = document.createElement('tbody');
  for (const label of channel ? ['Date', 'Players', 'Results'] : ['Date', 'Created by', 'Players', 'Results']) {
    const cell = document.createElement('th'); cell.scope = 'col';
    if (label === 'Players') cell.className = 'numeric';
    bindText(cell, label); head.append(cell);
  }
  thead.append(head); table.append(thead, body); wrap.append(table); section.append(wrap);
  const more = document.createElement('button'); more.className = 'btn btn-outline theme-secondary'; more.type = 'button'; more.hidden = true;
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
    const count = document.createElement('td'); count.className = 'numeric';
    bindText(count, () => game.players === null ? '—' : formatGuessrNumber(game.players));
    const result = document.createElement('td'), open = document.createElement('a'); open.className = 'btn btn-sm btn-outline theme-secondary';
    open.href = guessRouteUrl('stream-result', location.origin, { result: game.id }).href;
    bindText(open, game.pending ? 'Retry publishing' : 'View results'); result.append(open);
    if (!game.published) {
      const note = document.createElement('div'); note.className = 'fine-print';
      bindText(note, 'Saved on this device. Not published yet.'); result.append(note);
    }
    line.append(count, result); return line;
  };
  const render = () => {
    if (!main.isConnected) return;
    const entries = new Map<string, HistoryRow>();
    const localRows = visibleLocal();
    for (const game of localRows.slice(0, localLimit)) entries.set(game.id, game);
    for (const [id, game] of remote) entries.set(id, game);
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
}
