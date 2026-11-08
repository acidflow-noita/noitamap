import "./game.css";
import Dialog from "bootstrap/js/dist/dialog.js";
import { bindText, bindAttribute, tr, initializeGuessrTranslations, guessrLocale, guessrGameTerm, formatGuessrNumber } from './i18n';
import { createGuessrLanguagePicker, disposeGuessrLanguagePickers } from './language-picker';
import { difficultyIndicator, maximumIndicator, updateDifficultyIndicators, updateRoundIndicators } from './round-status';
import { msg, setText, localizedDistance, localizedError, type LocalizedText } from './messages';
import {
  GUESSR_CANONICAL_URL,
  isGuessrAvailable,
} from "../guessr-availability";
import {
  utcDay,
  type Pack,
  type Point,
  newClueProgress,
  maximumScore,
  within,
  type ClueProgress,
} from "./rules";
import {
  currentPlace,
  livesLeft,
  nextRound,
  pausePractice,
  readHistory,
  saveHistory,
  submitPractice,
  SESSION_KEY,
  HISTORY_KEY,
  type PracticeSession,
} from "./practice";
import { MapBoard } from "./map-board";
import { attachClueControls } from "./clue-view";
import { guessRouteUrl, readGuessRoute, type GuessPane } from './routes';
import {
  imageGameRequest,
  type ImageGameConfig,
  type ImageGameState,
  type ImageRoundResult,
} from "./image-game";
import { supportedCamera, type ClueSource } from "./clue-camera";
import { ClueViewport } from "./clue-viewport";
import { createLobby, type LobbyOptions } from "./lobby";
import { instructionSteps } from './stepper';
import { pageHeading } from './page-heading';
import { restoreDailyView, saveDailyView } from './daily-progress';
import { dailyResultsTable } from './daily-results';
import { loadingPlaceholders, clueLoadingPlaceholder } from './loading-placeholders';
import { iconLabel, type ControlIcon } from './control-icons';
import { ACTIVE_MODE_KEY, readDailyResume, rememberDailyResume, forgetDailyResume } from './resume-progress';
import { StreamUI } from "./stream-ui";
import { streamHistorySection } from './stream-history';
import {
  GameApi,
  gameApiOrigin,
  gameAuth,
  type RankedState,
  type DailyStatus,
} from "./api";

const root = document.getElementById("guess-app")!;
let pack: Pack;
let session: PracticeSession | null = null;
let imageSession: ImageGameState | null = null;
let imageClue: ClueProgress = newClueProgress();
let imageGuess: Point | null = null;
let imagePaused = false;
const IMAGE_SESSION_KEY = "noitamap-guessr-images-v1";
let board: MapBoard | undefined;
let view:
  "home" | "practice" | "ranked" | "leaderboard" | "history" | "stream" =
  "home";
