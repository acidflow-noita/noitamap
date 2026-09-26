import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';
import localeUrls from 'virtual:noitamap-locales';

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

// Configure i18next plugins but don't initialize yet
i18next.use(HttpApi).use(LanguageDetector);

export function initializeTranslations() {
  return i18next.init({
    fallbackLng: 'en',
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
      requestOptions: {
        // Production URLs change with their contents, so repeat visits reuse
        // the browser cache while a new dictionary never reuses stale text.
        cache: import.meta.env.PROD ? 'force-cache' : 'no-store',
      },
    },
    interpolation: { escapeValue: false },
    supportedLngs: Object.keys(SUPPORTED_LANGUAGES),
    load: 'languageOnly',
    cleanCode: true,
    nonExplicitSupportedLngs: true,
  });
}

export default i18next;
