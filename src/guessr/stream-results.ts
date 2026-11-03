import { bindAttribute, bindText, formatGuessrNumber, guessrLocale, tr } from "./i18n";
import type { StreamResult } from "./stream-types";
import { pageHeading } from './page-heading';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string | (() => string) = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) bindText(element, text);
  element.className = className;
  return element;
}
export function streamResultsView(result: StreamResult, viewerId?: string, onBack?: () => void): HTMLElement {
  const section = el("section"),
    hero = el("div", "", "finish-hero");
  const host = result.players.find((p) => p.id === result.host.id)!;
  const own = viewerId ? result.players.find(p => p.id === viewerId) : undefined;
  const featured = own ?? host;
  const title = el("h1", () => own ? tr('Your result') : viewerId ? tr('Game results') : tr('{{player}}’s results', { player: result.host.name }));
  if (onBack) {
    const back = el('button', 'Back'); back.type = 'button'; back.onclick = onBack;
    section.append(pageHeading(title, back));
  }
  hero.append(
    el("span", "Chat vs Streamer", "badge pro animation-pop twitch-mode-label"),
    ...(!onBack ? [title] : []),
    el(
      "div",
      () => viewerId && !own ? tr('No recorded guesses') : tr('Rank {{rank}} of {{players}}', { rank: formatGuessrNumber(featured.rank), players: formatGuessrNumber(result.players.length) }),
      "stream-rank",
    ),
    el(
      "p",
      () => viewerId && !own ? tr('The streamer did not record a guess from this account.') : tr('{{score}}, {{rounds}}, Equal scores share a rank.', { score: tr('{{points}} points', { points: formatGuessrNumber(featured.score), count: featured.score }), rounds: tr('{{rounds}} rounds', { rounds: formatGuessrNumber(result.rounds.length), count: result.rounds.length }) }),
    ),
  );
  section.append(hero);
  section.append(
    el(
      "p",
      "Casual game with results reported by the streamer. Area and proximity scores use the same rules for the streamer and chat.",
      "fine-print",
    ),
  );
  const controls = el("div", "", "stream-table-controls"),
    filter = el("input"),
    count = el("span", "", "muted");
  filter.type = "search";
  bindAttribute(filter, "placeholder", "Find a player");
  bindAttribute(filter, "aria-label", "Filter players by name or login");
  controls.append(filter, count);
  section.append(controls);
  const wrap = el("div", "", "table-wrap"),
    table = el("table", '', 'table stream-score-table'),
    head = el("tr"),
    tbody = el("tbody");
  let sort = "rank",
    direction = 1;
  const columns = [
    "Rank",
    "Player",
    ...result.rounds.map((_, i) => () => tr('Round {{round}}', { round: formatGuessrNumber(i + 1) })),
    "Total",
  ];
  columns.forEach((label, index) => {
    const th = el("th", "", index === 1 ? "" : "numeric"),
      button = el("button", label, "stream-table-sort");
    th.scope = 'col';
    button.type = "button";
    const key =
      index === 0
        ? "rank"
        : index === 1
          ? "name"
          : index === columns.length - 1
            ? "score"
            : String(index - 2);
    button.addEventListener("click", () => {
      direction =
        sort === key ? -direction : key === "name" || key === "rank" ? 1 : -1;
      sort = key;
      render();
    });
    th.append(button);
    head.append(th);
  });
  const thead = el("thead");
  thead.append(head);
  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  function render() {
    const query = filter.value.trim().toLocaleLowerCase();
    const rows = result.players.filter(
      (p) =>
        !query ||
        p.name.toLocaleLowerCase().includes(query) ||
        p.login.includes(query),
    );
    rows.sort(
      (a, b) =>
        direction *
          (sort === "name"
            ? a.name.localeCompare(b.name, guessrLocale())
            : sort === "rank"
              ? a.rank - b.rank
              : sort === "score"
                ? a.score - b.score
                : a.rounds[Number(sort)].score -
                  b.rounds[Number(sort)].score) || a.name.localeCompare(b.name, guessrLocale()),
    );
    const fragment = document.createDocumentFragment();
    for (const player of rows) {
      const row = el("tr");
      if (player.id === result.host.id) row.className = "stream-host-row";
      if (player.id === viewerId) row.classList.add('stream-viewer-row');
      row.append(
        el("td", () => formatGuessrNumber(player.rank), "numeric"),
        el(
          "td",
          () => player.name + (player.id === result.host.id ? tr(', Streamer') : '') + (player.id === viewerId ? tr(', You') : ''),
        ),
      );
      for (const round of player.rounds) {
        const cell = el("td", () => formatGuessrNumber(round.score), "numeric");
        bindAttribute(cell, 'title', () => tr('Area: {{area}}, Proximity: {{proximity}}', { area: formatGuessrNumber(round.areaScore), proximity: formatGuessrNumber(round.positionScore) }));
        row.append(cell);
      }
      row.append(el("td", () => formatGuessrNumber(player.score), "numeric score"));
      fragment.append(row);
    }
    tbody.replaceChildren(fragment);
    bindText(count, () => tr('{{shown}} of {{players}} players', { shown: formatGuessrNumber(rows.length), players: formatGuessrNumber(result.players.length), count: result.players.length }));
    [...head.children].forEach((th, index) => {
      const key =
        index === 0
          ? "rank"
          : index === 1
            ? "name"
            : index === columns.length - 1
              ? "score"
              : String(index - 2);
      th.setAttribute(
        "aria-sort",
        key === sort ? (direction === 1 ? "ascending" : "descending") : "none",
      );
    });
  }
  filter.addEventListener("input", render);
  render();
  return section;
}
/** A single file with embedded data, styling, filtering and sorting; no network,
 * framework, login, API credentials or session tokens are needed to read it. */
