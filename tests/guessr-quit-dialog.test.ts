// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { confirmQuitGame } from '../src/guessr/quit-game';

vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  constructor(private element: HTMLElement) {}
  show() {}
  async hide() {
    if (this.element.dispatchEvent(new Event('hide.bs.dialog', { cancelable: true })))
      this.element.dispatchEvent(new Event('hidden.bs.dialog'));
  }
  dispose() {}
} }));
afterEach(() => document.body.replaceChildren());
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function open(quit: () => unknown) {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  confirmQuitGame(quit);
  const dialog = document.querySelector('#guessr-quit-dialog')!;
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm-quit]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[autofocus]')!;
  return { dialog, confirm, cancel, trigger, shown: () => dialog.dispatchEvent(new Event('shown.bs.dialog')) };
}

it('requires a separate confirmation, focuses Cancel, and ignores opening/double clicks', () => {
  const quit = vi.fn(), f = open(quit);
  f.confirm.click(); expect(quit).not.toHaveBeenCalled();
  f.shown(); expect(document.activeElement).toBe(f.cancel);
  f.confirm.dispatchEvent(new MouseEvent('click', { detail: 2 }));
  expect(quit).not.toHaveBeenCalled();
  f.dialog.dispatchEvent(new Event('hidden.bs.dialog'));
  expect(document.querySelector('#guessr-quit-dialog')).toBeNull();
  expect(document.activeElement).toBe(f.trigger);
  expect(quit).not.toHaveBeenCalled();
});

it('sends one quit, prevents dismissal while pending, then removes the dialog', async () => {
  let finish!: () => void;
  const quit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const f = open(quit); f.shown(); f.confirm.click(); f.confirm.click();
  expect(quit).toHaveBeenCalledTimes(1);
  expect(f.cancel.disabled).toBe(true);
  expect(f.dialog.dispatchEvent(new Event('hide.bs.dialog', { cancelable: true }))).toBe(false);
  finish(); await flush();
  expect(document.querySelector('#guessr-quit-dialog')).toBeNull();
});

it('keeps the confirmation open on failure and permits a deliberate retry', async () => {
  const quit = vi.fn().mockRejectedValueOnce(Error('Offline. Try again.')).mockResolvedValue(undefined);
  const f = open(quit); f.shown(); f.confirm.click(); await flush();
  expect(f.dialog.isConnected).toBe(true);
  expect(f.dialog.querySelector('[role="alert"]')!.textContent).toBe('Offline. Try again.');
  expect(document.activeElement).toBe(f.cancel);
  expect(f.confirm.disabled).toBe(false);
  f.confirm.click(); await flush();
  expect(quit).toHaveBeenCalledTimes(2);
  expect(f.dialog.isConnected).toBe(false);
});

it('translates the open confirmation and error while preserving Cancel focus and deliberate retry', async () => {
  const { default: i18next } = await import('../src/i18n');
  const { initializeGuessrTranslations } = await import('../src/guessr/i18n');
  history.replaceState(null, '', '/guess/?lng=en');
  await initializeGuessrTranslations();
  i18next.addResourceBundle('de', 'translation', {}, true, true);
  i18next.addResourceBundle('de', 'guessr', {
    'End this game?': 'Dieses Spiel beenden?',
    'Your progress in this game will be discarded.': 'Der Fortschritt wird verworfen.',
    'Cancel': 'Abbrechen', 'End game': 'Spiel beenden', 'Close': 'Schließen',
    'Could not quit the game. Please retry.': 'Spiel konnte nicht beendet werden. Bitte erneut versuchen.',
  }, true, true);
  const quit = vi.fn().mockRejectedValueOnce(null).mockResolvedValue(undefined);
  const f = open(quit); f.shown(); f.confirm.click(); await flush();
  try {
    await i18next.changeLanguage('de');
    expect(document.querySelector('#guessr-quit-dialog')).toBe(f.dialog);
    expect(f.dialog.querySelector('#guessr-quit-title')!.textContent).toBe('Dieses Spiel beenden?');
    expect(f.dialog.querySelector('#guessr-quit-description')!.textContent).toBe('Der Fortschritt wird verworfen.');
    expect(f.dialog.querySelector('.btn-close')!.getAttribute('aria-label')).toBe('Schließen');
    expect(f.dialog.querySelector('[role="alert"]')!.textContent).toBe('Spiel konnte nicht beendet werden. Bitte erneut versuchen.');
    expect(f.confirm.textContent).toBe('Spiel beenden');
    expect(f.cancel.textContent).toBe('Abbrechen');
    expect(document.activeElement).toBe(f.cancel);
    expect(quit).toHaveBeenCalledTimes(1);
    f.confirm.dispatchEvent(new MouseEvent('click', { detail: 2 }));
    expect(quit).toHaveBeenCalledTimes(1);
    f.confirm.click(); await flush();
    expect(quit).toHaveBeenCalledTimes(2);
    expect(f.dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(f.trigger);
  } finally {
    await i18next.changeLanguage('en');
  }
});
