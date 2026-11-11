import i18next, { initializeTranslations, registerTranslationNamespace } from '../i18n';
import english from './locales/en.json';
const catalogs = import.meta.glob<Record<string, string>>('./locales/*.json', { import: 'default' });
registerTranslationNamespace('authSecurity', english, language => catalogs[`./locales/${language}.json`]?.() ?? Promise.resolve(english));

export async function loadAuthSecurityTranslations(): Promise<void> {
  try { await initializeTranslations(); await i18next.loadNamespaces('authSecurity'); }
  catch { /* Bundled English remains usable if a locale request fails. */ }
}
export async function authSecurityMessage(source: string, fallback = 'Could not connect this account.'): Promise<string> {
  await loadAuthSecurityTranslations();
  const key = Object.hasOwn(english, source) ? source : fallback;
  return String(i18next.t(key, { ns: 'authSecurity', defaultValue: key }));
}