let streamUI: StreamUI | undefined;
let ranked: RankedState | null = null;
let rankedGuess: Point | null = null;
let rankedClue: ClueProgress = newClueProgress();
let api: GameApi | undefined;
let busy = false;
let generation = 0;
let imageUrl: string | undefined;
let imageAbort: AbortController | undefined;
let clearClue: (() => void) | undefined;
const storage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      toast(msg("This browser could not save progress. Keep this tab open."));
    }
  },
  removeItem(key: string): void { localStorage.removeItem(key); },
};
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: LocalizedText,
  icon?: ControlIcon,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) {
    if (icon) {
      el.classList.add('with-icon');
      el.append(iconLabel(icon, text));
    } else setText(el, text);
  }
  return el;
}
function button(
  text: LocalizedText,
  action: () => unknown,
  className = "",
  icon?: ControlIcon,
): HTMLButtonElement {
  const b = node("button", className, text, icon);
  b.type = "button";
  if ((typeof text === 'string' ? text : text.source) === 'Skip round') bindAttribute(b, 'title', 'Skip this round without scoring');
  b.addEventListener("click", () => void action());
  return b;
}
function link(text: LocalizedText, url: string, className = "", icon?: ControlIcon): HTMLAnchorElement {
  const a = node("a", className, text, icon);
  a.href = url;
  return a;
}
function announce(message: LocalizedText): void {
  const el = document.getElementById("game-announcement");
  if (el) setText(el, message);
}
function toast(message: LocalizedText): void {
  document.querySelector(".guessr-toast")?.remove();
  const el = node("div", "guessr-toast", message);
  el.setAttribute("role", "status");
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}
function save(): void {
  streamUI?.save();
  saveRankedView();
  if (imageSession)
    storage.setItem(
      IMAGE_SESSION_KEY,
      JSON.stringify({
        id: imageSession.id,
        version: imageSession.version,
        roundId: imageSession.current?.id,
        clue: imageClue,
        guess: imageGuess,
        paused: imagePaused,
      }),
    );
  if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
}
function saveRankedView(): void {
  if (ranked?.config && ranked.clue) saveDailyView(storage, {
    id: ranked.id, round: ranked.round, version: ranked.config.version, bounds: ranked.bounds, clue: ranked.clue,
  }, rankedClue, rankedGuess);
}
function cleanup(): void {
  generation++;
  clearClue?.();
  clearClue = undefined;
  board?.destroy();
  board = undefined;
  imageAbort?.abort();
  imageAbort = undefined;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = undefined;
}
function shell(game = false): HTMLElement {
  cleanup();
  disposeGuessrLanguagePickers(root);
  root.replaceChildren();
  const header = node("header", "site-header"),
    brand = link("", "/guess/", "brand");
  const logo = node("img");
  logo.src = "/assets/noitaguessr-logo.svg";
  logo.alt = "NoitaGuessr";
  logo.width = 602;
  logo.height = 93;
  brand.append(logo);
  brand.addEventListener("click", (e) => {
    e.preventDefault();
    home();
  });
  const identity = node('div', 'header-identity');
  identity.append(brand, createGuessrLanguagePicker());
  const actions = node("div", "header-actions");
  if (readGuessRoute(new URL(location.href)).pane !== 'stream-picker')
    identity.prepend(link(msg("Back to map"), mapReturnUrl(), 'btn btn-sm btn-outline theme-secondary map-return', 'arrow-left'));
  actions.append(button(msg("How to play"), help, "small secondary", 'info-circle'));
  header.append(identity, actions);
  root.append(header);
  const live = node("div", "sr-only");
  live.id = "game-announcement";
  live.setAttribute("aria-live", "polite");
  root.append(live);
  const main = node("main", game ? "shell game-shell" : "shell");
  root.append(main);
  return main;
}
function mapReturnUrl(): string {
  try {
    if (document.referrer) {
      const url = new URL(document.referrer);
      if (
        url.origin === location.origin &&
        !url.pathname.startsWith("/guess")
      ) {
        sessionStorage.setItem("guessr-map-return", url.href);
        return url.href;
      }
    }
    const previous = sessionStorage.getItem("guessr-map-return");
    if (previous && new URL(previous).origin === location.origin)
      return previous;
  } catch {}
  return "/";
}
function home(): void {
  save();
  streamUI?.suspend();
  view = "home";
  historyReplace(guessRouteUrl('home', location.href));
  const main = shell();
  const stream = streamUI?.game;
  const entries = readHistory(storage);
  const latest = entries[0];
  const best = entries.reduce<typeof latest | undefined>(
    (best, entry) => (!best || entry.score > best.score ? entry : best),
    undefined,
  );
  const candidates: (NonNullable<LobbyOptions['resume']> & { mode: string })[] = [];
  if (stream && stream.stage !== 'complete') candidates.push({
    mode: 'stream', modeLabel: 'Chat vs Streamer', continueLabel: 'Continue Chat vs Streamer', twitch: true,
    currentRound: stream.round + 1, totalRounds: stream.session.rounds.length, completedRounds: stream.reveals.length,
    action: openStream,
    quit: async () => { await streamUI!.quit(); home(); },
    quitDescription: 'This ends the game for you and your chat. The unfinished game will not be added to results.',
  });
  if (imageSession && imageSession.stage !== 'complete') candidates.push({
    mode: 'demo', modeLabel: 'Demo', continueLabel: 'Continue demo',
    currentRound: imageSession.round + 1, totalRounds: imageSession.totalRounds, completedRounds: imageSession.results.length,
    action: renderPractice,
    quit: () => quitDemo('image', imageSession!.id),
  });
  else if (session && session.stage !== 'complete') candidates.push({
    mode: 'demo', modeLabel: 'Demo', continueLabel: 'Continue demo',
    currentRound: session.results.length + 1, totalRounds: session.order.length, completedRounds: session.results.length,
    action: renderPractice,
    quit: () => quitDemo('practice', session!.id),
  });
  const daily = readDailyResume(storage);
  if (daily) candidates.push({
    mode: 'daily', modeLabel: 'Daily', continueLabel: 'Continue daily',
    currentRound: daily.round + 1, totalRounds: daily.totalRounds, completedRounds: daily.completedRounds,
    action: () => rankedLobby(daily.id, daily.day),
    quitDescription: 'Unplayed rounds will score zero. You cannot restart this daily.',
    quit: async () => {
      const origin = gameApiOrigin();
      const service = api ?? (origin ? new GameApi(origin) : null);
      if (!service) throw Error('The daily service is unavailable. Please retry later.');
      await service.request<RankedState>(`/api/attempts/${daily.id}/quit`, { body: {} });
      forgetDailyResume(daily.id, storage);
      if (ranked?.id === daily.id) ranked = null;
      home();
    },
  });
  const resume = candidates.find(candidate => candidate.mode === storage.getItem(ACTIVE_MODE_KEY)) ?? candidates[0];
  main.append(
    createLobby({
      startDemo: startPractice,
      dailyToday: () => rankedLobby(undefined, utcDay()),
      dailyYesterday: () =>
        rankedLobby(undefined, utcDay(Date.now() - 86400000)),
      streamHost: openStream,
      streamJoin: openStreamPicker,
      resume,
      history:
        latest && best ? { recent: latest, best, action: history } : undefined,
    }),
  );
}
function quitDemo(mode: 'image' | 'practice', id: string): void {
  const key = mode === 'image' ? IMAGE_SESSION_KEY : SESSION_KEY;
  let saved: { id?: string } | null = null;
  try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch { /* Invalid saves cannot be resumed. */ }
  if (saved?.id === id) storage.removeItem(key);
  if (mode === 'image' && imageSession?.id === id) {
    imageSession = null; imageGuess = null;
    imageClue = newClueProgress(); imagePaused = false;
  }
  if (mode === 'practice' && session?.id === id) session = null;
  home();
}
function openStream(): void {
  storage.setItem(ACTIVE_MODE_KEY, 'stream');
  save();
  view = "stream";
  setPane("stream");
  void streamUI?.open();
}
function openStreamPicker(): void {
  save();
  view = "stream";
  setPane("stream-picker");
  streamUI?.picker();
}

