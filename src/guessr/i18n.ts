import i18next, { currentLanguage, initializeTranslations, languageLocale, registerTranslationNamespace } from '../i18n';
import englishMap from '../locales/en/translation.json';
import english from './locales/en.json';
import { GUESSR_REUSED_TRANSLATIONS, resolveReusedGuessrTranslation } from './reused-translations';
import { AREA_BIOME_MAP_FALLBACKS, formatGuessrAreaLabel } from './area-labels';

const NAMESPACE = 'guessr';
const resources = import.meta.glob<Record<string, string>>('./locales/*.json', { import: 'default' });
export type TranslationValues = Record<string, string | number>;
type TranslationSource = string | (() => string);
type BindingValues = TranslationValues | (() => TranslationValues);

registerTranslationNamespace(NAMESPACE, english, async language => {
  if (language === 'en') return english;
  const load = resources[`./locales/${language}.json`];
  if (!load) throw new Error(`Missing Guessr translations for ${language}`);
  return load();
});

let ready: Promise<void> | undefined;
export function initializeGuessrTranslations(): Promise<void> {
  return ready ??= (async () => {
    await initializeTranslations();
    await i18next.loadNamespaces(NAMESPACE);
    if (typeof document !== 'undefined') document.documentElement.lang = guessrLocale();
  })().catch(error => {
    ready = undefined;
    throw error;
  });
}

/** English source strings are literal keys, including punctuation and colons. */
export function tr(source: string, values: TranslationValues = {}): string {
  if (!i18next.isInitialized) {
    // A synchronous component can be constructed while the shared startup is
    // still pending. Keep its labels usable until the first language event.
    const catalogue = english as Record<string, string>;
    const plural = typeof values.count === 'number' ? `${source}_${new Intl.PluralRules('en').select(values.count)}` : source;
    return (catalogue[plural] ?? catalogue[source] ?? source).replace(/\{\{\s*([^},\s]+)\s*\}\}/g,
      (placeholder, name: string) => values[name] === undefined ? placeholder : String(values[name]));
  }
  const language = currentLanguage();
  const reused = resolveReusedGuessrTranslation(source, i18next.getResourceBundle(language, 'translation'), language);
  if (reused !== undefined) {
    return i18next.t(GUESSR_REUSED_TRANSLATIONS[source], {
      ...values, lng: language, ns: 'translation', keySeparator: '.', nsSeparator: false, defaultValue: reused,
    }) as string;
  }
  let key = source;
  // `br` is a legacy Portuguese resource ID. Intl/i18next otherwise read it as
  // Breton, whose plural rules are different (for example, zero and two).
  if (currentLanguage() === 'br' && typeof values.count === 'number') {
    const suffix = new Intl.PluralRules('pt-BR').select(values.count);
    const zeroKey = `${source}_zero`;
    const pluralKey = values.count === 0 && typeof i18next.getResource('br', NAMESPACE, zeroKey, { keySeparator: false }) === 'string'
      ? zeroKey : `${source}_${suffix}`;
    if (typeof i18next.getResource('br', NAMESPACE, pluralKey, { keySeparator: false }) === 'string') key = pluralKey;
  }
  return i18next.t(key, {
    ...values,
    ns: NAMESPACE,
    keySeparator: false,
    nsSeparator: false,
    defaultValue: source,
  }) as string;
}

export function guessrLocale(): string { return languageLocale(); }
export function formatGuessrNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(guessrLocale(), options).format(value);
}

/** The map catalogue contains the canonical CSV terms. Explicit canonical keys
 * take precedence; case-insensitive labels prefer those over old map aliases. */
const gameTermKeys = new Map<string, string>();
const gameTermLabels = new Map<string, { key: string; priority: number }>();
for (const [section, entries] of Object.entries({
  biomes: englishMap.gameContent.biomes,
  items: englishMap.gameContent.items,
  materials: englishMap.gameContent.materials,
  bosses: englishMap.gameContent.bosses,
  structures: englishMap.gameContent.structures,
})) {
  for (const [key, label] of Object.entries(entries)) {
    const path = `gameContent.${section}.${key}`;
    const normalized = label.trim().toLowerCase();
    const priority = key.startsWith('biome_') ? 3 : key.startsWith('animal_') ? 2 : 0;
    if (!gameTermLabels.has(normalized) || priority > gameTermLabels.get(normalized)!.priority) {
      gameTermLabels.set(normalized, { key: path, priority });
    }
    gameTermKeys.set(key, path);
    if (section === 'materials') gameTermKeys.set(`mat_${key}`, path);
  }
}

