import Dialog from 'bootstrap/js/dist/dialog.js';
import { createProGiftControls, giftRecipient } from '../auth/pro-gifting';
import { bindAttribute, bindText } from './i18n';

function setRecipient(dialog: HTMLElement, target?: string): void {
  dialog.dataset.recipient = target ?? '';
  const title = dialog.querySelector<HTMLElement>('.dialog-title')!;
  if (target) bindText(title, 'Gift Pro to {{recipient}}', { recipient: target });
  else bindText(title, 'Gift Pro');
  const twitch = createProGiftControls('twitch', true, target);
  const disclosure = twitch.querySelector('details');
  if (disclosure) disclosure.open = true;
  dialog.querySelector('.dialog-body')!.replaceChildren(twitch, createProGiftControls('patreon'));
}

/** Gifting uses the existing dialog/brand styles; checkout stays with the provider. */
export function showStreamerGift(recipient?: string): void {
  const target = giftRecipient(recipient);
  const existing = document.getElementById('guessr-gift-dialog');
  if (existing) {
    if (existing.dataset.recipient !== (target ?? '')) setRecipient(existing, target);
    void Dialog.getOrCreateInstance(existing).show(); return;
  }
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const dialog = document.createElement('dialog'); dialog.className = 'dialog'; dialog.id = 'guessr-gift-dialog';
  dialog.setAttribute('aria-labelledby', 'guessr-gift-title');
  const header = document.createElement('div'); header.className = 'dialog-header';
  const title = document.createElement('h1'); title.className = 'dialog-title fs-lg'; title.id = 'guessr-gift-title';
  const close = document.createElement('button'); close.className = 'btn-close'; close.type = 'button';
  close.setAttribute('data-bs-dismiss', 'dialog'); bindAttribute(close, 'aria-label', 'Close');
  header.append(title, close);
  const body = document.createElement('div'); body.className = 'dialog-body pro-gift-offer';
  dialog.append(header, body); setRecipient(dialog, target); document.body.append(dialog);
  const instance = new Dialog(dialog);
  dialog.addEventListener('hidden.bs.dialog', () => {
    instance.dispose(); dialog.remove(); if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  void instance.show(trigger);
}
