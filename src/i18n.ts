import i18next, { type ReadCallback, type Resource, type ResourceKey } from 'i18next';
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

/** The map's historic Portuguese identifier is `br`, not a BCP 47 locale. */
export function normalizeLanguageCode(language: string): string {
  const base = language.trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  return base === 'pt' ? 'br' : base;
}

export function currentLanguage(): SupportedLanguage {
  const code = normalizeLanguageCode(i18next.language || 'en');
  return Object.hasOwn(SUPPORTED_LANGUAGES, code) ? code as SupportedLanguage : 'en';
}

export function languageLocale(language: string = currentLanguage()): string {
  const code = normalizeLanguageCode(language);
  return code === 'br' ? 'pt-BR' : code === 'zh' ? 'zh-CN' : code;
}

const bundledResources: Resource = { en: { translation: english } };
const namespaceLoaders = new Map<string, (language: string) => Promise<ResourceKey>>();

/** Let another page share language selection without putting its dictionaries in
 * the map bundle. Its non-English dictionaries are loaded only when selected. */
export function registerTranslationNamespace(
  namespace: string,
  englishResource: ResourceKey,
  load: (language: string) => Promise<ResourceKey>,
): void {
  namespaceLoaders.set(namespace, load);
  bundledResources.en[namespace] = englishResource;
  if (i18next.isInitialized) i18next.addResourceBundle('en', namespace, englishResource);
}

class TranslationBackend extends HttpApi {
  override read(language: string, namespace: string, callback: ReadCallback): void {
    const load = namespaceLoaders.get(namespace);
    if (!load) {
      super.read(language, namespace, callback);
      return;
    }
    void load(language).then(resource => callback(null, resource), error => callback(error, false));
  }
}

// Configure i18next plugins but don't initialize yet
i18next.use(TranslationBackend).use(LanguageDetector);
let translationsReady: ReturnType<typeof i18next.init> | undefined;

export function initializeTranslations() {
  if (translationsReady) return translationsReady;
  translationsReady = i18next.init({
    fallbackLng: 'en',
    resources: bundledResources,
    ns: ['translation', ...namespaceLoaders.keys()],
    defaultNS: 'translation',
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
      convertDetectedLanguage: normalizeLanguageCode,
      cookieOptions: { path: '/', sameSite: 'lax' },
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
  }).catch(error => {
    translationsReady = undefined;
    throw error;
  });
  return translationsReady;
}

export default i18next;