async function startPractice(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    imageSession = await imageGameRequest<ImageGameState>("/sessions", {});
    imageClue = newClueProgress();
    imageGuess = null;
    imagePaused = false;
    session = null;
    save();
    renderPractice();
  } catch (error) {
    toast(msg(() => localizedError(error)));
  } finally {
    busy = false;
  }
}
function makePlayPanels(
  main: HTMLElement,
  guess: Point | null,
  locked: boolean,
  onPick?: (point: Point) => void,
): { clue: HTMLElement; bar: HTMLElement; mapActions: HTMLElement } {
  const grid = node("div", "game-grid"),
    left = node("section", "game-panel"),
    right = node("section", "game-panel game-panel--map");
  const bar = node("div", "panel-bar");
  const clueHeading = node('div', 'clue-heading');
  clueHeading.append(node("span", "panel-title", msg('Where are you?')), difficultyIndicator());
  bar.append(clueHeading);
  left.append(bar);
  const clue = node("div", "clue loading");
  clue.append(clueLoadingPlaceholder());
  bindAttribute(clue, 'data-loading-label', 'Loading clue map…');
  bindAttribute(clue, 'data-paused-label', 'Paused');
  left.append(clue);
  const mapBar = node("div", "panel-bar map-bar map-bar--budget");
  const mapHeading = node("div", "map-heading");
  mapBar.append(mapHeading, maximumIndicator());
  const mapActions = node("div", "buttons");
  mapBar.append(mapActions);
  const map = node("div", "map-board");
  map.id = "guess-map";
  right.append(mapBar, map);
  grid.append(left, right);
  main.append(grid);
  board = new MapBoard(
    map,
    ranked && view === "ranked" ? ranked.bounds : pack.bounds,
    ranked && view === 'ranked' && ranked.config ? ranked.config.overview : pack.overview,
    (p) => {
      if (onPick) onPick(p);
      else if (
        view === "practice" &&
        imageSession?.stage === "guess" &&
        !imagePaused &&
        !busy
      ) {
        imageGuess = p;
        save();
      } else if (
        view === "practice" &&
        session &&
        session.stage === "guess" &&
        session.pausedAt === null
      ) {
        session.guess = p;
        save();
      } else if (view === "ranked" && !busy) { rankedGuess = p; saveRankedView(); }
      else return;
      board?.setMarkers(p);
      const confirm = document.getElementById(
        "confirm-guess",
      ) as HTMLButtonElement | null;
      if (confirm) confirm.disabled = false;
      const hint = document.querySelector(".game-actions .action-hint");
      if (hint) {
        bindText(hint, 'Pin placed. Ready when you are.');
        hint.classList.add("is-ready");
      }
      announce(msg("Pin placed. Submit your guess when ready."));
    },
    ranked && view === 'ranked' && ranked.config ? ranked.config.map : pack.map,
  );
  board.setMarkers(guess);
  board.setLocked(locked);
  return { clue, bar, mapActions };
}
function putClue(clue: HTMLElement, url: string, crop: number): void {
  clue.classList.add("loading");
  const img = node("img");
  img.alt = "The location to identify";
  img.draggable = false;
  clue.style.setProperty("--crop", String(crop));
  img.onload = () => clue.classList.remove("loading");
  img.onerror = () => {
    clue.classList.remove("loading");
    img.classList.add("broken");
    clue.append(
      node(
        "div",
        "notice error",
        msg("This clue could not load. Check your connection and reload to resume."),
      ),
    );
  };
  img.src = url;
  clue.replaceChildren(img, clueLoadingPlaceholder());
}
function gameHud(options: {
  label: string;
  badge: string;
  twitch?: boolean;
  round: number;
  total: number;
  score: number;
  exit: () => void;
  extra?: string;
}): HTMLElement {
  const group = node("div", "hud-group");
  if (options.badge === 'pro') group.append(node('span', options.twitch ? 'twitch-mode-label' : '', msg(options.label)));
  group.append(
    node("span", `badge ${options.badge}${options.badge === 'pro' ? ' animation-pop' : ''}${options.twitch && options.badge !== 'pro' ? ' twitch-mode-label' : ''}`, msg(options.badge === 'pro' ? 'Pro' : options.label)),
    node("span", "round", msg("Round {{value1}} / {{value2}}", () => ({ value1: options.round, value2: options.total }))),
  );
  if (options.extra) group.append(node("span", "hint", options.extra));
  const progress = node("div", "round-progress");
  progress.setAttribute("aria-hidden", "true");
  for (let round = 1; round <= options.total; round++)
    progress.append(
      node(
        "span",
        round < options.round
          ? "complete"
          : round === options.round
            ? "current"
            : "",
      ),
    );
  group.append(progress);
  const hud = pageHeading(group, button(msg("Exit game"), options.exit));
  hud.classList.add('game-hud');
  return hud;
}
function showMapResult(
  main: HTMLElement,
  name: string,
  distance: number | null,
  url: string,
  score: number,
  difficulty?: string,
): void {
  const clueTitle = main.querySelector('.game-grid > .game-panel:first-child .panel-title');
  if (clueTitle) bindText(clueTitle, 'Revealed area');
  updateDifficultyIndicators(main, difficulty);
  const heading = main.querySelector(".map-heading")!;
  const explore = link(msg(() => guessrGameTerm(name)), url, "panel-title result-link");
  explore.target = "_blank";
  explore.rel = "noopener noreferrer";
  bindAttribute(explore, 'title', '{{name}} — Explore on Noitamap', () => ({ name: guessrGameTerm(name) }));
  const summary = () => localizedDistance(distance);
  const detail = node("span", "map-result-meta", msg(summary));
  bindAttribute(detail, 'title', summary);
  const points = node(
    "output",
    "badge round-points",
    msg("+{{value1}} pts", () => ({ value1: score.toLocaleString(guessrLocale()) })),
  );
  bindAttribute(points, 'aria-label', '{{points}} points earned this round', () => ({ count: score, points: score.toLocaleString(guessrLocale()) }));
  bindAttribute(points, 'title', 'Points earned this round');
  const mapBar = heading.parentElement!;
  mapBar.classList.remove('map-bar--budget');
  mapBar.classList.add("map-bar--result");
  mapBar.querySelector(".round-points")?.remove();
  heading.replaceChildren(explore, detail);
  heading.after(points);
}
function guessHint(guess: Point | null): HTMLElement {
  return node(
    "p",
    `action-hint${guess ? " is-ready" : ""}`,
    guess ? msg("Pin placed. Ready when you are.") : msg("Place your pin, then submit."),
  );
}
function renderPractice(): void {
  storage.setItem(ACTIVE_MODE_KEY, 'demo');
  if (imageSession) return renderImageGame();
  if (!session) return home();
  view = "practice";
  setPane("practice");
  if (session.stage === "complete") return finish();
  const main = shell(true),
    place = currentPlace(session, pack),
    result = session.stage === "reveal" ? session.results.at(-1) : undefined;
  main.append(
    gameHud({
      label: "Demo",
      badge: "practice",
      round: result ? session.results.length : session.results.length + 1,
      total: session.order.length,
      score: session.results.reduce((n, r) => n + r.score, 0),
      extra:
        session.settings.mode === "survival"
          ? `${"♥".repeat(livesLeft(session))} ${"♡".repeat(3 - livesLeft(session))}`
          : undefined,
      exit: () => {
        save();
        home();
      },
    }),
  );
  const { clue, bar } = makePlayPanels(
    main,
    session.guess,
    !!result || session.pausedAt !== null,
  );
  updateRoundIndicators(main, session.clue, place.hard ? 'hard' : undefined);
  if (!result && session.pausedAt === null && place.views) {
    clearClue = attachClueControls(
      clue,
      place,
      session.clue,
      pack.travelStep ?? 256,
      save,
      { difficultyTier: place.hard ? 'hard' : undefined },
    );
  } else if (result) {
    putClue(clue, place.views?.["0,0,6"]?.image ?? place.image, 1);
  }
  clue.classList.toggle("paused", session.pausedAt !== null);
  const clueActions = node("div", "buttons");
  if (!result) {
    clueActions.append(
      button(
        session.pausedAt !== null ? msg("Resume") : msg("Pause"),
        () => {
          pausePractice(session!, session!.pausedAt === null);
          save();
          renderPractice();
        },
        "small",
      ),
    );
  } else clueActions.append(node("span", "hint", msg(() => guessrGameTerm(place.biome))));
  bar.append(clueActions);
  const actions = node("div", "game-actions");
  if (result) {
    board?.setMarkers(result.guess, place);
    showMapResult(
      main,
      place.name,
      result.distance,
      `/?m=r&x=${place.x}&y=${place.y}&z=850`,
      result.score,
    );
    const finished =
      session.results.length === session.order.length ||
      (session.settings.mode === "survival" && livesLeft(session) === 0);
    actions.append(
      node("p", "", msg("Your guess is blue. The location is green.")),
      button(
        finished ? msg("View results") : msg("Next round"),
        advancePractice,
        "primary",
      ),
    );
  } else {
    const confirm = button(
      msg("Submit guess"),
      () => guessPractice(false),
      "primary",
    );
    confirm.id = "confirm-guess";
    confirm.disabled = !session.guess || session.pausedAt !== null;
    actions.append(
      button(msg("Skip round"), () => guessPractice(true), "secondary"),
      guessHint(session.guess),
      confirm,
    );
  }
  main.append(actions);
  if (session.pausedAt !== null) {
    for (const action of actions.querySelectorAll("button"))
      action.disabled = true;
  }
}
function guessPractice(skip: boolean): void {
  if (imageSession) {
    void submitImageGame(skip);
    return;
  }
  if (!session || session.stage !== "guess" || session.pausedAt !== null)
    return;
  try {
    const result = submitPractice(session, pack, skip);
    save();
    renderPractice();
    announce(msg("Location revealed. {{value1}}.", () => ({ value1: localizedDistance(result.distance) })));
  } catch (e) {
    toast(msg(() => localizedError(e)));
  }
}
function advancePractice(): void {
  if (imageSession) {
    void advanceImageGame();
    return;
  }
  if (!session) return;
  nextRound(session);
  save();
  if (session.stage === "complete") saveHistory(session, storage);
  renderPractice();
}
function finish(): void {
  if (imageSession) return finishImageGame();
  if (!session) return;
  view = "practice";
  const main = shell();
  saveHistory(session, storage);
  const score = session.results.reduce((n, r) => n + r.score, 0),
    hero = node("section", "finish-hero");
  hero.append(
    node("span", "badge practice", msg("Demo complete")),
    node("div", "total", msg(() => score.toLocaleString(guessrLocale()))),
    node(
      "p",
      "",
      msg("Maximum: {{points}}, Locations: {{locations}}", () => ({ points: (session!.results.length * 5000).toLocaleString(guessrLocale()), locations: session!.results.length })),
    ),
  );
  main.append(pageHeading(node("h1", "", msg("Your results")), button(msg("Back"), home)), hero);
  const actions = node("div", "finish-actions");
  actions.append(
    button(msg("Replay demo"), startPractice, "primary"),
  );
  main.append(actions);
  const wrap = node("div", "table-wrap"),
    table = node("table"),
    thead = node("thead"),
    tr = node("tr");
  for (const text of ["Round", "Location", "Distance", "Points", ""])
    tr.append(node("th", "", text ? msg(text) : ''));
  thead.append(tr);
  table.append(thead);
  const tbody = node("tbody");
  session.results.forEach((r, i) => {
    const place = pack.places.find((p) => p.id === r.placeId)!;
    const row = node("tr");
    row.append(
      node("td", "", String(i + 1)),
      node("td", "", msg(() => guessrGameTerm(place.name))),
      node("td", "", msg(() => localizedDistance(r.distance))),
      node("td", "score", msg(() => r.score.toLocaleString(guessrLocale()))),
    );
    const action = node("td");
    action.append(button(msg("Review"), () => reviewPractice(i), "small"));
    row.append(action);
    tbody.append(row);
  });
  table.append(tbody);
  wrap.append(table);
  main.append(wrap);
  main.append(node("p", "fine-print", msg("Demo scores stay on this device.")));
}
function reviewPractice(index: number): void {
  if (imageSession) {
    void reviewImageGame(index);
    return;
  }
  if (!session) return;
  const main = shell(true),
    result = session.results[index],
    place = pack.places.find((p) => p.id === result.placeId)!;
  main.append(pageHeading(
    node("h1", "", msg("Round {{value1}}: {{value2}}", () => ({ value1: index + 1, value2: place.name }))),
    button(msg("← Results"), finish),
  ));
  const { clue } = makePlayPanels(main, result.guess, true);
  putClue(clue, place.views?.["0,0,6"]?.image ?? place.image, 1);
  board?.setMarkers(result.guess, place);
  showMapResult(
    main,
    place.name,
    result.distance,
    `/?m=r&x=${place.x}&y=${place.y}&z=850`,
    result.score,
  );
}

