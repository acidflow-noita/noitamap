import Dialog from 'bootstrap/js/dist/dialog.js';
import { gameAuth } from './api';
import { bindAttribute, bindText, formatGuessrNumber, formatPollDate, guessrGameTerm, guessrLocale, tr } from './i18n';
import { HARD_PUZZLE_POLL_SECONDS, type GuessrBallot, type PollChoice } from '../../workers/noitamap-auth/src/poll-contract';
import './hard-poll.css';

const choices = { yes: 'Yes, allow up to one per game', no: 'No, leave hard puzzles out' } as const;
const examples = [
  { file: 'dense-rock', area: 'Extremely dense rock', description: 'Zooming out still shows only {{area}}. As in a regular round here, most points come from how close your guess is.' },
  { file: 'hell', area: 'The Work (Hell)', description: 'Zooming out still shows only the background. Compared with a regular round, more points come from finding the right area and fewer from the exact pin position.' },
] as const;

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  if (label) bindText(control, label);
  control.className = className; control.type = 'button'; control.onclick = action;
  return control;
}

function exampleGallery(): HTMLElement {
  const section = document.createElement('div'), picker = document.createElement('div');
  picker.className = 'poll-examples'; picker.setAttribute('role', 'group');
  bindAttribute(picker, 'aria-label', 'Example puzzles');
  const link = document.createElement('a'), image = document.createElement('img');
  link.target = '_blank'; link.rel = 'noopener';
  image.width = 1185; image.height = 316; image.decoding = 'async';
  const caption = document.createElement('p'), explanation = document.createElement('p');
  caption.className = 'poll-caption'; explanation.className = 'poll-explanation';
  bindText(caption, 'The clue on the left is zoomed all the way out. On the right, the blue pin is an example guess. The green target shows the answer.');
  const show = (index: number) => {
    const example = examples[index];
    for (const [i, control] of Array.from(picker.children).entries()) control.setAttribute('aria-pressed', String(i === index));
    image.src = link.href = '/guessr/polls/hard-puzzles-v1/' + example.file + '.webp';
    bindAttribute(image, 'alt', 'Clue and answer map for {{area}}', () => ({ area: guessrGameTerm(example.area) }));
    bindText(explanation, example.description, () => ({ area: guessrGameTerm(example.area) }));
  };
  examples.forEach((example, index) => {
    const control = button('', 'btn btn-sm btn-outline theme-secondary', () => show(index));
    bindText(control, () => guessrGameTerm(example.area)); picker.append(control);
  });
  link.append(image); section.append(picker, link, caption, explanation); show(0);
  return section;
}

