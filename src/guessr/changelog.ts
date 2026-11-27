import Dialog from 'bootstrap/js/dist/dialog.js';
import { bindAttribute, bindText, guessrLocale, tr } from './i18n';
import { readGuessRoute } from './routes';
import { featureLabel, guessrFeatures, latestFeatures } from './release-features';

const isMainPage = () => readGuessRoute(new URL(location.href)).pane === 'home';

// One announcement per release day. Editing hotfix notes must not reopen it.
export const GUESSR_CHANGELOG = {
  id: '2026-11-27-round-replays',
  date: '2026-11-27',
  features: latestFeatures,
  notes: [
    'Players voted 8 to 2 to exclude hard puzzles. This applies to new games in all four modes.',
    'The clue and guess panels line up side by side. {{nextRound}} now appears above the maps.',
    'In round reviews, {{backToResults}} is at the top left.',
    'You can now quit an unfinished game from the {{dailyMode}} page.',
    'The lobby now starts with your saved game or the game modes.',
    'In {{streamMode}}, the {{hostAction}} and {{chatterAction}} buttons are now side by side.',
    'On phones, the top navigation stays in one row.',
    'The game menu shows wider map previews.',
    'The menu puts {{dailyMode}} beside the other game modes. On phones, each mode has a compact card.',
    'The clue appears above its controls. On small screens, a cost of 0 means the move is free.',
    'Round count and duration are together in game setup.',
    'Round previews open below their row. Share, Save and the standings are closer together.',
    'On shared {{dailyMode}} results, {{share}} and {{answers}} appear above the scores.',
    'The sign-in panel is centered on the {{dailyMode}} page. Twitch sign-in buttons no longer show the Beta badge.',
    'When a streamer reconnects during an open round, their saved pin is ready to submit.',
    "Choose \"{{whatsNew}}\" in the header to read these notes again.",
    "The connection dot glows and pulses slowly while connected. Reduced motion keeps it steady.",
    "Round progress and sharing controls are aligned with the timer.",
    "The join confirmation appears at the top center in green.",
    "Game headers use the same round indicator as the main page.",
    "Status messages stay at the bottom without moving the maps. The streamer name and game mode share one line.",
    "Opening an invitation link joins the game automatically after you sign in.",
    "The timer and sharing controls stay inside the game header.",
    "Submitting a guess keeps the maps and controls in place.",
    "Buttons now use consistent rounded corners, including Pro gift and account controls.",
    "The update notice no longer opens again for each small fix.",
    "{{whatsNew}} now opens automatically only on the NoitaGuessr main page.",
    "Fixed flickering in the game view for chat participants.",
    "Zoom controls line up with the bottom row of movement buttons.",
    "The streamer’s Pro badge stays beside their name in the chatter view.",
    "The button for sharing a game link fits within the header, including longer translations.",

    "The sharing button is now next to {{startGame}} in the lobby. Its status appears underneath.",
    "Expired lobbies no longer reopen as ready. Leaving an unavailable game returns you to the menu.",
    "Account-link confirmation hides account names and IDs until you choose to show them.",
    "Account-link buttons now match the rest of the interface.",

    "Updated the game layout with a centered timer and clearer controls.",
    "Map zoom and reset controls are now visible on desktop and mobile.",
    "Pan buttons use a directional layout. Keyboard shortcuts use the same blue labels as the drawing tools.",
    "The Send button shows a spinner while sending and a checkmark after confirmation.",
    "The account menu now keeps sign-in, Pro status and sign-out together.",
    "Stay signed in when you close and reopen the browser. You can refresh Pro status from your account.",
    "Connection status appears in the logo pin. Hover or focus the pin for details.",

    'Play 1v1 with an invited opponent. The host needs Pro. The opponent can play for free.',
    'The "{{streaming}}" option lets chat or your opponent play one round ahead. Turn it off to play each round together. It is on by default for {{streamMode}} and off for 1v1.',
    '{{streamMode}} uses the {{dailyMode}} map with a new set of locations for each game.',
    'Fixed an error that stopped you from creating a game in {{streamMode}} mode.',
    'Before you start a {{streamMode}} game, allow NoitaGuessr to post messages in your Twitch chat.',
    'Submitted answers no longer appear in Twitch chat. Hosts can still post invitation and result links in their channel.',
    "Fixed repeated sign-in requests. Fixed missing changes to a player's submitted answer after a reconnect or page refresh.",
    '1v1 uses your existing Pro sign-in. The lobby shows both players and whether they are ready.',
    'Waiting and ready panels are centered.',
    'If you give up a 1v1 match, the results page opens.',
    'On phones, game panels use the full width, with more room for the clue and touch controls.',
    'Use W, A, S and D to move the clue image. Q zooms out. E zooms in.',
    'Move the guess map with the arrow keys. Zoom with + and -.',
    'Clue navigation buttons show their keyboard shortcuts.',
    'The "{{received}}" button now looks disabled after your guess is confirmed.',
    'In the results for each round, only player names use player colors. A perfect score of 5,000 points appears in gold.',
    "Game history shows each player's rank and score.",
    'The game results page has a smaller title and a narrower rank column.',
    'If you reach a game-creation limit, setup shows when you can create another game.',
  ],
};
const SEEN_KEY = 'noitamap-guessr-changelog-seen';
// One automatic opening in this tab's session, even if a second release arrives.
const SESSION_KEY = 'noitamap-guessr-changelog-shown';

function read(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try { return window[kind].getItem(key); } catch { return null; }
}
function write(kind: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  try { window[kind].setItem(key, value); } catch { /* In-memory guard still prevents repeated openings. */ }
}