function renderImageGame(review?: {
  result: ImageRoundResult;
  clue: ClueSource;
}): void {
  if (!imageSession) return home();
  view = "practice";
  setPane("practice");
  if (imageSession.stage === "complete" && !review) return finishImageGame();
  const result =
    review?.result ??
    (imageSession.stage === "reveal" ? imageSession.results.at(-1) : undefined);
  const source = review?.clue ?? imageSession.current!.clue;
  const main = shell(true);
  main.append(
    gameHud({
      label: "Demo",
      badge: "practice",
      round: (result?.ordinal ?? imageSession.round) + 1,
      total: imageSession.totalRounds,
      score: imageSession.results.reduce((n, r) => n + r.score, 0),
      exit: () => {
        save();
        home();
      },
    }),
  );
  const { clue, bar } = makePlayPanels(
    main,
    result ? result.guess : imageGuess,
    !!result || imagePaused,
  );
  updateRoundIndicators(main, imageClue, result?.difficultyTier ?? imageSession.current?.difficultyTier);
  if (result) {
    const viewport = new ClueViewport(clue, source);
    clearClue = () => viewport.destroy();
    void viewport
      .show({ dx: 0, dy: 0, level: 6 })
      .catch(() =>
        toast(msg("This view could not load. Reopen the round to retry.")),
      );
  } else if (!imagePaused) {
    clearClue = attachClueControls(clue, source, imageClue, 256, save, { difficultyTier: imageSession.current?.difficultyTier });
  }
  clue.classList.toggle("paused", imagePaused && !result);
  if (!result)
    bar.append(
      button(
        imagePaused ? msg("Resume") : msg("Pause"),
        () => {
          if (busy) return;
          imagePaused = !imagePaused;
          save();
          renderImageGame();
        },
        "small",
      ),
    );
  const actions = node("div", "game-actions");
  if (result) {
    board?.setMarkers(result.guess, result.answer);
    showMapResult(
      main,
      result.name,
      result.distance,
      `/?m=r&x=${result.answer.x}&y=${result.answer.y}&z=850`,
      result.score,
      result.difficultyTier,
    );
    actions.append(
      node("p", "", msg("Your guess is blue. The location is green.")),
      button(
        review ? msg("Back to results") : imageSession.round + 1 === imageSession.totalRounds ? msg("View results") : msg("Next round"),
        review ? finishImageGame : () => void advanceImageGame(),
        "primary",
      ),
    );
  } else {
    const confirm = button(
      msg("Submit guess"),
      () => void submitImageGame(false),
      "primary",
    );
    confirm.id = "confirm-guess";
    confirm.disabled = !imageGuess || imagePaused;
    actions.append(
      button(msg("Skip round"), () => void submitImageGame(true), "secondary"),
      guessHint(imageGuess),
      confirm,
    );
    if (imagePaused)
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
  }
  main.append(actions);
}

