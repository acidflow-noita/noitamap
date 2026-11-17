import Dialog from 'bootstrap/js/dist/dialog.js';
import { bindAttribute, bindText, guessrLocale, tr } from './i18n';
import { readGuessRoute } from './routes';

const isMainPage = () => readGuessRoute(new URL(location.href)).pane === 'home';

// Change this ID only when the player-facing notes below change.
export const GUESSR_CHANGELOG = {
  id: '2026-11-17-layout-stability',
  date: '2026-11-17',
  notes: [
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
    'Buttons above the clue image now show keyboard shortcuts.',
    'The "{{received}}" button now looks disabled after your guess is confirmed.',
    'In the results for each round, only player names use player colors. A perfect score of 5,000 points appears in gold.',
    "Game history shows each player's rank and score.",
    'The game results page has a smaller title and a narrower rank column.',
    'If you reach a game-creation limit, setup shows when you can create another game.',
    'Open "{{howToPlay}}" and choose "{{whatsNew}}" to read these notes again.',
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

export function createGuessrChangelog(release = GUESSR_CHANGELOG) {
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
    const notes = document.createElement('ul'); notes.className = 'guessr-changelog-notes';
    const labels = () => ({ streaming: tr('I’m streaming'), streamMode: tr('Chat vs Streamer'),
      dailyMode: tr('Daily'), received: tr('Guess received'), startGame: tr('Start game'), howToPlay: tr('How to play'), whatsNew: tr("What's new") });
    for (const text of release.notes) notes.append(bindText(document.createElement('li'), text, labels));
    body.append(date, notes);
    dialog.append(header, body); document.body.append(dialog);
    const instance = new Dialog(dialog);
    opened = { element: dialog, instance };
    dialog.addEventListener('shown.bs.dialog', () => {
      // A game can start while Bootstrap opens the dialog.
      if ((!safe || !isMainPage()) && !trigger) { void instance.hide(); return; }
      shown = true;
      write('localStorage', SEEN_KEY, release.id);
      write('sessionStorage', SESSION_KEY, '1');
    }, { once: true });
    dialog.addEventListener('hidden.bs.dialog', () => {
      instance.dispose(); dialog.remove(); opened = undefined;
      if (safe && trigger?.isConnected) trigger.focus({ preventScroll: true });
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
        || read('sessionStorage', SESSION_KEY) || read('localStorage', SEEN_KEY) === release.id) return;
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
