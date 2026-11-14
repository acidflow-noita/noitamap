import topographySvg from '../../public/guessr/topography.svg?raw';
import { bindAttribute, bindText, formatGuessrNumber, guessrLocale, tr } from "./i18n";
import type { StreamResult } from "./stream-types";
import { pageHeading } from './page-heading';
import { playerColor } from './player-color';
import { streamResultNames } from './stream-display-name';
import { streamResultShare } from './stream-share';
import { streamResultReviews } from './stream-result-review';
import type { ImageGameConfig } from './image-game';
import { pvpResultHeadline } from './pvp-results';

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
export function streamResultsView(result: StreamResult, viewerId?: string, onBack?: () => void, config?: ImageGameConfig): HTMLElement & { destroy: () => void } {
  result = streamResultNames(result);
  const section = el("section"),
    hero = el("div", "", "finish-hero");
  const host = result.players.find((p) => p.id === result.host.id)!;
  const own = viewerId ? result.players.find(p => p.id === viewerId) : undefined;
  const featured = own ?? host;
  const pvp = result.mode === 'pvp';
  const placement = (rank: number) => {
    const number = formatGuessrNumber(rank);
    if (!/^en(?:-|$)/i.test(guessrLocale())) return number;
    const rule = new Intl.PluralRules('en', { type: 'ordinal' }).select(rank);
    return number + ({ one: 'st', two: 'nd', few: 'rd' }[rule as 'one' | 'two' | 'few'] ?? 'th');
  };
  const title = el("h1", () => own ? tr('Your result') : viewerId ? tr('Game results') : tr('{{player}}’s results', { player: result.host.name }));
  if (onBack) {
    const back = el('button', 'Back'); back.type = 'button'; back.onclick = onBack;
    section.append(pageHeading(title, back));
  }
  hero.append(
    el("span", pvp ? '1v1' : "Chat vs Streamer", "badge pro animation-pop" + (pvp ? '' : ' twitch-mode-label')),
    ...(!onBack ? [title] : []),
    ...(pvp ? [el('p', () => pvpResultHeadline(result), 'stream-placement')] : []),
    ...(!pvp && own && own.id !== host.id ? [el('p', () => tr('You finished in position {{rank}} out of {{players}} players.',
      { rank: placement(own.rank), players: formatGuessrNumber(result.players.length) }), 'stream-placement')] : []),
    ...(!pvp ? [el('p', () => tr('Streamer {{player}} finished in position {{rank}} out of {{players}} players.',
      { player: result.host.name, rank: placement(host.rank), players: formatGuessrNumber(result.players.length) }), 'stream-placement')] : []),
    el(
      "p",
      () => pvp ? `${tr('{{points}} points', { points: formatGuessrNumber(featured.score), count: featured.score })}, ${tr('{{completed}} of {{total}} rounds completed', { completed: formatGuessrNumber(result.rounds.length), total: formatGuessrNumber(result.scheduledRounds ?? result.rounds.length) })}`
        : viewerId && !own ? tr('The streamer did not record a guess from this account.') : tr('{{score}}, {{rounds}}, Equal scores share a rank.', { score: tr('{{points}} points', { points: formatGuessrNumber(featured.score), count: featured.score }), rounds: tr('{{rounds}} rounds', { rounds: formatGuessrNumber(result.rounds.length), count: result.rounds.length }) }),
    ),
  );
  const share = streamResultShare(result, viewerId);
  const menu = el('div', '', 'stream-results-menu');
  if (share) menu.append(share.element);
  const download = el('button', 'Save results as a web page', 'btn btn-outline theme-secondary'); download.type = 'button';
  download.onclick = () => downloadStreamResult(result, 'html');
  const more = el('details', '', 'stream-export-options');
  const json = el('button', 'Export scores (JSON)', 'btn btn-outline theme-secondary'); json.type = 'button';
  json.onclick = () => downloadStreamResult(result, 'json');
  more.append(el('summary', 'More download options'), json,
    el('p', 'Open the saved web page in a browser to search and sort every player’s scores offline.', 'fine-print'));
  menu.append(download, more); section.append(menu);
  section.append(hero);
  const reviews = streamResultReviews(result, config); section.append(reviews.element);
  section.append(
    el(
      "p",
      pvp ? 'Both players use the same puzzles and scoring rules.' : "Casual game with results reported by the streamer. Area and proximity scores use the same rules for the streamer and chat.",
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
      if (!pvp && player.id === result.host.id) row.className = "stream-host-row";
      if (player.id === viewerId) row.classList.add('stream-viewer-row');
      row.append(
        el("td", () => formatGuessrNumber(player.rank), "numeric"),
        el(
          "td",
          () => player.name + (!pvp && player.id === result.host.id ? tr(', Streamer') : '') + (player.id === viewerId ? tr(', You') : ''),
        ),
      );
      (row.children[1] as HTMLElement).style.color = playerColor(player, pvp ? '' : result.host.id);
      for (const round of player.rounds) {
        const cell = el("td", () => formatGuessrNumber(round.score), "numeric");
        cell.classList.toggle('score-perfect', round.score === 5000);
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
  return Object.assign(section, { destroy: () => { share?.destroy(); reviews.destroy(); } });
}
/** A single file with embedded data, styling, filtering and sorting; no network,
 * framework, login, API credentials or session tokens are needed to read it. */
export function streamResultHtml(result: StreamResult): string {
  result = streamResultNames(result);
  const host = result.players.find(player => player.id === result.host.id)!;
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const labels = {
    locale: guessrLocale(),
    title: tr('NoitaGuessr stream results'),
    heading: result.mode === 'pvp' ? `NoitaGuessr, ${tr('1v1')}` : tr('NoitaGuessr, Chat vs Streamer'),
    rank: result.mode === 'pvp' ? pvpResultHeadline(result) : tr('{{player}} — rank {{rank}} of {{players}}', { player: host.name, rank: formatGuessrNumber(host.rank), players: formatGuessrNumber(result.players.length) }),
    summary: tr('{{score}}, {{rounds}}, {{date}}', { score: tr('{{points}} points', { points: formatGuessrNumber(host.score), count: host.score }), rounds: tr('{{rounds}} rounds', { rounds: formatGuessrNumber(result.rounds.length), count: result.rounds.length }), date: new Date(result.finishedAt).toLocaleString(guessrLocale()) }),
    filter: tr('Find a player'),
    columns: [tr('Rank'), tr('Player'), ...result.rounds.map((_, i) => tr('Round {{round}}', { round: formatGuessrNumber(i + 1) })), tr('Total')],
    streamer: result.mode === 'pvp' ? '' : tr(', Streamer'),
    count: tr('{{shown}} of {{players}} players', { shown: '{{shown}}', players: formatGuessrNumber(result.players.length), count: result.players.length }),
    scores: tr('Area: {{area}}, Proximity: {{proximity}}', { area: '{{area}}', proximity: '{{proximity}}' }),
    note: result.mode === 'pvp' ? tr('Both players use the same puzzles and scoring rules.') : tr('Latest valid chat guess received before the streamer closes each round counts. Equal scores share ranks. These casual game results are reported by the streamer.'),
  };
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title><style>
  :root{color-scheme:dark;font:16px Inter,system-ui,sans-serif;background:#020618;color:#e2e8f0}
  *{box-sizing:border-box}body{max-width:96rem;margin:0 auto;padding:clamp(1rem,3vw,2rem);min-height:100vh}
  body::before{content:"";position:fixed;inset:auto 0 0;height:20vh;z-index:-1;pointer-events:none;background-image:url("data:image/svg+xml,${encodeURIComponent(topographySvg)}");background-position:center bottom}
  h1{font-size:clamp(1.5rem,3vw,2.25rem);margin:0 0 1rem}p,small{color:#94a3b8}input,button{font:inherit;color:inherit;background:#0f172a;border:1px solid #334155;border-radius:.5rem;padding:.5rem .75rem}
  input{max-width:100%;min-height:2.75rem}button{cursor:pointer}button:hover{background:#1e293b}button:focus-visible,input:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}
  .wrap{max-width:100%;overflow:auto;border:1px solid #334155;border-radius:2rem;margin-top:1rem;background:#0f172a;overscroll-behavior:contain}
  table{width:100%;border-collapse:separate;border-spacing:0;font-size:.875rem}th,td{text-align:left;padding:.65rem .75rem;border-bottom:1px solid #334155;white-space:nowrap}
  th{position:sticky;top:0;background:#0f172a;font-weight:600;color:#94a3b8}th button{font-size:.8125rem;background:none;border:0;padding:.25rem;white-space:nowrap}
  th:nth-child(2),td:nth-child(2){min-width:10rem;max-width:18rem;white-space:normal;overflow-wrap:anywhere}
  th:not(:nth-child(2)),td:not(:nth-child(2)){text-align:right;font-variant-numeric:tabular-nums slashed-zero;font-feature-settings:"zero" 1}
  .host{background:rgb(145 70 255 / .12)}tbody tr:last-child td{border-bottom:0}.score-perfect{color:#fcd34d;font-weight:700;text-shadow:0 0 .45rem rgb(251 191 36 / .6),0 0 1rem rgb(251 191 36 / .3)}
  #rank{font-variant-numeric:tabular-nums slashed-zero;font-size:2rem;font-weight:700}th[aria-sort="ascending"] button::after{content:" ↑"}th[aria-sort="descending"] button::after{content:" ↓"}
  </style>
  <h1 id="heading"></h1><div id="rank"></div><p id="summary"></p><input id="filter" type="search"><div class="wrap" tabindex="0"><table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div><p id="count"></p><small id="note"></small>
  <script>const result=${json(result)},labels=${json(labels)};document.documentElement.lang=labels.locale;document.title=labels.title;for(const key of ['heading','rank','summary','note'])document.getElementById(key).textContent=labels[key];const filter=document.getElementById('filter');filter.placeholder=labels.filter;filter.setAttribute('aria-label',labels.filter);const host=result.players.find(p=>p.id===result.host.id),number=n=>n.toLocaleString(labels.locale);let key=0,dir=1;const cols=labels.columns;cols.forEach((label,i)=>{const th=document.createElement('th'),b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{dir=key===i?-dir:i<2?1:-1;key=i;draw()};th.append(b);document.querySelector('#head').append(th)});const value=(p,i)=>i===0?p.rank:i===1?p.name:i===cols.length-1?p.score:p.rounds[i-2].score;function draw(){const q=filter.value.toLocaleLowerCase(labels.locale);const list=result.players.filter(p=>(p.name+' '+p.login).toLocaleLowerCase(labels.locale).includes(q));list.sort((a,b)=>dir*(key===1?a.name.localeCompare(b.name,labels.locale):value(a,key)-value(b,key))||a.name.localeCompare(b.name,labels.locale));const rows=document.createDocumentFragment();for(const p of list){const row=document.createElement('tr');if(result.mode!=='pvp'&&p.id===host.id)row.className='host';cols.forEach((_,i)=>{const td=document.createElement('td');if(i===1)td.style.color=result.mode!=='pvp'&&p.id===result.host.id?'#9146FF':/^#[a-f0-9]{6}$/i.test(p.color||'')?p.color:'#E2E8F0';td.textContent=typeof value(p,i)==='number'?number(value(p,i)):String(value(p,i))+(i===1&&p.id===host.id?labels.streamer:'');if(i>1&&i<cols.length-1&&value(p,i)===5000)td.classList.add('score-perfect');if(i>1&&i<cols.length-1)td.title=labels.scores.replaceAll('{{area}}',number(p.rounds[i-2].areaScore)).replaceAll('{{proximity}}',number(p.rounds[i-2].positionScore));row.append(td)});rows.append(row)}document.querySelector('#rows').replaceChildren(rows);document.querySelector('#count').textContent=labels.count.replaceAll('{{shown}}',number(list.length));[...document.querySelector('#head').children].forEach((th,i)=>th.setAttribute('aria-sort',i===key?(dir===1?'ascending':'descending'):'none'))}filter.oninput=draw;draw();</script></html>`;
}

export function downloadStreamResult(
  result: StreamResult,
  format: "html" | "json",
): void {
  result = streamResultNames(result);
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