async function submitImageGame(skip: boolean): Promise<void> {
  if (
    !imageSession?.current ||
    imageSession.stage !== "guess" ||
    imagePaused ||
    busy
  )
    return;
  if (!skip && !imageGuess) return;
  busy = true;
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    ".game-actions button",
  ))
    b.disabled = true;
  try {
    imageSession = await imageGameRequest<ImageGameState>(
      `/sessions/${imageSession.id}/guess`,
      {
        roundId: imageSession.current.id,
        guess: skip ? null : imageGuess,
        maximum: maximumScore(imageClue),
      },
    );
    save();
    renderImageGame();
  } catch (error) {
    // A lost response must not allow a new guess after the original was saved.
    const latest = await imageGameRequest<ImageGameState>(
      `/sessions/${imageSession.id}`,
    ).catch(() => null);
    if (latest) imageSession = latest;
    save();
    renderImageGame();
    if (!latest || latest.stage === "guess") toast(msg(() => localizedError(error)));
  } finally {
    busy = false;
  }
}

async function advanceImageGame(): Promise<void> {
  if (!imageSession || busy) return;
  busy = true;
  const previousRound = imageSession.round;
  try {
    imageSession = await imageGameRequest<ImageGameState>(
      `/sessions/${imageSession.id}/next`,
      {},
    );
  } catch (error) {
    const latest = await imageGameRequest<ImageGameState>(
      `/sessions/${imageSession.id}`,
    ).catch(() => null);
    if (latest) imageSession = latest;
    if (
      !latest ||
      (latest.round === previousRound && latest.stage !== "complete")
    )
      toast(msg(() => localizedError(error)));
  } finally {
    busy = false;
    if (
      imageSession.round !== previousRound ||
      imageSession.stage === "complete"
    ) {
      imageClue = newClueProgress();
      imageGuess = null;
      imagePaused = false;
    }
    save();
    renderImageGame();
  }
}

function finishImageGame(): void {
  if (!imageSession) return home();
  view = "practice";
  const main = shell(),
    score = imageSession.results.reduce((n, r) => n + r.score, 0);
  if (imageSession.stage === "complete") {
    const entries = readHistory(storage);
    if (!entries.some((e) => e.id === imageSession!.id)) {
      entries.unshift({
        id: imageSession.id,
        at: Date.now(),
        score,
        rounds: imageSession.totalRounds,
        mode: "demo",
        difficulty: "normal",
        seed: imageSession.version,
      });
      storage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 30)));
    }
  }
  const hero = node("section", "finish-hero");
  hero.append(
    node("span", "badge practice", msg("Demo complete")),
    node("div", "total", msg(() => score.toLocaleString(guessrLocale()))),
    node(
      "p",
      "",
      msg("Maximum: {{points}}, Locations: {{locations}}", () => ({ points: (imageSession!.totalRounds * 5000).toLocaleString(guessrLocale()), locations: imageSession!.totalRounds })),
    ),
  );
  main.append(pageHeading(node("h1", "", msg("Your results")), button(msg("Back"), home)), hero);
  const actions = node("div", "finish-actions");
  actions.append(
    button(msg("Play again"), startPractice, "primary"),
  );
  main.append(actions);
  const wrap = node("div", "table-wrap"),
    table = node("table"),
    head = node("tr");
  for (const [index, name] of [
    "Round",
    "Location",
    "Distance",
    "Area",
    "Proximity",
    "Points",
    "",
  ].entries())
    head.append(node("th", index >= 3 && index <= 5 ? "numeric" : "", name ? msg(name) : ''));
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const tbody = node("tbody");
  for (const result of imageSession.results) {
    const row = node("tr");
    for (const [index, value] of [
      String(result.ordinal + 1),
      msg(() => guessrGameTerm(result.name)),
      msg(() => localizedDistance(result.distance)),
      msg(() => result.areaScore.toLocaleString(guessrLocale())),
      msg(() => result.positionScore.toLocaleString(guessrLocale())),
      msg(() => result.score.toLocaleString(guessrLocale())),
    ].entries())
      row.append(node("td", index >= 3 ? "numeric" : "", value));
    const action = node("td");
    action.append(
      button(msg("Review"), () => void reviewImageGame(result.ordinal), "small"),
    );
    row.append(action);
    tbody.append(row);
  }
  table.append(tbody);
  wrap.append(table);
  main.append(wrap);
}

async function reviewImageGame(ordinal: number): Promise<void> {
  if (!imageSession || busy) return;
  busy = true;
  try {
    const review = await imageGameRequest<{
      result: ImageRoundResult;
      clue: ClueSource;
    }>(`/sessions/${imageSession.id}/reviews/${ordinal}`);
    renderImageGame(review);
  } catch (error) {
    toast(msg(() => localizedError(error)));
  } finally {
    busy = false;
  }
}

