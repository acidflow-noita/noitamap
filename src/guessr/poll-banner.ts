import { bindAttribute, bindText, formatPollDate } from './i18n';
import { HARD_PUZZLE_POLL_SECONDS, type PollChoice } from '../../workers/noitamap-auth/src/poll-contract';
import windowConfig from '../../public/guessr/polls/hard-puzzles-v1/window.json';

const hiddenKey = 'guessr-hard-poll-hidden-v1';
const returnKey = 'guessr-hard-poll-return-v1';
const receiptKey = 'guessr-hard-poll-receipt-v1';

export function createPollBanner(beforeLogin: () => void, opensAt: number | null = windowConfig.opensAt): HTMLElement {
  const bar = document.createElement('aside');
  bar.className = 'guessr-poll-bar';
  if (!opensAt || !Number.isSafeInteger(opensAt) || Date.now() / 1000 >= opensAt + HARD_PUZZLE_POLL_SECONDS) {
    bar.hidden = true;
    return bar;
  }
  const closesAt = opensAt + HARD_PUZZLE_POLL_SECONDS;
  const invite = document.createElement('button');
  invite.type = 'button';
  invite.className = 'poll-invite';
  const action = bindText(document.createElement('strong'), 'Vote');
  const deadline = document.createElement('time');
  deadline.className = 'poll-deadline'; deadline.dateTime = new Date(closesAt * 1000).toISOString();
  const name = document.createElement('span'), short = bindText(document.createElement('span'), 'Hard puzzles?');
  short.className = 'poll-short-title';
  name.append(bindText(document.createElement('span'), 'Hard puzzles in NoitaGuessr?'), short);
  invite.append(name, deadline, action);
  invite.setAttribute('aria-haspopup', 'dialog');
  invite.setAttribute('aria-controls', 'guessr-hard-poll');
  const dismiss = document.createElement('button');
  dismiss.className = 'btn-close';
  dismiss.type = 'button';
  bindAttribute(dismiss, 'aria-label', 'Dismiss poll for this session');
  bar.append(invite, dismiss);
  const hide = () => {
    bar.hidden = true;
    try { sessionStorage.setItem(hiddenKey, '1'); } catch { /* The current page still hides it. */ }
  };
  const received = () => {
    bindText(action, 'View poll');
    try { sessionStorage.setItem(receiptKey, '1'); } catch { /* The receipt still comes from the server. */ }
  };
  const updateWindow = () => {
    const now = Date.now() / 1000;
    if (now >= closesAt) { bar.hidden = true; return; }
    const before = now < opensAt;
    bindText(deadline, 'Closes {{when}}', () => ({ when: formatPollDate(closesAt) }));
    if (before) bindText(action, 'View poll');
    else {
      try { bindText(action, sessionStorage.getItem(receiptKey) === '1' ? 'View poll' : 'Vote'); }
      catch { bindText(action, 'Vote'); }
    }
    const next = before ? opensAt : closesAt;
    if (now < next) window.setTimeout(updateWindow, Math.min(2147483647, Math.ceil((next - now) * 1000)));
  };
  const open = async (choice: PollChoice | null = null, returning = false) => {
    const { openHardPoll } = await import('./hard-poll');
    if (!bar.isConnected || bar.hidden || Date.now() / 1000 >= closesAt) return;
    const other = document.querySelector('dialog[open]');
    if (returning && other) {
      other.addEventListener('close', () => void open(choice, true), { once: true }); return;
    }
    openHardPoll(invite, choice, draft => {
      beforeLogin();
      try {
        sessionStorage.setItem(returnKey, JSON.stringify({ path: location.pathname, choice: draft, at: Date.now() }));
      } catch { /* Sign-in still works without a saved draft. */ }
    }, received, opensAt);
  };
  invite.onclick = () => void open();
  dismiss.onclick = hide;
  try {
    bar.hidden = sessionStorage.getItem(hiddenKey) === '1';
    if (sessionStorage.getItem(receiptKey) === '1') bindText(action, 'View poll');
    const saved = JSON.parse(sessionStorage.getItem(returnKey) || 'null');
    sessionStorage.removeItem(returnKey);
    if (saved?.path === location.pathname && saved.at <= Date.now() && saved.at > Date.now() - 15 * 60000
      && [null, 'yes', 'no'].includes(saved.choice)) {
      bar.hidden = false;
      void open(saved.choice, true);
    }
  } catch { /* The poll is usable when storage is unavailable. */ }
  updateWindow();
  return bar;
}
