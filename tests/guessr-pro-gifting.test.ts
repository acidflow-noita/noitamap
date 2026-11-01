// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { showStreamerGift } from '../src/guessr/pro-gift-dialog';
import { createProGiftControls, createProGiftLink, twitchGiftUrl } from '../src/auth/pro-gifting';

const modal = vi.hoisted(() => ({ show: vi.fn(), dispose: vi.fn() }));
vi.mock('bootstrap/js/dist/dialog.js', () => ({ default: class {
  show = modal.show; dispose = modal.dispose;
  static getOrCreateInstance() { return modal; }
} }));
afterEach(async () => {
  document.body.replaceChildren();
  if (i18next.isInitialized) await i18next.changeLanguage('en');
  vi.clearAllMocks(); vi.unstubAllGlobals();
});

it('opens Twitch’s named gift route and asks the buyer to confirm the recipient', () => {
  vi.stubGlobal('fetch', vi.fn());
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  showStreamerGift('@Streamer');
  const dialog = document.querySelector<HTMLDialogElement>('#guessr-gift-dialog')!;
  expect(dialog.querySelector('h1')!.textContent).toBe('Gift Pro to streamer');
  const links = [...dialog.querySelectorAll('a')];
  expect(links.map(link => link.href)).toEqual(['https://www.twitch.tv/products/wuote?recipient=streamer', 'https://www.patreon.com/wuote/gift']);
  expect(links[0].classList.contains('pro-gift-featured')).toBe(true);
  expect(links[0].target).toBe('_blank');
  expect(links[0].rel).toBe('noopener noreferrer');
  expect(dialog.textContent).toContain('Confirm the recipient on Twitch before paying.');
  expect(dialog.textContent).toContain('If the username is not found, Twitch may offer a subscription for your own account.');
  expect(dialog.textContent).toContain('Twitch gifts apply directly to the recipient’s account.');
  expect(dialog.textContent).toContain('Patreon gifts must be claimed through the gift link the buyer receives after purchase.');
  showStreamerGift('@Streamer');
  expect(document.querySelectorAll('#guessr-gift-dialog')).toHaveLength(1);
  dialog.dispatchEvent(new Event('hidden.bs.dialog'));
  expect(modal.dispose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['wuote', '@WUOTE', 'local_streamer', '<script>not-a-login</script>'])('requires another recipient for %s', recipient => {
  showStreamerGift(recipient);
  expect(document.querySelector('h1')!.textContent).toBe('Gift Pro');
  expect(document.querySelectorAll('script')).toHaveLength(0);
  expect(document.querySelector('a[data-pro-gift="twitch"]')).toBeNull();
  expect(document.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[name="recipient"]')!.value).toBe('');
});

it('updates an existing gift dialog when another recipient is selected', () => {
  showStreamerGift('first_viewer');
  showStreamerGift('second_viewer');
  expect(document.querySelectorAll('#guessr-gift-dialog')).toHaveLength(1);
  expect(document.querySelector('h1')!.textContent).toBe('Gift Pro to second_viewer');
  expect(document.querySelector<HTMLAnchorElement>('a[data-pro-gift="twitch"]')!.href)
    .toBe('https://www.twitch.tv/products/wuote?recipient=second_viewer');
});

it('gives generic Twitch gifting a validated recipient form and keeps Patreon redemption instructions', () => {
  vi.stubGlobal('fetch', vi.fn());
  const twitch = createProGiftControls('twitch'), patreon = createProGiftControls('patreon');
  document.body.append(twitch, patreon);
  expect(twitch.querySelector('a')).toBeNull();
  expect(twitch.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
  const form = twitch.querySelector('form')!;
  const input = twitch.querySelector<HTMLInputElement>('input[type="text"]')!;
  const checkout = twitch.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(form.action).toBe('https://www.twitch.tv/products/wuote');
  expect(form.target).toBe('_blank');
  expect(form.rel).toBe('noopener noreferrer');
  expect(checkout.disabled).toBe(true);
  for (const invalid of ['', 'wuote', '@WUOTE', 'local_streamer', 'bad name', 'user&gift_count=1', 'a'.repeat(26)]) {
    input.value = invalid; input.dispatchEvent(new Event('input'));
    expect(checkout.disabled).toBe(true);
    expect(form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(false);
  }
  input.value = ' @Other_Viewer '; input.dispatchEvent(new Event('input'));
  expect(checkout.disabled).toBe(false);
  expect(input.getAttribute('aria-invalid')).toBe('false');
  expect(form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(true);
  expect([...new FormData(form).entries()]).toEqual([['recipient', 'other_viewer']]);
  expect(twitch.textContent).toContain('apply directly');
  expect(patreon.querySelector('a')!.href).toBe('https://www.patreon.com/wuote/gift');
  expect(patreon.textContent).toContain('must be claimed');
  expect(fetch).not.toHaveBeenCalled();
});

it('never creates a self-subscription link when its recipient is absent or invalid', () => {
  for (const recipient of [undefined, '', 'wuote', 'local_streamer', 'streamer?gift_count=1']) {
    expect(twitchGiftUrl(recipient)).toBeUndefined();
    const link = createProGiftLink('twitch', true, recipient);
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('aria-disabled')).toBe('true');
  }
  expect(twitchGiftUrl(' @Viewer_1 ')).toBe('https://www.twitch.tv/products/wuote?recipient=viewer_1');
});

it('uses main-map translations when shared controls are built before translation startup', async () => {
  const controls = createProGiftControls('twitch'); document.body.append(controls);
  const input = controls.querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = 'viewer'; input.dispatchEvent(new Event('input'));
  await i18next.init({
    lng: 'fr', fallbackLng: 'en', ns: ['translation'], defaultNS: 'translation',
    resources: {
      en: { translation: {} },
      fr: { translation: { auth: {
        giftProOnTwitch: 'Offrir Pro sur Twitch',
        giftTwitchRecipient: 'Identifiant Twitch du destinataire',
      } } },
    },
    interpolation: { escapeValue: false }, showSupportNotice: false,
  });
  expect(controls.querySelector('summary')!.textContent).toBe('Offrir Pro sur Twitch');
  expect(controls.querySelector('label')!.textContent).toBe('Identifiant Twitch du destinataire');
  expect(input.value).toBe('viewer');
});

it('refreshes shared gift controls and dialog labels without losing the typed recipient', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await i18next.init({
    lng: 'en', fallbackLng: 'en', ns: ['translation'], defaultNS: 'translation',
    resources: {
      en: { translation: {} },
      fr: {
        translation: { auth: { giftProOnTwitch: 'Offrir Pro via Twitch' } },
        guessr: {
          'Gift Pro on Twitch': 'Offrir Pro sur Twitch',
          'Recipient’s Twitch username': 'Identifiant Twitch du destinataire',
          'Open gift checkout': 'Ouvrir le paiement du cadeau',
          'Gift Pro to {{recipient}}': 'Offrir Pro à {{recipient}}',
          Close: 'Fermer',
        },
      },
    },
    interpolation: { escapeValue: false }, showSupportNotice: false,
  });
  const controls = createProGiftControls('twitch'); document.body.append(controls);
  const input = controls.querySelector<HTMLInputElement>('input[type="text"]')!;
  const label = controls.querySelector('label')!;
  input.value = '@Viewer_1'; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(2, 5);
  showStreamerGift('streamer');
  await i18next.changeLanguage('fr');
  expect(controls.querySelector('label')).toBe(label);
  expect(label.textContent).toBe('Identifiant Twitch du destinataire');
  expect(controls.querySelector('summary')!.textContent).toBe('Offrir Pro via Twitch');
  expect(controls.querySelector<HTMLButtonElement>('button')!.textContent).toBe('Ouvrir le paiement du cadeau');
  expect(controls.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
  expect(input.value).toBe('@Viewer_1');
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(document.querySelector('h1')!.textContent).toBe('Offrir Pro à streamer');
  expect(document.querySelector('.btn-close')!.getAttribute('aria-label')).toBe('Fermer');
  expect(fetch).not.toHaveBeenCalled();
});
