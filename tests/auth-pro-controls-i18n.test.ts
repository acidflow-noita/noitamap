// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ getState: vi.fn(), login: vi.fn(), loginTwitch: vi.fn(), unlink: vi.fn() }));
vi.mock('../src/auth/auth-service', () => ({ authService: auth }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  document.body.replaceChildren();
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('keeps corrected map terminology ahead of independently translated Guessr wording', async () => {
  const { default: i18n } = await import('i18next');
  const { bindAuthText } = await import('../src/auth/control-translations');
  await i18n.init({ lng: 'ru', fallbackLng: 'en', ns: ['translation', 'guessr'], showSupportNotice: false,
    resources: { ru: { translation: { auth: { becomePatron: 'Стать патроном' } }, guessr: { 'Become a Patron': 'Поддержать на Patreon' } } } });
  const label = bindAuthText(document.createElement('span'), 'auth.becomePatron', 'Become a Patron');
  expect(label.textContent).toBe('Стать патроном');
  expect(auth.login).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('refreshes provider status and action text in place without checking authentication or translating usernames', async () => {
  const { default: i18n } = await import('i18next');
  const { createProControls } = await import('../src/auth/pro-controls');
  await i18n.init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'guessr'], defaultNS: 'translation', showSupportNotice: false,
    resources: {
      en: { translation: {}, guessr: {} },
      fr: { translation: {}, guessr: {
        'Account connected': 'Compte connecté', 'Pro active': 'Pro actif',
        'Sign in again to check membership': 'Reconnectez-vous pour vérifier l’abonnement',
        'Connect {{provider}}': 'Connecter {{provider}}', 'Disconnect {{provider}}': 'Déconnecter {{provider}}',
        'Subscribe on Twitch': 'S’abonner sur Twitch', 'Become a Patron': 'Devenir patron',
        'Recipient’s Twitch username': 'Identifiant Twitch du destinataire',
        'Sign out': 'Se déconnecter',
      } },
    },
    interpolation: { escapeValue: false },
  });
  auth.getState.mockReturnValue({
    authenticated: true, provider: 'twitch', accountId: 'account', isSubscriber: true,
    linkedAccounts: [
      { provider: 'twitch', username: 'Sign out', isSubscriber: true, membershipStatus: 'active' },
      { provider: 'patreon', username: '<img src=x onerror=alert(1)>', isSubscriber: false, membershipStatus: 'reconnect' },
    ],
  });
  const beforeLogin = vi.fn();
  const controls = createProControls({ beforeLogin, idPrefix: 'account-' });
  document.body.append(controls);
  const login = controls.querySelector<HTMLButtonElement>('#account-patreonLoginBtn')!;
  const unlink = controls.querySelector<HTMLButtonElement>('.pro-unlink')!;
  const input = controls.querySelector<HTMLInputElement>('input[type="text"]')!;
  const disclosure = controls.querySelector<HTMLDetailsElement>('details')!;
  disclosure.open = true;
  input.value = '@Keep_My_Name'; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(2, 6);
  await i18n.changeLanguage('fr');
  expect(document.querySelector('.pro-columns')).toBe(controls);
  expect(controls.querySelector('#account-patreonLoginBtn')).toBe(login);
  expect(controls.querySelector('.pro-unlink')).toBe(unlink);
  expect(login.textContent).toContain('Connecter Patreon');
  expect(unlink.textContent).toBe('Déconnecter Twitch');
  expect(controls.textContent).toContain('Compte connecté');
  expect(controls.textContent).toContain('Pro actif');
  expect(controls.textContent).toContain('Reconnectez-vous pour vérifier l’abonnement');
  expect(controls.textContent).toContain('S’abonner sur Twitch');
  expect(controls.textContent).toContain('Devenir patron');
  expect(controls.querySelector('strong')!.textContent).toBe('Twitch: Sign out');
  expect(controls.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(controls.querySelector('img')).toBeNull();
  expect(controls.querySelector('label')!.textContent).toBe('Identifiant Twitch du destinataire');
  expect(input.value).toBe('@Keep_My_Name');
  expect(disclosure.open).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(auth.getState).toHaveBeenCalledOnce();
  expect(auth.login).not.toHaveBeenCalled();
  expect(auth.loginTwitch).not.toHaveBeenCalled();
  expect(auth.unlink).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  login.click();
  expect(beforeLogin).toHaveBeenCalledOnce();
  expect(auth.login).toHaveBeenCalledOnce();
});

it('refreshes disabled linking hints and does not enable an unavailable connection', async () => {
  const { default: i18n } = await import('i18next');
  const { createProControls } = await import('../src/auth/pro-controls');
  await i18n.init({
    lng: 'en', fallbackLng: 'en', showSupportNotice: false,
    resources: {
      en: { translation: {} },
      fr: { translation: {}, guessr: {
        'Connect {{provider}}': 'Connecter {{provider}}',
        'Account connections are not available yet.': 'La connexion de comptes est indisponible.',
      } },
    },
    interpolation: { escapeValue: false },
  });
  auth.getState.mockReturnValue({ authenticated: true, provider: 'twitch', username: 'viewer', linkingAvailable: false });
  const controls = createProControls(); document.body.append(controls);
  const button = controls.querySelector<HTMLButtonElement>('#patreonLoginBtn')!;
  expect(button.disabled).toBe(true);
  await i18n.changeLanguage('fr');
  expect(button.title).toBe('La connexion de comptes est indisponible.');
  expect(button.textContent).toContain('Connecter Patreon');
  expect(button.disabled).toBe(true);
  button.click();
  expect(auth.login).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('updates controls built before startup and keeps map translations when the host catalogue is incomplete', async () => {
  const { default: i18n } = await import('i18next');
  const { createProControls } = await import('../src/auth/pro-controls');
  auth.getState.mockReturnValue({ authenticated: false });
  const controls = createProControls(); document.body.append(controls);
  await i18n.init({
    lng: 'fr', fallbackLng: 'en', ns: ['translation', 'guessr'], defaultNS: 'translation', showSupportNotice: false,
    resources: {
      en: { translation: {}, guessr: { 'Sign in with Twitch': 'Sign in with Twitch' } },
      fr: { translation: { auth: { loginWithTwitch: 'Se connecter avec Twitch' } }, guessr: {} },
    },
  });
  expect(controls.querySelector('#twitchLoginBtn')!.textContent).toContain('Se connecter avec Twitch');
  expect(controls.querySelector('#patreonLoginBtn')!.textContent).toContain('Sign in with Patreon');
  expect(auth.getState).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
