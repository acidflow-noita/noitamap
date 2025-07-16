import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';

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
} as const;

export type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGES;

// Configure i18next plugins but don't initialize yet
i18next.use(HttpApi).use(LanguageDetector);

export default i18next;