function canonicalGameTerm(englishName: string, canonicalKey?: string): string {
  if (!i18next.isInitialized) return englishName;
  const key = canonicalKey ? gameTermKeys.get(canonicalKey) ?? canonicalKey
    : gameTermLabels.get(englishName.trim().toLowerCase())?.key ?? gameTermKeys.get(englishName);
  if (!key) return englishName;
  const language = currentLanguage();
  if (language !== 'en' && key.startsWith('gameContent.biomes.')) {
    const biomeKey = key.slice('gameContent.biomes.'.length);
    const source = String(i18next.getResource('en', 'translation', key) ?? englishName).trim().toLowerCase();
    const local: unknown = i18next.getResource(language, 'translation', key);
    if (typeof local !== 'string' || !local.trim() || local.trim().toLowerCase() === source) {
      for (const alias of AREA_BIOME_MAP_FALLBACKS[biomeKey] ?? []) {
        const value: unknown = i18next.getResource(language, 'translation', alias);
        if (typeof value !== 'string' || !value.trim()) continue;
        const normalized = value.trim().toLowerCase();
        const aliasSource = String(i18next.getResource('en', 'translation', alias) ?? '').trim().toLowerCase();
        if (normalized === source || normalized === aliasSource || normalized === englishName.trim().toLowerCase()) continue;
        if (biomeKey === 'biome_tower' && normalized === 'the tower') continue;
        return value;
      }
    }
  }
  return i18next.t(key, { ns: 'translation', defaultValue: englishName }) as string;
}

export function guessrGameTerm(englishName: string, canonicalKey?: string): string {
  return formatGuessrAreaLabel(englishName, canonicalKey, {
    language: i18next.isInitialized ? currentLanguage() : 'en',
    term: canonicalGameTerm,
    text: tr,
    number: formatGuessrNumber,
    existing: (source, key) => {
      if (!i18next.isInitialized) return undefined;
      const value: unknown = i18next.getResource(currentLanguage(), 'translation', key);
      return typeof value === 'string' && value.trim() && value !== source ? value : undefined;
    },
  }) ?? canonicalGameTerm(englishName, canonicalKey);
}

interface NodeBindings { text?: () => string; attributes: Map<string, () => string> }
const bindings = new WeakMap<Node, NodeBindings>();
const boundNodes = new Set<WeakRef<Node>>();
function nodeBindings(node: Node): NodeBindings {
  let entry = bindings.get(node);
  if (!entry) {
    entry = { attributes: new Map() };
    bindings.set(node, entry);
    boundNodes.add(new WeakRef(node));
  }
  return entry;
}
function translation(source: TranslationSource, values?: BindingValues): () => string {
  return typeof source === 'function' ? source : () => tr(source, typeof values === 'function' ? values() : values);
}

/** Bind only a leaf node: its contents are owned by this translation. Rebinding
 * replaces the old source, including when a button changes its current action. */
export function bindText<T extends Node>(node: T, source: TranslationSource, values?: BindingValues): T {
  const render = translation(source, values);
  nodeBindings(node).text = render;
  node.textContent = render();
  return node;
}

export function bindAttribute<T extends Element>(node: T, attribute: string, source: TranslationSource, values?: BindingValues): T {
  const render = translation(source, values);
  nodeBindings(node).attributes.set(attribute, render);
  node.setAttribute(attribute, render());
  return node;
}

function refreshBoundTranslations(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = guessrLocale();
  for (const reference of boundNodes) {
    const node = reference.deref();
    if (!node) { boundNodes.delete(reference); continue; }
    if (!node.isConnected) continue;
    const entry = bindings.get(node);
    if (entry?.text) node.textContent = entry.text();
    if (node instanceof Element) for (const [attribute, render] of entry?.attributes ?? []) node.setAttribute(attribute, render());
  }
}
i18next.on('languageChanged', refreshBoundTranslations);

/** Owners of live numeric displays can repaint those values without replacing
 * their game shell, reconnecting chat, or changing the selected map position. */
export function onGuessrLanguageChanged(callback: () => void): () => void {
  i18next.on('languageChanged', callback);
  return () => i18next.off('languageChanged', callback);
}
