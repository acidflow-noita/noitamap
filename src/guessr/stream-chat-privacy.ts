import { CHATTERINO_GUESS_FILTER } from './guess-command';
import { buttonNotice } from './button-notice';
import { bindAttribute, bindText, tr } from './i18n';

export const HIDE_LOCAL_GUESSES_KEY = 'noitamap-guessr-hide-local-guesses';
export function hideLocalGuesses(): boolean {
  try { return localStorage.getItem(HIDE_LOCAL_GUESSES_KEY) === 'true'; } catch { return false; }
}
export function setHideLocalGuesses(hidden: boolean): void {
  try { localStorage.setItem(HIDE_LOCAL_GUESSES_KEY, String(hidden)); } catch { /* Local preference only. */ }
}

/** Bootstrap 6 switches wrap the checkbox; the label stays clickable as a whole. */
export function createChatPrivacyOption(text: string, checked = false) {
  const label = document.createElement('label'); label.className = 'stream-privacy-option';
  const control = document.createElement('span'); control.className = 'switch';
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
  input.setAttribute('role', 'switch');
  control.append(input);
  label.append(control, bindText(document.createElement('span'), text));
  return { label, input };
}

/** Desktop filtering changes the streamer's view, never Twitch messages. */
export function streamChatPrivacy(): HTMLElement {
  const section = document.createElement('details'); section.className = 'stream-chat-privacy';
  const title = bindText(document.createElement('summary'), 'Hide chatters’ guesses in my chat');
  const { label: localLabel, input: localToggle } = createChatPrivacyOption('Hide guesses in my NoitaGuessr chat view', hideLocalGuesses());
  localToggle.onchange = () => setHideLocalGuesses(localToggle.checked);
  const { label, input: toggle } = createChatPrivacyOption('I use Chatterino');
  const guide = document.createElement('div'); guide.hidden = true;
  const copy = bindText(document.createElement('button'), 'Copy Chatterino filter'); copy.type = 'button'; copy.className = 'small secondary';
  const notice = buttonNotice(copy);
  const expression = document.createElement('input'); expression.readOnly = true; expression.value = CHATTERINO_GUESS_FILTER;
  bindAttribute(expression, 'aria-label', 'Chatterino filter'); expression.hidden = true;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(CHATTERINO_GUESS_FILTER); notice.show(tr('Copied'), 'success'); }
    catch { expression.hidden = false; expression.focus(); expression.select(); }
  };
  const steps = bindText(document.createElement('p'), 'In Chatterino: Settings → Filters → Quick Add. Paste the filter, then enable it from your channel’s menu → Set filters. This is a one-time local setup.');
  const docs = bindText(document.createElement('a'), 'Chatterino instructions'); docs.href = 'https://wiki.chatterino.com/Filters/'; docs.target = '_blank'; docs.rel = 'noopener noreferrer';
  guide.append(copy, expression, steps, docs);
  toggle.onchange = () => { guide.hidden = !toggle.checked; };
  section.addEventListener('toggle', () => { if (!section.open) notice.dispose(); });
  section.append(title, localLabel, label, guide);
  return section;
}
