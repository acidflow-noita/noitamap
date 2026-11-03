import "./lobby.css";
import { confirmQuitGame } from './quit-game';
import { bindText, bindAttribute, tr, formatGuessrNumber, guessrLocale } from './i18n';
import { msg, setText, type LocalizedText } from './messages';
import { iconLabel, type ControlIcon } from './control-icons';

type LobbyAction = () => unknown;

export interface LobbyResult {
  score: number;
  rounds: number;
}

export interface LobbyOptions {
  startDemo: LobbyAction;
  dailyToday: LobbyAction;
  dailyYesterday: LobbyAction;
  streamHost: LobbyAction;
  streamJoin?: LobbyAction;
  resume?: {
    modeLabel: string;
    continueLabel: string;
    twitch?: boolean;
    currentRound: number;
    totalRounds: number;
    completedRounds: number;
    action: LobbyAction;
    quit: LobbyAction;
    quitDescription?: string;
  };
  history?: {
    recent: LobbyResult;
    best: LobbyResult;
    action: LobbyAction;
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: LocalizedText,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) setText(node, text);
  return node;
}

function actionButton(
  label: LocalizedText,
  action: LobbyAction,
  primary = false,
  icon?: ControlIcon,
): HTMLButtonElement {
  const button = element(
    "button",
    primary ? "btn-solid primary" : "btn-outline secondary",
    icon ? undefined : label,
  );
  if (icon) {
    button.classList.add('with-icon');
    button.append(iconLabel(icon, label));
  }
  button.type = "button";
  button.addEventListener("click", () => void action());
  return button;
}

function modeCard(options: {
  name: string;
  image: string;
  description: string;
  badge: string;
  pro?: boolean;
  twitch?: boolean;
  actions: HTMLButtonElement[];
}): HTMLElement {
  const card = element("section", "card lobby-mode rounded-9");
  const image = element("img", "card-img-top lobby-mode-image");
  image.src = `/guessr/lobby/${options.image}.webp`;
  image.alt = "";
  image.width = 864;
  image.height = 384;
  image.decoding = "async";
  image.draggable = false;

  const body = element("div", "card-body lobby-mode-body");
  const heading = element("div", "lobby-mode-heading");
  heading.append(
    element("h2", options.twitch ? "twitch-mode-label" : "", msg(options.name)),
    element("span", options.pro ? "badge pro animation-pop" : "badge", msg(options.badge)),
  );
  const actions = element("div", "lobby-mode-actions");
  actions.append(...options.actions);
  body.append(
    heading,
    element("p", "lobby-mode-description", msg(options.description)),
    actions,
  );
  card.append(image, body);
  return card;
}

function continueGame(
  resume: NonNullable<LobbyOptions["resume"]>,
): HTMLElement {
  const card = element("section", "card lobby-resume");
  bindAttribute(card, 'aria-label', resume.continueLabel);
  const body = element("div", "card-body lobby-resume-body");
  const details = element("div", "lobby-resume-details");
  const total = Math.max(1, resume.totalRounds);
  const current = Math.max(1, Math.min(total, resume.currentRound));
  const completed = Math.max(0, Math.min(total, resume.completedRounds));
  details.append(
    element("h2", resume.twitch ? "twitch-mode-label" : "", msg("{{value1}} in progress", () => ({ value1: tr(resume.modeLabel) }))),
    element("span", "lobby-resume-round", msg("Round {{value1}} of {{value2}}", () => ({ value1: current, value2: total }))),
  );
  const progress = element("div", "lobby-rounds");
  progress.setAttribute("role", "progressbar");
  bindAttribute(progress, 'aria-label', 'Completed rounds');
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", String(total));
  progress.setAttribute("aria-valuenow", String(completed));
  bindAttribute(progress, 'aria-valuetext', '{{completed}} of {{total}} rounds completed', { completed, total });
  for (let round = 1; round <= total; round++) {
    const segment = element(
      "span",
      round <= completed ? "complete" : round === current ? "current" : "",
    );
    progress.append(segment);
  }
  body.append(
    details,
    progress,
    actionButton(msg(resume.continueLabel), resume.action, true),
    actionButton(msg("Exit game"), () => confirmQuitGame(resume.quit, resume.quitDescription)),
  );
  card.append(body);
  return card;
}

function historySummary(
  history: NonNullable<LobbyOptions["history"]>,
): HTMLElement {
  const card = element("section", "card lobby-history");
  bindAttribute(card, 'aria-label', 'Your results');
  const body = element("div", "card-body lobby-history-body");
  const scores = element("dl", "lobby-scores");
  for (const [label, result] of [
    ["Recent score", history.recent],
    ["Best score", history.best],
  ] as const) {
    const entry = element("div", "lobby-score");
    const score = element("dd");
    score.append(
      element("strong", "", msg(() => result.score.toLocaleString(guessrLocale()))),
      element("span", "", msg(() => ` / ${(result.rounds * 5000).toLocaleString(guessrLocale())}`)),
    );
    entry.append(element("dt", "", msg(label)), score);
    scores.append(entry);
  }
  body.append(scores, actionButton(msg("View history"), history.action, false, 'clock-history'));
  card.append(body);
  return card;
}

/** Creates only the lobby content; the app owns navigation, sessions and auth. */
export function createLobby(options: LobbyOptions): HTMLElement {
  const lobby = element("div", "guessr-lobby");
  lobby.append(element("h1", "visually-hidden", msg("Choose a game")));
  if (options.resume) lobby.append(continueGame(options.resume));

  // Fixed scenery from the archived seed 78633191 capture, never today's clues.
  const modes = element("div", "lobby-modes");
  const streamActions = [actionButton(msg("Play as streamer"), options.streamHost, true)];
  if (options.streamJoin) {
    const chatterAction = actionButton(msg("Play as chatter"), options.streamJoin);
    chatterAction.classList.replace('btn-outline', 'btn-solid');
    chatterAction.classList.add('theme-secondary');
    streamActions.push(chatterAction);
  }
  modes.append(
    modeCard({
      name: "Demo",
      image: "mountain",
      description: "Three rounds from the main world.",
      badge: "Free",
      actions: [actionButton(msg("Start demo"), options.startDemo, true)],
    }),
    modeCard({
      name: "Daily",
      image: "snowy-depths",
      description: "The same daily challenge for everyone.",
      badge: "Pro",
      pro: true,
      actions: [
        actionButton(msg("Today"), options.dailyToday, true),
        actionButton(msg("Yesterday"), options.dailyYesterday),
      ],
    }),
    modeCard({
      name: "Chat vs Streamer",
      twitch: true,
      image: "fungal-caverns",
      description: "Challenge your chat to find the location.",
      badge: "Streamer with Pro",
      pro: true,
      actions: streamActions,
    }),
  );
  lobby.append(modes);
  if (options.history) lobby.append(historySummary(options.history));
  return lobby;
}