function replayPreview() {
  const figure = document.createElement('figure');
  figure.className = 'guessr-release-preview';
  const image = document.createElement('img');
  image.width = 900; image.height = 442; image.decoding = 'async';
  image.className = 'border rounded-9';
  bindAttribute(image, 'alt', 'The clue and guess maps play side by side as a player pans, zooms and submits a guess.');
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'btn btn-sm btn-outline theme-secondary';
  let playing = false;
  const show = (animate: boolean) => {
    playing = animate;
    image.src = '/guessr/updates/active-step-replay-2026-11-27.' + (playing ? 'gif' : 'webp');
    bindText(toggle, playing ? 'Stop animation' : 'Play animation');
  };
  show(window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true);
  toggle.onclick = () => show(!playing);
  figure.append(image, toggle);
  return figure;
}

export function createGuessrChangelog(release = GUESSR_CHANGELOG) {
  const announcement = /^\d{4}-\d{2}-\d{2}/.exec(release.id)?.[0] ?? release.id;
  const seen = () => {
    const saved = read('localStorage', SEEN_KEY);
    return saved === announcement || !!saved && saved.startsWith(announcement + '-');
  };
  let safe = false, shown = false, destroyed = false, queued = false;
  let opened: { element: HTMLDialogElement; instance: Dialog } | undefined;

  function show(trigger?: HTMLElement): void {
    if (destroyed || opened || document.querySelector('dialog[open]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog dialog-scrollable dialog-instant guessr-changelog';
    dialog.setAttribute('aria-labelledby', 'guessr-changelog-title');
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = bindText(document.createElement('h1'), "What's new");
    title.id = 'guessr-changelog-title'; title.className = 'dialog-title fs-lg';
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn-close';
    dismiss.setAttribute('data-bs-dismiss', 'dialog'); bindAttribute(dismiss, 'aria-label', 'Close');
    header.append(title, dismiss);
    const body = document.createElement('div'); body.className = 'dialog-body';
    const date = bindText(document.createElement('time'), () => new Date(release.date + 'T00:00:00Z')
      .toLocaleDateString(guessrLocale(), { dateStyle: 'long', timeZone: 'UTC' }));
    date.dateTime = release.date; date.className = 'muted';
    const notes = document.createElement('ul'); notes.className = 'guessr-release-features';
    for (const feature of release.features) {
      const item = document.createElement('li');
      const heading = document.createElement('h2');
      heading.append(featureLabel(feature));
      item.append(heading, bindText(document.createElement('p'), guessrFeatures[feature].note));
      if (feature === 'replays') item.append(replayPreview());
      notes.append(item);
    }
    const labels = () => ({ streaming: tr('I’m streaming'), streamMode: tr('Chat vs Streamer'),
      hostAction: tr('Play as streamer'), chatterAction: tr('Play as chatter'), nextRound: tr('Next round'), backToResults: tr('Back to results'),
      dailyMode: tr('Daily'), received: tr('Guess received'), startGame: tr('Start game'), howToPlay: tr('How to play'), whatsNew: tr("What's new"),
      share: tr('Share result'), answers: tr('View answers') });
    const earlier = document.createElement('ul'); earlier.className = 'guessr-changelog-notes';
    for (const text of release.notes) earlier.append(bindText(document.createElement('li'), text, labels));
    body.append(date, notes);
    if (earlier.childElementCount) {
      const more = document.createElement('details'); more.className = 'changelog-more';
      more.append(bindText(document.createElement('summary'), 'More changes'), earlier); body.append(more);
    }
    dialog.append(header, body); document.body.append(dialog);
    const instance = new Dialog(dialog);
    // Claim the notice before an asynchronous show. Navigation or a reload
    // during the opening transition must not schedule the same notice again.
    shown = true;
    write('localStorage', SEEN_KEY, announcement);
    write('sessionStorage', SESSION_KEY, '1');
    opened = { element: dialog, instance };
    dialog.addEventListener('shown.bs.dialog', () => {
      // A game can start while Bootstrap opens the dialog.
      if ((!safe || !isMainPage()) && !trigger) { void instance.hide(); return; }
    }, { once: true });
    dialog.addEventListener('hidden.bs.dialog', () => {
      instance.dispose(); dialog.remove(); opened = undefined;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }, { once: true });
    void instance.show(trigger).catch(() => {
      instance.dispose(); dialog.remove(); opened = undefined;
    });
  }

  function check(): void {
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (destroyed || !safe || !isMainPage() || shown || document.visibilityState === 'hidden'
        || read('sessionStorage', SESSION_KEY) || seen()) return;
      show();
    });
  }
  document.addEventListener('hidden.bs.dialog', check);
  document.addEventListener('visibilitychange', check);
  return {
    setSafe(value: boolean): void {
      if (safe === value) return;
      safe = value;
      if (!safe && opened) void opened.instance.hide();
      if (safe) check();
    },
    show,
    destroy(): void {
      destroyed = true;
      document.removeEventListener('hidden.bs.dialog', check);
      document.removeEventListener('visibilitychange', check);
      opened?.instance.dispose(); opened?.element.remove(); opened = undefined;
    },
  };
}

let changelog: ReturnType<typeof createGuessrChangelog> | undefined;
export function initializeGuessrChangelog(): void { changelog ??= createGuessrChangelog(); }
export function allowGuessrChangelog(safe: boolean): void { changelog?.setSafe(safe); }
export function showGuessrChangelog(trigger?: HTMLElement): void { changelog?.show(trigger); }
