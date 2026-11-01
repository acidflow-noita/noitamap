import { bindAuthText as bindText } from './control-translations';

export type GiftProvider = 'twitch' | 'patreon';
export const PRO_GIFT_URLS: Record<GiftProvider, string> = {
  // Twitch's product page only selects named gifting when a recipient is supplied.
  twitch: 'https://www.twitch.tv/products/wuote',
  patreon: 'https://www.patreon.com/wuote/gift',
};

export function giftRecipient(value?: string): string | undefined {
  const login = value?.trim().replace(/^@/, '').toLowerCase();
  // The channel owner cannot receive their own subscription; local_streamer is a preview placeholder.
  return login && login !== 'wuote' && login !== 'local_streamer' && /^[a-z0-9_]{1,25}$/.test(login) ? login : undefined;
}

// Twitch's page reads `recipient`; checkout selects a gift after resolving that login.
// https://assets.twitch.tv/assets/pages.subs-checkout.components.subs-checkout-page-e630b2b77826730bd447.js
// https://assets.twitch.tv/assets/63130-8a55afa81df2ffbbecbe.js
export function twitchGiftUrl(recipient?: string): string | undefined {
  const login = giftRecipient(recipient);
  if (!login) return undefined;
  const url = new URL(PRO_GIFT_URLS.twitch);
  url.searchParams.set('recipient', login);
  return url.href;
}

function giftLabel<T extends Node>(node: T, provider: GiftProvider): T {
  return provider === 'twitch'
    ? bindText(node, 'auth.giftProOnTwitch', 'Gift Pro on Twitch')
    : bindText(node, 'auth.giftProOnPatreon', 'Gift Pro on Patreon');
}

function giftIcon(): HTMLElement {
  const icon = document.createElement('i'); icon.className = 'bi bi-gift'; icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function giftClass(provider: GiftProvider, featured: boolean): string {
  return 'pro-gift-link' + (featured && provider === 'twitch' ? ' btn-twitch pro-gift-featured' : '');
}

/** Missing or invalid recipients never fall through to self-subscription checkout. */
export function createProGiftLink(provider: GiftProvider, featured = false, recipient?: string): HTMLAnchorElement {
  const link = document.createElement('a');
  const url = provider === 'twitch' ? twitchGiftUrl(recipient) : PRO_GIFT_URLS.patreon;
  if (url) link.href = url;
  else { link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1; }
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.dataset.proGift = provider;
  link.className = giftClass(provider, featured);
  link.append(giftIcon(), giftLabel(document.createElement('span'), provider));
  return link;
}

export function createProGiftExplanation(provider?: GiftProvider): HTMLParagraphElement {
  const hint = document.createElement('p'); hint.className = 'pro-gift-hint';
  if (provider !== 'patreon') hint.append(bindText(document.createTextNode(''), 'auth.giftTwitchAutomatic', 'Twitch gifts apply directly to the recipient’s account.'));
  if (!provider) hint.append(' ');
  if (provider !== 'twitch') hint.append(bindText(document.createTextNode(''), 'auth.giftPatreonClaim', 'Patreon gifts must be claimed through the gift link the buyer receives after purchase.'));
  return hint;
}

function recipientWarning(): HTMLParagraphElement {
  const hint = document.createElement('p'); hint.className = 'pro-gift-hint';
  return bindText(hint, 'auth.giftTwitchConfirmRecipient', 'Confirm the recipient on Twitch before paying. If the username is not found, Twitch may offer a subscription for your own account.');
}

let recipientFormId = 0;
function recipientForm(featured: boolean): HTMLDetailsElement {
  const disclosure = document.createElement('details'); disclosure.className = 'pro-gift-disclosure';
  const summary = document.createElement('summary'); summary.className = giftClass('twitch', featured);
  summary.dataset.proGift = 'twitch';
  summary.append(giftIcon(), giftLabel(document.createElement('span'), 'twitch'));
  const form = document.createElement('form'); form.className = 'pro-gift-recipient';
  form.method = 'get'; form.action = PRO_GIFT_URLS.twitch; form.target = '_blank'; form.rel = 'noopener noreferrer';
  const input = document.createElement('input'); input.type = 'text'; input.className = 'form-control';
  input.id = `pro-gift-recipient-${++recipientFormId}`; input.maxLength = 26;
  input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'none');
  const label = bindText(document.createElement('label'), 'auth.giftTwitchRecipient', 'Recipient’s Twitch username');
  label.htmlFor = input.id;
  // Only the normalized login is submitted, never the editable value or unrelated form fields.
  const recipient = document.createElement('input'); recipient.type = 'hidden'; recipient.name = 'recipient';
  const warning = recipientWarning(); warning.id = `${input.id}-hint`;
  const error = document.createElement('p'); error.id = `${input.id}-error`; error.className = 'pro-gift-hint';
  error.setAttribute('role', 'status'); error.hidden = true;
  input.setAttribute('aria-describedby', `${warning.id} ${error.id}`);
  const checkout = bindText(document.createElement('button'), 'auth.giftTwitchOpenCheckout', 'Open gift checkout');
  checkout.type = 'submit'; checkout.className = 'pro-gift-link pro-gift-checkout'; checkout.disabled = true;
  function updateRecipient(): string | undefined {
    const login = giftRecipient(input.value);
    const owner = input.value.trim().replace(/^@/, '').toLowerCase() === 'wuote';
    recipient.value = login ?? ''; checkout.disabled = !login;
    error.hidden = !input.value.trim() || !!login;
    input.setAttribute('aria-invalid', String(!error.hidden));
    if (owner) bindText(error, 'auth.giftTwitchOwnerRecipient', 'Choose another recipient. The channel owner cannot receive their own channel’s subscription.');
    else bindText(error, 'auth.giftTwitchInvalidRecipient', 'Enter a valid Twitch username.');
    return login;
  }
  input.addEventListener('input', updateRecipient);
  form.addEventListener('submit', event => {
    if (!updateRecipient()) { event.preventDefault(); input.focus(); }
  });
  form.append(label, input, recipient, warning, error, checkout);
  disclosure.append(summary, form);
  return disclosure;
}

export function createProGiftControls(provider: GiftProvider, featured = false, recipient?: string): HTMLElement {
  const group = document.createElement('div'); group.className = 'pro-gift';
  const target = giftRecipient(recipient);
  group.append(provider === 'twitch' && !target ? recipientForm(featured) : createProGiftLink(provider, featured, target));
  if (provider === 'twitch' && target) group.append(recipientWarning());
  group.append(createProGiftExplanation(provider));
  return group;
}