function history(): void {
  const route = readGuessRoute(new URL(location.href));
  const channel = route.pane === 'history' ? route.channel : undefined;
  view = "history";
  setPane('history');
  const main = shell();
  if (channel && /^[a-z0-9_]{1,25}$/.test(channel)) {
    historyReplace(guessRouteUrl('history', location.href, { channel }));
    main.append(pageHeading(node('h1', '', msg('{{player}}’s results', { player: channel }), 'clock-history'),
      button(msg('Back'), () => { historyReplace(guessRouteUrl('history', location.href, { channel: '' })); history(); })));
    void streamHistorySection(main, channel); return;
  }
  const entries = readHistory(storage);
  main.append(
    pageHeading(node("h1", "", msg("History"), 'clock-history'), button(msg('Back'), home)),
  );
  void streamHistorySection(main);
  main.append(node("h2", "", msg("Demo")), node("p", "muted", msg("Your last 30 games in Demo mode on this device.")));
  const stats = node("div", "stats-grid");
  for (const [n, label] of [
    [entries.length, "Games finished"],
    [Math.max(0, ...entries.map((e) => e.score)), "Best score"],
    [entries.reduce((n, e) => n + e.rounds, 0), "Rounds played"],
  ] as const) {
    const card = node("div", "stat");
    card.append(
      node("strong", "", msg(() => n.toLocaleString(guessrLocale()))),
      node("span", "", msg(label)),
    );
    stats.append(card);
  }
  main.append(stats);
  if (!entries.length) {
    main.append(
      node("div", "empty-state", msg("You have not finished a game in Demo mode yet.")),
      button(msg("Start demo"), startPractice, "primary"),
    );
    return;
  }
  const wrap = node("div", "table-wrap"),
    table = node("table");
  for (const entry of entries) {
    const row = node("tr");
    row.append(
      node("td", "", msg(() => new Date(entry.at).toLocaleDateString(guessrLocale()))),
      node("td", "", msg(({ demo: 'Demo', classic: 'Classic', survival: 'Survival' } as Record<string, string>)[entry.mode] ?? entry.mode)),
      node("td", "", msg(({ easy: 'Easy', normal: 'Normal', hard: 'Hard' } as Record<string, string>)[entry.difficulty] ?? entry.difficulty)),
      node(
        "td",
        "score",
        msg(() => `${entry.score.toLocaleString(guessrLocale())} / ${(entry.rounds * 5000).toLocaleString(guessrLocale())}`),
      ),
    );
    table.append(row);
  }
  wrap.append(table);
  main.append(wrap);
}
function historyReplace(url: URL): void {
  window.history.replaceState(null, "", url);
}
function setPane(pane: GuessPane): void {
  historyReplace(guessRouteUrl(pane, location.href));
}
function messagePanel(
  main: HTMLElement,
  title: LocalizedText,
  message: LocalizedText,
  icon = "◇",
): HTMLElement {
  const panel = node("section", "panel empty-state");
  panel.append(
    node("div", "empty-icon", icon),
    node("h1", "", title),
    node("p", "", message),
  );
  main.append(panel);
  return panel;
}
async function rankedAccess(main: HTMLElement): Promise<GameApi | null> {
  const version = generation;
  const origin = gameApiOrigin();
  if (!origin) {
    messagePanel(main, msg('Daily unavailable'), import.meta.env.DEV
      ? msg('Daily is not configured in this local preview.')
      : msg('Daily is temporarily unavailable. Please try again later.'), '✦');
    return null;
  }
  const loading = messagePanel(
    main,
    msg("Checking access…"),
    msg("Checking your membership."),
  );
  loading.setAttribute('aria-busy', 'true');
  loading.querySelector('.empty-icon')?.remove();
  loading.append(loadingPlaceholders());
  try {
    const auth = await gameAuth();
    if (version !== generation) return null;
    loading.remove();
    const state = auth.getState();
    if (!state.isSubscriber) {
      const { createProControls } = await import("../auth/pro-controls");
      if (version !== generation) return null;
      const panel = messagePanel(
        main,
        msg("Daily requires Pro"),
        msg("Sign in with Pro to play the daily. The three-round demo is free."),
        "✦",
      );
      const controls = createProControls({
        beforeLogin: save,
        idPrefix: "guessr-daily-",
      });
      controls.classList.add("mt-5");
      panel.append(controls);
      return null;
    }
    api ??= new GameApi(origin);
    return api;
  } catch {
    if (version === generation) {
      loading.remove();
      messagePanel(
        main,
        msg("Could not check your membership."),
        msg("Please retry when your connection is ready. Your practice progress is saved."),
      );
    }
    return null;
  }
}
async function rankedLobby(resumeId?: string, day = utcDay()): Promise<void> {
  save();
  view = "ranked";
  setPane("ranked");
  ranked = null;
  if (!resumeId) {
    const url = new URL(location.href);
    url.searchParams.delete("a");
    historyReplace(url);
  }
  const main = shell();
  const dailyTitle = node('h1', '', msg('Daily'));
  const title = node('div', 'daily-page-title');
  title.append(dailyTitle, node('span', 'badge pro animation-pop', msg('Pro')));
  main.append(pageHeading(title, button(msg('Back'), home)));
  const version = generation;
  const service = await rankedAccess(main);
  if (!service || version !== generation) return;
  try {
    if (resumeId && /^[\w-]{1,100}$/.test(resumeId)) {
      const a = await service.request<RankedState>("/api/attempts/" + resumeId);
      if (version === generation) openRanked(a);
      return;
    }
    const [status, past] = await Promise.all([
      service.request<DailyStatus>("/api/daily?day=" + encodeURIComponent(day)),
      service.request<{
        attempts: {
          id: string;
          day: string;
          title: string;
          complete: boolean;
          score?: number;
          revealAt: number;
        }[];
      }>("/api/history"),
    ]);
    if (version !== generation) return;
    if (past.attempts.length) {
      const historyPanel = node("section", "panel");
      historyPanel.append(node("h2", "", msg("Your daily games")));
      const wrap = node('div', 'table-wrap'), table = node('table', 'table table-hover daily-results-table');
      const thead = node('thead'), head = node('tr'), body = node('tbody');
      for (const [index, label] of ['Date', 'Points', 'Review'].entries()) {
        const cell = node('th', index === 1 ? 'numeric' : '', index === 2 ? undefined : msg(label)); cell.scope = 'col';
        if (index === 2) cell.append(node('span', 'sr-only', msg(label)));
        head.append(cell);
      }
      thead.append(head);
      for (const a of past.attempts) {
        const row = node('tr'), date = node('td'), day = node('time', '', msg(() => new Date(a.day + 'T00:00:00Z').toLocaleDateString(guessrLocale(), { dateStyle: 'medium', timeZone: 'UTC' })));
        day.dateTime = a.day; date.append(day);
        const points = node('td', 'numeric score', msg(() => a.score === undefined ? '—' : formatGuessrNumber(a.score)));
        const action = node('td', 'result-action');
        action.append(button(a.complete ? msg('View results') : msg('Continue daily'), async () => {
          try {
            const result = await service.request<RankedState>('/api/attempts/' + a.id);
            if (version === generation) openRanked(result);
          } catch (e) { if (version === generation) toast(msg(() => localizedError(e))); }
        }, 'small secondary'));
        row.append(date, points, action); body.append(row);
      }
      table.append(thead, body); wrap.append(table); historyPanel.append(wrap);
      main.append(historyPanel);
    }
    if (!status.challenge) {
      messagePanel(
        main,
        msg("No daily available"),
        msg("No challenge is available for this date."),
        "☀",
      );
      return;
    }
    const c = status.challenge,
      panel = node("section", "panel daily-start");
    const completed = status.attemptStatus === 'complete'
      || !!status.attemptId && !!past.attempts.find(a => a.id === status.attemptId)?.complete;
    const details = node('div', 'daily-start-meta');
    const date = node('time', 'daily-start-date', msg(() => new Date(c.day + 'T00:00:00Z').toLocaleDateString(guessrLocale(), { dateStyle: 'long', timeZone: 'UTC' })));
    date.dateTime = c.day;
    details.append(date, node('span', 'muted', msg('{{rounds}} rounds', () => ({ rounds: formatGuessrNumber(c.totalRounds), count: c.totalRounds }))));
    panel.append(
      details,
      node('p', completed ? 'daily-already-played' : '', msg(completed
        ? c.day === utcDay() ? 'You’ve already played today’s Daily.' : 'You’ve already played this Daily.'
        : 'No time limit. Your progress saves automatically.')),
    );
    panel.append(
      button(
        status.attemptId ? completed ? msg("View results") : msg("Continue daily") : msg("Start daily"),
        async () => {
          if (busy) return;
          busy = true;
          try {
            const a = status.attemptId
              ? await service.request<RankedState>(
                  "/api/attempts/" + status.attemptId,
                )
              : await service.request<RankedState>("/api/attempts", {
                  body: { challengeId: c.id },
                });
            if (version === generation) openRanked(a);
          } catch (e) {
            toast(msg(() => localizedError(e)));
          } finally {
            busy = false;
          }
        },
        "primary",
      ),
    );
    main.insertBefore(panel, main.querySelector(".panel"));
  } catch (e) {
    if (version === generation)
      messagePanel(main, msg("Daily unavailable"), msg(() => localizedError(e)));
  }
}
function openRanked(state: RankedState, reviewRound?: number): void {
  rememberDailyResume(state, storage);
  ranked = state;
  rankedGuess = null;
  rankedClue = newClueProgress();
  if (state.config && state.clue) {
    const saved = restoreDailyView(storage, { id: state.id, round: state.round, version: state.config.version, bounds: state.bounds, clue: state.clue });
    rankedClue = saved.progress; rankedGuess = saved.guess;
  }
  const url = guessRouteUrl('ranked', location.href);
  url.searchParams.set("a", state.id);
  historyReplace(url);
  view = "ranked";
  if (reviewRound !== undefined) reviewRanked(reviewRound, true);
  else renderRanked();
}
async function rankedImage(
  clue: HTMLElement,
  path: string,
  crop = 1,
): Promise<void> {
  const version = generation;
  imageAbort?.abort();
  imageAbort = new AbortController();
  clue.replaceChildren(clueLoadingPlaceholder());
  clue.classList.add("loading");
  try {
    const blob = await api!.image(path, imageAbort.signal);
    if (version !== generation) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(blob);
    putClue(clue, imageUrl, crop);
  } catch (e) {
    if (version === generation) {
      clue.classList.remove("loading");
      clue.append(
        node("div", "notice error", msg(() => localizedError(e))),
        button(msg("Retry image"), () => rankedImage(clue, path, crop), "small"),
      );
    }
  }
}
function renderRanked(): void {
  if (!ranked) return;
  view = "ranked";
  const main = shell(true);
  if (ranked.status !== "active") {
    const hero = node("section", "finish-hero");
    hero.append(
      node("span", "badge pro animation-pop", msg("Daily result")),
      node("div", "total", msg(() => (ranked?.score || 0).toLocaleString(guessrLocale()))),
      node("p", "", msg("out of {{value1}}", () => ({ value1: (ranked!.totalRounds * 5000).toLocaleString(guessrLocale()) }))),
    );
    main.append(pageHeading(node("h1", "", ranked.title), button(msg("Back to daily"), rankedLobby)), hero);
    const results = dailyResultsTable(ranked, reviewRanked);
    main.append(results.element);
    clearClue = results.destroy;
    return;
  }
  main.append(
    gameHud({
      label: "Daily",
      badge: "pro",
      round: ranked.round + 1,
      total: ranked.totalRounds,
      score: (ranked.results ?? []).reduce(
        (sum, r) => sum + (r.guess?.score ?? 0),
        0,
      ),
      exit: rankedLobby,
    }),
  );
  const { clue } = makePlayPanels(main, rankedGuess, false);
  updateRoundIndicators(main, rankedClue, ranked.difficultyTier);
  if (ranked.clue) clearClue = attachClueControls(clue, ranked.clue, rankedClue, 256, saveRankedView, { difficultyTier: ranked.difficultyTier });
  else if (ranked.image) void rankedImage(clue, ranked.image);
  const actions = node("div", "game-actions"),
    submit = button(msg("Submit guess"), () => submitRanked(false), "primary");
  submit.id = "confirm-guess";
  submit.disabled = !rankedGuess;
  actions.append(
    button(msg("Skip round"), () => submitRanked(true), "secondary"),
    guessHint(rankedGuess),
    submit,
  );
  main.append(actions);
}
async function submitRanked(skip: boolean): Promise<void> {
  if (
    !api ||
    !ranked ||
    ranked.status !== "active" ||
    busy ||
    (!skip && !rankedGuess)
  )
    return;
  busy = true;
  document.getElementById("ranked-save-error")?.remove();
  const version = generation;
  board?.setLocked(true);
  const current = { ...ranked };
  const key = "noitamap-guessr-pending-" + current.id;
  let body: { round: number; guess: Point | null; requestId: string; maximum?: number };
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    body =
      saved?.round === current.round
        ? saved
        : {
            round: current.round,
            guess: skip ? null : rankedGuess,
            requestId: crypto.randomUUID(),
            ...(current.clue ? { maximum: maximumScore(rankedClue) } : {}),
          };
    sessionStorage.setItem(key, JSON.stringify(body));
  } catch {
    body = {
      round: current.round,
      guess: skip ? null : rankedGuess,
      requestId: crypto.randomUUID(),
      ...(current.clue ? { maximum: maximumScore(rankedClue) } : {}),
    };
  }
  try {
    const next = await api.request<RankedState>(
      "/api/attempts/" + current.id + "/guess",
      { body },
    );
    try {
      sessionStorage.removeItem(key);
    } catch {}
    if (version === generation) openRanked(next, current.round);
  } catch (e) {
    if (version === generation) {
      const main = document.querySelector("main")!,
        box = node("div", "notice error");
      box.id = "ranked-save-error";
      box.append(
        node("span", "", msg(() => localizedError(e) + ' ')),
        button(msg("Retry saving this guess"), () => submitRanked(skip), "small"),
      );
      main.append(box);
      announce(msg("Your guess was not confirmed. Retry to save it."));
    }
  } finally {
    busy = false;
  }
}
function reviewRanked(ordinal: number, continueGame = false): void {
  const r = ranked?.results?.find((r) => r.ordinal === ordinal);
  if (!r) return;
  const main = shell(true);
  main.append(
    gameHud({
      label: "Daily",
      badge: "pro",
      round: ordinal + 1,
      total: ranked!.totalRounds,
      score: (ranked!.results ?? []).reduce(
        (sum, result) => sum + (result.guess?.score ?? 0),
        0,
      ),
      exit: rankedLobby,
    }),
  );
  const guess =
    r.guess?.x != null && r.guess.y != null
      ? { x: r.guess.x, y: r.guess.y }
      : null;
  const { clue, bar } = makePlayPanels(main, guess, true);
  bar.append(node("span", "hint", msg(() => guessrGameTerm(r.biome))));
  if (r.clue) {
    const viewport = new ClueViewport(clue, r.clue);
    clearClue = () => viewport.destroy();
    void viewport.show({ dx: 0, dy: 0, level: 6 }).catch(() => {
      if (!clue.isConnected) return;
      clue.classList.remove('loading');
      clue.append(node('p', 'error', msg('Image could not load. No points were charged.')),
        button(msg('Retry image'), () => reviewRanked(ordinal, continueGame), 'small secondary'));
    });
  } else void rankedImage(clue, r.image, 1);
  board?.setMarkers(guess, r.answer);
  showMapResult(
    main,
    r.name,
    r.guess?.distance ?? null,
    `/?m=dy&se=${r.seed}&ds=1&x=${r.answer.x}&y=${r.answer.y}&z=850`,
    r.guess?.score ?? 0,
    r.difficultyTier,
  );
  const actions = node("div", "game-actions");
  actions.append(
    node("p", "", msg("Green: correct location. Blue: your guess.")),
    button(
      continueGame ? ranked?.status === "complete" ? msg("View results") : msg("Next round") : msg("Back to results"),
      renderRanked,
      "primary",
    ),
  );
  main.append(actions);
}
function help(): void {
  const existing = document.getElementById("guessr-help-dialog");
  if (existing) {
    void Dialog.getOrCreateInstance(existing).show();
    return;
  }
  const trigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const dialog = node("dialog", "dialog dialog-scrollable");
  dialog.id = "guessr-help-dialog";
  dialog.setAttribute("aria-labelledby", "guessr-help-title");
  const header = node("div", "dialog-header");
  const title = node("h1", "dialog-title fs-lg", msg("How to play"), 'info-circle');
  title.id = "guessr-help-title";
  const dismiss = node("button", "btn-close");
  dismiss.type = "button";
  dismiss.setAttribute("data-bs-dismiss", "dialog");
  bindAttribute(dismiss, 'aria-label', 'Close');
  header.append(title, dismiss);
  const body = node("div", "dialog-body");
  body.append(
    instructionSteps(
      node('p', 'mb-0', msg('Find the starting point marked on the clue map.')),
      node('p', 'mb-0', msg('Explore with the buttons below the clue map. Each button shows its point cost. Moving back and zooming in are free.')),
      node('p', 'mb-0', msg('Place your pin on the world map, then submit your guess.')),
    ),
    node("p", "", msg("No time limit. Your progress saves automatically.")),
  );
  const footer = node("div", "dialog-footer");
  const close = node("button", "btn-solid theme-primary", msg("Close"));
  close.type = "button";
  close.setAttribute("data-bs-dismiss", "dialog");
  footer.append(close);
  dialog.append(header, body, footer);
  document.body.append(dialog);
  const instance = new Dialog(dialog);
  dialog.addEventListener(
    "hidden.bs.dialog",
    () => {
      instance.dispose();
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    },
    { once: true },
  );
  void instance.show(trigger ?? undefined);
}
window.addEventListener("pagehide", save);
if (!isGuessrAvailable(location.hostname, import.meta.env.DEV)) {
  location.replace(GUESSR_CANONICAL_URL);
} else
  try {
    await initializeGuessrTranslations();
    const config = await imageGameRequest<ImageGameConfig>("/config");
    const route = readGuessRoute(new URL(location.href)), pane = route.pane;
    historyReplace(guessRouteUrl(pane, location.href, route));
    pack = { ...config, seed: 0, places: [] };
    streamUI = new StreamUI({
      config,
      shell,
      panels: makePlayPanels,
      cleanupClue: (cleanup) => {
        clearClue = cleanup;
      },
      markers: (guess, answer) => board?.setMarkers(guess, answer),
      hud: gameHud,
      result: showMapResult,
      home,
      toast,
    });
    if (pane !== "stream-picker" && pane !== "stream-result") try {
      const saved = JSON.parse(storage.getItem(IMAGE_SESSION_KEY) || "null");
      if (
        saved?.version === config.version &&
        /^[a-f0-9-]{36}$/.test(saved.id)
      ) {
        imageSession = await imageGameRequest<ImageGameState>(
          `/sessions/${saved.id}`,
        );
        const c = saved.clue;
        if (
          saved.roundId === imageSession.current?.id &&
          c &&
          supportedCamera(imageSession.current!.clue, c) &&
          Number.isInteger(c.widest) &&
          c.widest >= c.level &&
          c.widest <= 6 &&
          Number.isInteger(c.travelSpent) &&
          c.travelSpent >= 0 &&
          c.travelSpent <= 5000 &&
          Array.isArray(c.visited) &&
          c.visited.length <= 512 &&
          c.visited.every(
            (s: unknown) => typeof s === "string" && /^-?\d+,-?\d+$/.test(s),
          )
        ) {
          imageClue = c;
          imageGuess = within(saved.guess, pack.bounds) ? saved.guess : null;
          imagePaused = saved.paused === true;
        }
      }
    } catch {
      imageSession = null;
    }
    if (pane === "stream") openStream();
    else if (pane === "stream-picker") openStreamPicker();
    else if (pane === "stream-result") {
      view = "stream";
      void streamUI.publicResult(
        route.result || "",
      );
    } else if (
      pane === "ranked" ||
      new URLSearchParams(location.hash.slice(1)).has("auth")
    )
      void rankedLobby(
        new URL(location.href).searchParams.get("a") || undefined,
      );
    else if (pane === "practice" && (imageSession || session)) renderPractice();
    else if (pane === 'history') history();
    else home();
  } catch (error) {
    root.replaceChildren(
      node("div", "empty-state", msg(() => localizedError(error))),
      button(msg("Try again"), () => location.reload(), "primary"),
      link(msg("Back to Noitamap"), "/"),
    );
  }
