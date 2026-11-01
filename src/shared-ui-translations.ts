/** Deliberately matched UI contexts, not a reverse index of English strings.
 * This module also runs in the manual translation exporter without a browser. */
export const GUESSR_REUSED_TRANSLATIONS: Readonly<Record<string, string>> = Object.freeze({
  Back: 'seedReport.v3.back',
  Daily: 'dynamicMap.daily',
  Close: 'seedReport.close',
  Retry: 'seedReport.v2.retry',
  Rank: 'seedReport.v3.rank',
  Total: 'seedReport.v2.total',
  Cancel: 'gameContent.ui.menu_cancel',
  // The drawing account controls have the corrected accents missing from some
  // older auth entries; these are the same sign-in/sign-out actions.
  'Sign out': 'drawing.auth.signOut',
  'Sign in with Patreon': 'drawing.auth.signInButton',
  'Sign in with Twitch': 'auth.loginWithTwitch',
  'Become a Patron': 'auth.becomePatron',
  'Pro active': 'auth.proActive',
  'Subscribe on Twitch': 'auth.subscribeTwitch',
  'Gift Pro on Twitch': 'auth.giftProOnTwitch',
  'Gift Pro on Patreon': 'auth.giftProOnPatreon',
  'Twitch gifts apply directly to the recipient’s account.': 'auth.giftTwitchAutomatic',
  'Patreon gifts must be claimed through the gift link the buyer receives after purchase.': 'auth.giftPatreonClaim',
  NoitaGuessr: 'guessr.title',
});

// Reuse the established Daily mode name. Close uses the explicit action key;
// known mistranslations of that key are rejected per language below.

const sameSpellingLanguages: Readonly<Record<string, readonly string[]>> = {
  Total: ['br', 'es', 'fr', 'id'],
  NoitaGuessr: ['br', 'cs', 'de', 'es', 'fi', 'fr', 'id', 'it', 'ja', 'nl', 'pl', 'ru', 'sv', 'uk', 'zh'],
};

// Preserve reviewed Guessr wording while these exact unaccented legacy values
// remain in the shared map. Corrected shared values will be reused normally.
const rejectedValues: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Close: { cs: 'Blízko', es: 'Cerca', fi: 'Lähellä', it: 'Vicino', ja: '近い', nl: 'Dichtbij', sv: 'Nära' },
  'Sign in with Twitch': {
    cs: 'Prihlasit se pres Twitch', es: 'Iniciar sesion con Twitch',
    fi: 'Kirjaudu Twitchilla', pl: 'Zaloguj sie przez Twitch',
  },
  'Become a Patron': {
    cs: 'Stat se patronem', es: 'Convertirse en patron', pl: 'Zostan patronem',
  },
  'Pro active': { cs: 'Pro aktivni' },
};

function placeholders(value: string): string {
  return [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map(match => match[1].trim()).sort().join('\n');
}

/** Resolve only an actual value from this language's raw translation tree.
 * No i18next fallback is allowed to turn an English placeholder into a reused
 * translation. The only unchanged strings accepted are vetted cognates/brands. */
export function resolveReusedGuessrTranslation(
  source: string,
  localeResources: unknown,
  language: string,
): string | undefined {
  if (!Object.hasOwn(GUESSR_REUSED_TRANSLATIONS, source)) return undefined;
  const base = language.trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  const code = base === 'pt' ? 'br' : base;
  let value: unknown = localeResources;
  for (const part of GUESSR_REUSED_TRANSLATIONS[source].split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (code !== 'en' && value.trim() === source && !sameSpellingLanguages[source]?.includes(code)) return undefined;
  if (rejectedValues[source]?.[code] === value) return undefined;
  if (placeholders(value) !== placeholders(source)) return undefined;
  return value;
}
