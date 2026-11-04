import { StreamApi } from './stream-api';
import { StreamResultArchive } from './stream-result-archive';
import { bindText, formatGuessrNumber, guessrLocale, tr } from './i18n';
import { guessRouteUrl } from './routes';
import { readPublishedStreamVisits } from './stream-history-records';

export async function streamHistorySection(main: HTMLElement, channel?: string): Promise<void> {
  const section = document.createElement('section'), heading = document.createElement('h2');
  bindText(heading, () => channel ? tr('{{player}}’s results', { player: channel }) : tr('Chat vs Streamer'));
  const status = document.createElement('p'); bindText(status, 'Loading results…');
  section.append(heading, status); main.append(section);
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'table stream-score-table';
  const head = document.createElement('tr'), thead = document.createElement('thead'), body = document.createElement('tbody');
  for (const label of ['Date', 'Streamer', 'Players', 'Results']) {
    const cell = document.createElement('th'); cell.scope = 'col'; bindText(cell, label); head.append(cell);
  }
  thead.append(head); table.append(thead, body); wrap.append(table); section.append(wrap);
  const row = (id: string, finishedAt: number, hostName: string, hostLogin: string, players: number | null, published: boolean, pending = false) => {
    const line = document.createElement('tr');
    const date = document.createElement('td'); bindText(date, () => new Date(finishedAt).toLocaleString(guessrLocale()));
    const host = document.createElement('td'), link = document.createElement('a'); link.textContent = hostName;
    const url = guessRouteUrl('history', location.origin); url.searchParams.set('channel', hostLogin); link.href = url.href; host.append(link);
    const count = document.createElement('td'); count.className = 'numeric'; bindText(count, () => players === null ? '—' : formatGuessrNumber(players));
    const result = document.createElement('td'), open = document.createElement('a'); open.className = 'secondary';
    open.href = guessRouteUrl('stream-result', location.origin, { result: id }).href;
    bindText(open, pending ? 'Retry publishing' : 'View results'); result.append(open);
    if (!published) { const note = document.createElement('div'); note.className = 'fine-print'; bindText(note, 'Saved on this device. Not published yet.'); result.append(note); }
    line.append(date, host, count, result); body.append(line);
  };
  try {
    if (!channel) {
      const entries = await new StreamResultArchive().list();
      if (!main.isConnected) return;
      for (const entry of entries) row(entry.result.id, entry.result.finishedAt, entry.result.host.name, entry.result.host.login,
        entry.result.players.length, entry.published, !!entry.pendingToken);
      for (const game of readPublishedStreamVisits()) if (!entries.some(entry => entry.result.id === game.id))
        row(game.id, game.at, game.channel, game.channel, null, true);
      bindText(status, body.childElementCount ? 'Select a streamer to see their saved game results.' : 'No completed games yet.');
    } else {
      const api = new StreamApi(), more = document.createElement('button'); more.className = 'secondary'; more.type = 'button'; bindText(more, 'Load more');
      let cursor: string | undefined;
      const load = async () => {
        more.disabled = true;
        try {
          const page = await api.history(channel, cursor);
          if (!main.isConnected) return;
          for (const game of page.games) row(game.id, game.finishedAt, game.hostName, channel, game.players, true);
          cursor = page.next; more.hidden = !cursor;
          wrap.hidden = !body.childElementCount; bindText(more, 'Load more');
          status.hidden = !!body.childElementCount;
          bindText(status, 'No published game results yet.');
        } catch (error) {
          status.hidden = false; bindText(status, (error as Error).message);
          more.hidden = false; bindText(more, 'Try again');
        } finally { more.disabled = false; }
      };
      more.onclick = () => { void load(); }; section.append(more); await load();
    }
    wrap.hidden = !body.childElementCount;
  } catch (error) { bindText(status, (error as Error).message); wrap.hidden = true; }
}
