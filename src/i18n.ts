import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';
import localeUrls from 'virtual:noitamap-locales';
import english from './locales/en/translation.json';
import { STARTUP_REQUEST_TIMEOUT_MS } from './startup';

export const SUPPORTED_LANGUAGES = {
  en: { name: 'English', flag: 'United States' },
  ru: { name: 'Русский', flag: 'Russia' },
  zh: { name: '中文', flag: 'China' },
  de: { name: 'Deutsch', flag: 'Germany' },
  ja: { name: '日本語', flag: 'Japan' },
  uk: { name: 'Українська', flag: 'Ukraine' },
  br: { name: 'Português', flag: 'Brazil' },
  pl: { name: 'Polski', flag: 'Poland' },
  fr: { name: 'Français', flag: 'France' },
  es: { name: 'Español', flag: 'Spain' },
  nl: { name: 'Nederlands', flag: 'Netherlands' },
  fi: { name: 'Suomi', flag: 'Finland' },
  cs: { name: 'Čeština', flag: 'Czechia' },
  it: { name: 'Italiano', flag: 'Italy' },
  sv: { name: 'Svenska', flag: 'Sweden' },
  id: { name: 'Bahasa Indonesia', flag: 'Indonesia' },
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;
export const STARTUP_MESSAGES = english.startup;

// Configure i18next plugins but don't initialize yet
i18next.use(HttpApi).use(LanguageDetector);

export function initializeTranslations() {
  return i18next.init({
    fallbackLng: 'en',
    resources: { en: { translation: english } },
    partialBundledLanguages: true,
    maxRetries: 0,
    debug: false,
    showSupportNotice: false,
    detection: {
      order: ['querystring', 'cookie', 'localStorage', 'sessionStorage', 'navigator', 'htmlTag'],
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
      lookupLocalStorage: 'i18nextLng',
      lookupSessionStorage: 'i18nextLng',
      caches: ['localStorage', 'cookie'],
    },
    backend: {
      loadPath: (languages: string[]) => localeUrls[languages[0]] ?? localeUrls.en,
      requestOptions: () => ({ cache: import.meta.env.PROD ? 'force-cache' : 'no-store', signal: AbortSignal.timeout(STARTUP_REQUEST_TIMEOUT_MS) }),
    },
    interpolation: { escapeValue: false },
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
    load: 'languageOnly',
    cleanCode: true,
    nonExplicitSupportedLngs: true,
  });
}

export default i18next;