export function openHardPoll(trigger: HTMLButtonElement, draft: PollChoice | null,
  beforeLogin: (choice: PollChoice | null) => void, afterVote: () => void, publishedStart?: number): void {
  if (document.querySelector('dialog[open], #guessr-hard-poll')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'guessr-hard-poll';
  dialog.className = 'dialog dialog-scrollable dialog-instant hard-poll-dialog';
  dialog.setAttribute('aria-labelledby', 'guessr-poll-question');
  const header = document.createElement('div'); header.className = 'dialog-header';
  const title = bindText(document.createElement('h1'), 'Should NoitaGuessr games include hard puzzles?');
  title.id = 'guessr-poll-question'; title.className = 'dialog-title';
  const heading = document.createElement('div'), dates = document.createElement('p');
  dates.className = 'poll-dates'; heading.append(title, dates);
  const x = document.createElement('button'); x.type = 'button'; x.className = 'btn-close'; x.dataset.bsDismiss = 'dialog';
  bindAttribute(x, 'aria-label', 'Close'); header.append(heading, x);
  const body = document.createElement('div'); body.className = 'dialog-body';
  const intro = bindText(document.createElement('p'), 'A hard clue can show no landmarks even after you zoom out. This vote is about allowing up to one per game in {{modes}}.',
    () => ({ modes: new Intl.ListFormat(guessrLocale()).format(['Demo', 'Daily', 'Chat vs Streamer', '1v1'].map(mode => tr(mode))) }));
  const scoring = bindText(document.createElement('p'), 'The maximum is still {{points}} points. Clue navigation costs stay the same.',
    () => ({ points: formatGuessrNumber(5000) }));
  body.append(intro, exampleGallery(), scoring);
  const options = document.createElement('fieldset'), legend = bindText(document.createElement('legend'), 'Your vote');
  options.className = 'poll-options'; legend.className = 'sr-only'; options.append(legend);
  const inputs = new Map<PollChoice, HTMLInputElement>();
  for (const key of ['yes', 'no'] as const) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'guessr-hard-puzzle-choice'; input.value = key; input.checked = draft === key;
    label.append(input, bindText(document.createElement('span'), choices[key])); options.append(label); inputs.set(key, input);
  }
  const rule = bindText(document.createElement('p'), 'One final vote per account. The totals become public when voting closes.');
  rule.className = 'poll-rule'; body.append(options, rule);
  const footer = document.createElement('div'); footer.className = 'dialog-footer';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'poll-actions'; footer.append(status, actions);
  dialog.append(header, body, footer); document.body.append(dialog);
  const instance = new Dialog(dialog);
  let auth: Awaited<ReturnType<typeof gameAuth>> | undefined, ballot: GuessrBallot | null = null;
  let owner: string | undefined, loading = true, saving = false, error = '', revision = 0, unsubscribe: (() => void) | undefined;
  let boundaryTimer: number | undefined, missedClose = false;
  const selected = () => ([...inputs].find(([, input]) => input.checked)?.[0] ?? null);
  const paint = () => {
    actions.replaceChildren();
    const start = ballot?.opensAt ?? publishedStart;
    dates.hidden = !start;
    if (start) {
      const end = ballot?.closesAt ?? start + HARD_PUZZLE_POLL_SECONDS;
      const now = ballot?.serverNow ?? Date.now() / 1000;
      if (now < start) bindText(dates, 'Voting runs from {{start}} to {{end}}.',
        () => ({ start: formatPollDate(start, true), end: formatPollDate(end, true) }));
      else bindText(dates, now >= end ? 'Voting closed {{when}}.' : 'Voting closes {{when}}.',
        () => ({ when: formatPollDate(end, true) }));
    }
    if (ballot?.vote) for (const [key, input] of inputs) input.checked = key === ballot.vote;
    options.hidden = !ballot || (ballot.phase !== 'open' && !ballot.vote);
    options.disabled = loading || saving || !!ballot?.vote || ballot?.phase !== 'open';
    rule.hidden = options.hidden || !!ballot?.vote;
    if (saving || loading) { bindText(status, saving ? 'Saving your vote…' : 'Loading poll…'); return; }
    if (error) {
      bindText(status, error); actions.append(button('Retry', 'btn btn-outline theme-secondary', () => void load())); return;
    }
    if (!ballot) { bindText(status, 'This poll has not opened.'); return; }
    if (ballot.phase === 'closed' && ballot.totals) {
      const { yes, no } = ballot.totals;
      bindText(status, missedClose ? 'Voting closed before your vote was recorded. {{yes}} in favor, {{no}} against.'
        : '{{yes}} in favor, {{no}} against', () => ({ yes: formatGuessrNumber(yes), no: formatGuessrNumber(no) }));
      return;
    }
    if (ballot.vote) { bindText(status, 'Vote recorded for this account.'); return; }
    if (ballot.phase !== 'open') { bindText(status, ''); return; }
    if (!owner) {
      bindText(status, 'Sign in to vote');
      actions.append(button('Sign in with Twitch', 'btn btn-twitch', () => { beforeLogin(selected()); auth?.loginTwitch(); }),
        button('Sign in with Patreon', 'btn btn-patreon', () => { beforeLogin(selected()); auth?.login(); }));
      return;
    }
    bindText(status, '');
    const cast = button('Cast vote', 'btn btn-solid theme-success', () => void submit());
    cast.disabled = !selected(); actions.append(cast);
  };
  const accept = (received: GuessrBallot | null) => {
    ballot = received; window.clearTimeout(boundaryTimer);
    if (!received) return;
    if (received.vote) afterVote();
    if (received.phase === 'closed') return;
    const next = received.phase === 'scheduled' ? received.opensAt : received.closesAt;
    boundaryTimer = window.setTimeout(() => { if (!saving && dialog.isConnected) void load(); },
      Math.min(2147483647, Math.max(1000, (next - received.serverNow) * 1000 + 100)));
  };
  const load = async () => {
    const current = ++revision;
    loading = true; error = ''; paint();
    try {
      const service = await gameAuth();
      if (!dialog.isConnected || current !== revision) return;
      auth = service; owner = auth.getState().accountId;
      unsubscribe ??= auth.subscribe(state => {
        if (state.accountId === owner) return;
        for (const input of inputs.values()) input.checked = false;
        ballot = null; saving = false; missedClose = false; void load();
      });
      const received = await auth.guessrBallot();
      if (current === revision) accept(received);
    } catch { if (current === revision) error = 'The poll is unavailable. Try again.'; }
    finally { if (dialog.isConnected && current === revision) { loading = false; paint(); } }
  };
  const submit = async () => {
    const answer = selected();
    if (!auth || !owner || !answer || saving || loading || ballot?.phase !== 'open' || ballot.vote) return;
    const current = ++revision;
    saving = true; error = ''; paint();
    try {
      const received = await auth.guessrBallot(answer, owner);
      if (current !== revision) return;
      missedClose = received?.phase === 'closed' && !received.vote;
      accept(received);
    } catch { if (current === revision) error = 'Your vote could not be confirmed. Please retry.'; }
    finally { if (dialog.isConnected && current === revision) { saving = false; paint(); } }
  };
  options.onchange = paint;
  dialog.addEventListener('hidden.bs.dialog', () => {
    revision++; window.clearTimeout(boundaryTimer); unsubscribe?.(); instance.dispose(); dialog.remove();
    if (trigger.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
  }, { once: true });
  void instance.show(trigger); void load();
}
