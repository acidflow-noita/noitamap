import { bindText } from './i18n';

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
