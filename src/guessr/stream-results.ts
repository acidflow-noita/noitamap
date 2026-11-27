import { roundProgress } from './round-progress';
import { replayLegend } from './release-features';
import { iconLabel } from './control-icons';
import topographySvg from '../../public/guessr/topography.svg?raw';
import { bindAttribute, bindText, formatGuessrNumber, guessrLocale, tr } from "./i18n";
import type { StreamResult } from "./stream-types";
import { playerColor } from './player-color';
import { streamResultNames } from './stream-display-name';
import { streamResultShare } from './stream-share';
import { streamResultReviews } from './stream-result-review';
import type { ReplayLoader } from './clue-replay';
import { createScoreReplay, publishedReplayLoader } from './clue-replay-view';
import type { ImageGameConfig } from './image-game';
import { pvpResultHeadline } from './pvp-results';
import { privateResultReview } from './network-review-view';
import { focusScoreRow, scoreSummary } from './score-summary';

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
export function streamResultsView(result: StreamResult, viewerId?: string, onBack?: () => void, config?: ImageGameConfig,
  liveReplay?: ReplayLoader): HTMLElement & { destroy: () => void } {
  result = streamResultNames(result);
  const section = el("section", '', 'stream-results'),
    hero = el('section', '', 'card finish-hero stream-results-heading rounded-9');
  const headingBody = el('div', '', 'card-body result-heading-body'); hero.append(headingBody);
  const host = result.players.find((p) => p.id === result.host.id)!;
  const own = viewerId ? result.players.find(p => p.id === viewerId) : undefined;
  const featured = own ?? host;
  const pvp = result.mode === 'pvp';
  const playerRows = new Map<string, HTMLTableRowElement>();
  const summary = scoreSummary(result.players.map(p => ({ ...p, total: p.score })), pvp ? '' : result.host.id, viewerId, id => {
    if (!playerRows.has(id) && filter.value) { filter.value = ''; render(); }
    focusScoreRow(playerRows.get(id));
  });
  const placement = (rank: number) => {
    const number = formatGuessrNumber(rank);
    if (!/^en(?:-|$)/i.test(guessrLocale())) return number;
    const rule = new Intl.PluralRules('en', { type: 'ordinal' }).select(rank);
    return number + ({ one: 'st', two: 'nd', few: 'rd' }[rule as 'one' | 'two' | 'few'] ?? 'th');
  };
  const outcome = el('div', '', 'result-outcome');
  const title = el("h1", () => own ? tr('Your result') : viewerId ? tr('Game results') : tr('{{player}}’s results', { player: result.host.name }));
  if (onBack) {
    const back = el('button', '', 'btn btn-outline theme-secondary result-back'); back.type = 'button'; back.onclick = onBack;
    const label = iconLabel('arrow-left', { source: 'Back' });
    label.querySelector('span')!.className = 'visually-hidden';
    back.append(label); bindAttribute(back, 'title', 'Back');
    outcome.append(back);
  }
  outcome.append(
    el("span", pvp ? '1v1' : "Chat vs Streamer", 'result-mode' + (pvp ? '' : ' twitch-mode-label')),
    title,
    ...(pvp ? [el('p', () => pvpResultHeadline(result), 'stream-placement')] : []),
    ...(!pvp && !summary && own && own.id !== host.id ? [el('p', () => tr('You finished in position {{rank}} out of {{players}} players.',
      { rank: placement(own.rank), players: formatGuessrNumber(result.players.length) }), 'stream-placement')] : []),
    ...(!pvp && !summary ? [el('p', () => tr('Streamer {{player}} finished in position {{rank}} out of {{players}} players.',
      { player: result.host.name, rank: placement(host.rank), players: formatGuessrNumber(result.players.length) }), 'stream-placement')] : []),
  );
  const score = el('div', '', 'result-score');
  if (viewerId && !own) score.append(el('p', 'The streamer did not record a guess from this account.'));
  else score.append(el('strong', () => tr('{{points}} points', { points: formatGuessrNumber(featured.score), count: featured.score })));
  const completion = el('div', '', 'result-completion');
  const totalRounds = result.scheduledRounds ?? result.rounds.length;
  completion.append(el('span', result.concededBy ? 'Game ended' : 'Game finished'));
  if (totalRounds > 0) completion.append(roundProgress(totalRounds, result.rounds.length, result.rounds.length, true));
  score.append(completion);
  headingBody.append(outcome, score);
  const share = streamResultShare(result, viewerId);
  const menu = el('div', '', 'stream-results-menu');
  if (share) menu.append(share.element);
  const download = el('button', 'Save results as a web page', 'btn btn-outline theme-secondary'); download.type = 'button';
  download.onclick = () => downloadStreamResult(result, 'html');
  bindAttribute(download, 'title', 'Open the saved web page in a browser to search and sort every player’s scores offline.');
  const json = el('button', 'Save scores as a JSON file', 'btn btn-outline theme-secondary'); json.type = 'button';
  json.onclick = () => downloadStreamResult(result, 'json');
  menu.append(download, json); section.append(hero);
  if (summary) section.append(summary);
  section.append(menu);
  const review = privateResultReview(result); if (review) section.append(review.element);
  const readReplay = result.clueReplays && result.rounds.length ? liveReplay ?? publishedReplayLoader(result.id) : undefined;
  const reviews = streamResultReviews(result, config, readReplay, viewerId); section.append(reviews.element);
  const controls = el("div", "", "stream-table-controls"),
    filter = el("input"),
    count = el("span", "", "muted");
  count.setAttribute('role','status');
  filter.type = "search";
  bindAttribute(filter, "placeholder", "Find a player");
  bindAttribute(filter, "aria-label", "Filter players by name or login");
  controls.append(el('h2', 'Player scores'), count);
  if (readReplay) controls.append(replayLegend());
  controls.append(filter);
  const standings = el('section', '', 'stream-standings'); standings.append(controls); section.append(standings);
  const replays = readReplay ? createScoreReplay(readReplay, standings, result.config ?? config) : undefined;
  const wrap = el("div", "", "table-wrap stream-score-frame rounded-9"),
    table = el("table", '', 'table stream-score-table'),
    head = el("tr"),
    tbody = el("tbody");
  table.onpointerover = event => {
    table.classList.toggle('score-pointer-hover', event.pointerType === 'mouse' || event.pointerType === 'pen');
  };
  table.onpointerleave = () => table.classList.remove('score-pointer-hover');
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
    if (index === 0) {
      th.classList.add('stream-rank-column');
      bindAttribute(button, 'title', 'Equal scores share a rank.');
    }
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
  standings.append(wrap);
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
    playerRows.clear();
    for (const player of rows) {
      const row = el("tr");
      row.dataset.player = player.id; row.tabIndex = -1; playerRows.set(player.id, row);
      if (!pvp && player.id === result.host.id) row.className = "stream-host-row";
      if (player.id === viewerId) row.classList.add('stream-viewer-row');
      const name = document.createElement('td');
      const label = () => player.name + (!pvp && player.id === result.host.id ? tr(', Streamer') : '') + (player.id === viewerId ? tr(', You') : '');
      name.append(bindText(document.createElement('span'), label));
      name.style.color = playerColor(player, pvp ? '' : result.host.id);
      row.append(el("td", () => formatGuessrNumber(player.rank), "numeric stream-rank-column"), name);
      player.rounds.forEach((round, index) => {
        const cell = el('td', '', 'numeric');
        const score = el('span', () => formatGuessrNumber(round.score));
        score.classList.toggle('score-perfect', round.score === 5000);
        bindAttribute(cell, 'title', () => tr('Area: {{area}}, Proximity: {{proximity}}', { area: formatGuessrNumber(round.areaScore), proximity: formatGuessrNumber(round.positionScore) }));
        const location = result.rounds[index];
        if (replays && location) {
          const group = el('div', '', 'score-with-replay');
          group.append(score, replays.scoreButton(player, { number:index+1, answer:location.answer, location:location.name }));
          cell.append(group);
        } else cell.append(score);
        row.append(cell);
      });
      row.append(el("td", () => formatGuessrNumber(player.score), "numeric score"));
      fragment.append(row);
    }
    tbody.replaceChildren(fragment); replays?.discardHidden();
    bindText(count, () => query
      ? tr('Showing {{shown}} of {{players}}', {shown:formatGuessrNumber(rows.length),players:formatGuessrNumber(result.players.length)})
      : playerCount(result.players.length));
    [...head.children].filter(th => th.querySelector('.stream-table-sort')).forEach((th, index) => {
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
  return Object.assign(section, { destroy: () => { replays?.destroy(); review?.destroy(); share?.destroy(); reviews.destroy(); } });
}
function playerCount(total:number) {
  return tr('{{amount}} players', { amount:formatGuessrNumber(total), count:total });
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
    countAll: playerCount(result.players.length),
    count: tr('Showing {{shown}} of {{players}}',{shown:'{{shown}}',players:formatGuessrNumber(result.players.length)}),
    scores: tr('Area: {{area}}, Proximity: {{proximity}}', { area: '{{area}}', proximity: '{{proximity}}' }),
    note: result.mode === 'pvp' ? tr('Both players use the same puzzles and scoring rules.') : tr('Equal scores share a rank.'),
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
  #rank{font-variant-numeric:tabular-nums slashed-zero;font-size:1rem;font-weight:600}h1{font-size:1.125rem}th:first-child,td:first-child{width:1%;white-space:nowrap;padding-inline:.5rem}th[aria-sort="ascending"] button::after{content:" ↑"}th[aria-sort="descending"] button::after{content:" ↓"}
  </style>
  <h1 id="heading"></h1><div id="rank"></div><p id="summary"></p><input id="filter" type="search"><div class="wrap" tabindex="0"><table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div><p id="count"></p><small id="note"></small>
  <script>const result=${json(result)},labels=${json(labels)};document.documentElement.lang=labels.locale;document.title=labels.title;for(const key of ['heading','rank','summary','note'])document.getElementById(key).textContent=labels[key];const filter=document.getElementById('filter');filter.placeholder=labels.filter;filter.setAttribute('aria-label',labels.filter);const host=result.players.find(p=>p.id===result.host.id),number=n=>n.toLocaleString(labels.locale);let key=0,dir=1;const cols=labels.columns;cols.forEach((label,i)=>{const th=document.createElement('th'),b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{dir=key===i?-dir:i<2?1:-1;key=i;draw()};th.append(b);document.querySelector('#head').append(th)});const value=(p,i)=>i===0?p.rank:i===1?p.name:i===cols.length-1?p.score:p.rounds[i-2].score;function draw(){const q=filter.value.toLocaleLowerCase(labels.locale);const list=result.players.filter(p=>(p.name+' '+p.login).toLocaleLowerCase(labels.locale).includes(q));list.sort((a,b)=>dir*(key===1?a.name.localeCompare(b.name,labels.locale):value(a,key)-value(b,key))||a.name.localeCompare(b.name,labels.locale));const rows=document.createDocumentFragment();for(const p of list){const row=document.createElement('tr');if(result.mode!=='pvp'&&p.id===host.id)row.className='host';cols.forEach((_,i)=>{const td=document.createElement('td');if(i===1)td.style.color=result.mode!=='pvp'&&p.id===result.host.id?'#9146FF':/^#[a-f0-9]{6}$/i.test(p.color||'')?p.color:'#E2E8F0';td.textContent=typeof value(p,i)==='number'?number(value(p,i)):String(value(p,i))+(i===1&&p.id===host.id?labels.streamer:'');if(i>1&&i<cols.length-1&&value(p,i)===5000)td.classList.add('score-perfect');if(i>1&&i<cols.length-1)td.title=labels.scores.replaceAll('{{area}}',number(p.rounds[i-2].areaScore)).replaceAll('{{proximity}}',number(p.rounds[i-2].positionScore));row.append(td)});rows.append(row)}document.querySelector('#rows').replaceChildren(rows);document.querySelector('#count').textContent=q?labels.count.replaceAll('{{shown}}',number(list.length)):labels.countAll;[...document.querySelector('#head').children].forEach((th,i)=>th.setAttribute('aria-sort',i===key?(dir===1?'ascending':'descending'):'none'))}filter.oninput=draw;draw();</script></html>`;
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
