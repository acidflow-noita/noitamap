import Dialog from 'bootstrap/js/dist/dialog.js';
import { bindAttribute, bindText } from './i18n';

/** Keep the destructive confirmation separate from the lobby's launch button. */
export function confirmQuitGame(quit: () => unknown | Promise<unknown>, description = 'Your progress in this game will be discarded.'): void {
  if (document.getElementById('guessr-quit-dialog')) return;
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const dialog = document.createElement('dialog');
  dialog.id = 'guessr-quit-dialog'; dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'guessr-quit-title');
  dialog.setAttribute('aria-describedby', 'guessr-quit-description');
  dialog.innerHTML = `<div class="dialog-header"><h1 class="dialog-title fs-lg" id="guessr-quit-title"></h1><button type="button" class="btn-close" data-bs-dismiss="dialog"></button></div>
    <div class="dialog-body"><p id="guessr-quit-description"></p><p class="fg-danger" role="alert" hidden></p></div>
    <div class="dialog-footer"><button type="button" class="btn-outline" data-bs-dismiss="dialog" autofocus></button><button type="button" class="btn-solid theme-danger" data-confirm-quit disabled></button></div>`;
  bindText(dialog.querySelector('#guessr-quit-title')!, 'End this game?');
  bindAttribute(dialog.querySelector('.btn-close')!, 'aria-label', 'Close');
  bindText(dialog.querySelector('#guessr-quit-description')!, description);
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm-quit]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[autofocus]')!;
  bindText(confirm, 'End game');
  bindText(cancel, 'Cancel');
  const dismiss = [...dialog.querySelectorAll<HTMLButtonElement>('[data-bs-dismiss]')];
  const error = dialog.querySelector<HTMLElement>('[role="alert"]')!;
  let pending = false;
  document.body.append(dialog);
  const instance = new Dialog(dialog);
  dialog.addEventListener('shown.bs.dialog', () => { confirm.disabled = false; cancel.focus(); }, { once: true });
  dialog.addEventListener('hide.bs.dialog', event => { if (pending) event.preventDefault(); });
  confirm.onclick = async event => {
    if (pending || confirm.disabled || event.detail > 1) return;
    pending = true; confirm.disabled = true; dismiss.forEach(button => { button.disabled = true; });
    error.hidden = true;
    try {
      await quit();
      pending = false;
      await instance.hide();
    } catch (cause) {
      pending = false; confirm.disabled = false; dismiss.forEach(button => { button.disabled = false; });
      bindText(error, cause instanceof Error ? cause.message : 'Could not quit the game. Please retry.');
      error.hidden = false; cancel.focus();
    }
  };
  dialog.addEventListener('hidden.bs.dialog', () => {
    instance.dispose(); dialog.remove(); if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  void instance.show(trigger);
}