export function streamResultHtml(result: StreamResult): string {
  const host = result.players.find(player => player.id === result.host.id)!;
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const labels = {
    locale: guessrLocale(),
    title: tr('NoitaGuessr stream results'),
    heading: tr('NoitaGuessr, Chat vs Streamer'),
    rank: tr('{{player}} — rank {{rank}} of {{players}}', { player: host.name, rank: formatGuessrNumber(host.rank), players: formatGuessrNumber(result.players.length) }),
    summary: tr('{{score}}, {{rounds}}, {{date}}', { score: tr('{{points}} points', { points: formatGuessrNumber(host.score), count: host.score }), rounds: tr('{{rounds}} rounds', { rounds: formatGuessrNumber(result.rounds.length), count: result.rounds.length }), date: new Date(result.finishedAt).toLocaleString(guessrLocale()) }),
    filter: tr('Find a player'),
    columns: [tr('Rank'), tr('Player'), ...result.rounds.map((_, i) => tr('Round {{round}}', { round: formatGuessrNumber(i + 1) })), tr('Total')],
    streamer: tr(', Streamer'),
    count: tr('{{shown}} of {{players}} players', { shown: '{{shown}}', players: formatGuessrNumber(result.players.length), count: result.players.length }),
    scores: tr('Area: {{area}}, Proximity: {{proximity}}', { area: '{{area}}', proximity: '{{proximity}}' }),
    note: tr('Latest valid chat guess received before the streamer closes each round counts. Equal scores share ranks. These casual game results are reported by the streamer.'),
  };
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title><style>
  :root{color-scheme:dark;font:16px system-ui;background:#101d2c;color:#eff5ff}body{max-width:1000px;margin:32px auto;padding:16px}h1{font-size:2rem}p{color:#bbc8db}input,button{font:inherit;padding:10px;border:1px solid #617186;border-radius:8px;background:#1c3045;color:inherit}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:12px;border-bottom:1px solid #32485e}.wrap{overflow:auto}.host{background:#283955}th:not(:nth-child(2)),td:not(:nth-child(2)){text-align:right;font-variant-numeric:tabular-nums slashed-zero;font-feature-settings:"zero" 1}#rank{font-variant-numeric:tabular-nums slashed-zero;font-size:2rem;font-weight:700}th button{white-space:nowrap}small{color:#bbc8db}</style>
  <h1 id="heading"></h1><div id="rank"></div><p id="summary"></p><input id="filter" type="search"><div class="wrap"><table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div><p id="count"></p><small id="note"></small>
  <script>const result=${json(result)},labels=${json(labels)};document.documentElement.lang=labels.locale;document.title=labels.title;for(const key of ['heading','rank','summary','note'])document.getElementById(key).textContent=labels[key];const filter=document.getElementById('filter');filter.placeholder=labels.filter;filter.setAttribute('aria-label',labels.filter);const host=result.players.find(p=>p.id===result.host.id),number=n=>n.toLocaleString(labels.locale);let key=0,dir=1;const cols=labels.columns;cols.forEach((label,i)=>{const th=document.createElement('th'),b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{dir=key===i?-dir:i<2?1:-1;key=i;draw()};th.append(b);document.querySelector('#head').append(th)});const value=(p,i)=>i===0?p.rank:i===1?p.name:i===cols.length-1?p.score:p.rounds[i-2].score;function draw(){const q=filter.value.toLocaleLowerCase(labels.locale);const list=result.players.filter(p=>(p.name+' '+p.login).toLocaleLowerCase(labels.locale).includes(q));list.sort((a,b)=>dir*(key===1?a.name.localeCompare(b.name,labels.locale):value(a,key)-value(b,key))||a.name.localeCompare(b.name,labels.locale));const rows=document.createDocumentFragment();for(const p of list){const row=document.createElement('tr');if(p.id===host.id)row.className='host';cols.forEach((_,i)=>{const td=document.createElement('td');td.textContent=typeof value(p,i)==='number'?number(value(p,i)):String(value(p,i))+(i===1&&p.id===host.id?labels.streamer:'');if(i>1&&i<cols.length-1)td.title=labels.scores.replaceAll('{{area}}',number(p.rounds[i-2].areaScore)).replaceAll('{{proximity}}',number(p.rounds[i-2].positionScore));row.append(td)});rows.append(row)}document.querySelector('#rows').replaceChildren(rows);document.querySelector('#count').textContent=labels.count.replaceAll('{{shown}}',number(list.length));[...document.querySelector('#head').children].forEach((th,i)=>th.setAttribute('aria-sort',i===key?(dir===1?'ascending':'descending'):'none'))}filter.oninput=draw;draw();</script></html>`;
}

export function downloadStreamResult(
  result: StreamResult,
  format: "html" | "json",
): void {
  const data =
    format === "html"
      ? streamResultHtml(result)
      : JSON.stringify(result, null, 2);
  const url = URL.createObjectURL(
    new Blob([data], {
      type: format === "html" ? "text/html;charset=utf-8" : "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `noitaguessr-${result.host.login}-${new Date(result.finishedAt).toISOString().slice(0, 10)}-${format === 'html' ? 'results' : 'scores'}-${result.id}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
