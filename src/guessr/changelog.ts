import Dialog from 'bootstrap/js/dist/dialog.js';
import { bindAttribute, bindText, guessrLocale } from './i18n';

// Change this ID only when the player-facing notes below change.
export const GUESSR_CHANGELOG = {
  id: '2026-11-15-history',
  date: '2026-11-15',
  notes: [
    "Game history shows each player's rank and score.",
    'Use W, A, S and D to move the clue image. Q zooms out. E zooms in.',
    'Move the guess map with the arrow keys. Zoom with + and -.',
    'Buttons above the clue image now show keyboard shortcuts.',
    'On phones, game panels use the full width, with more room for the clue and touch controls.',
    '1v1 uses your existing Pro sign-in. The lobby shows both players and whether they are ready.',
    'If you give up a 1v1 match, the results page opens.',
    'The game results page has a smaller title and a narrower rank column.',
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
    for (const text of release.notes) notes.append(bindText(document.createElement('li'), text));
    body.append(date, notes);
    const footer = document.createElement('div'); footer.className = 'dialog-footer';
    const close = bindText(document.createElement('button'), 'Close'); close.type = 'button';
    close.className = 'btn btn-solid theme-primary'; close.autofocus = true;
    close.setAttribute('data-bs-dismiss', 'dialog'); footer.append(close);
    dialog.append(header, body, footer); document.body.append(dialog);
    const instance = new Dialog(dialog);
    opened = { element: dialog, instance };
    dialog.addEventListener('shown.bs.dialog', () => {
      // A game can start while Bootstrap opens the dialog.
      if (!safe && !trigger) { void instance.hide(); return; }
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
      if (destroyed || !safe || shown || document.visibilityState === 'hidden'
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
