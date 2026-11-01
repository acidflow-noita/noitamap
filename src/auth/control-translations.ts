import i18next from 'i18next';
import { GUESSR_REUSED_TRANSLATIONS, resolveReusedGuessrTranslation } from '../shared-ui-translations';

type Values = Record<string, string | number>;
interface Translation { key: string; source: string; values?: Values }
interface Bindings { text?: Translation; attributes: Map<string, Translation> }
const bindings = new WeakMap<Node, Bindings>();
const boundNodes = new Set<WeakRef<Node>>();

/** Provider UI can use a host page's namespace without importing that page,
 * starting authentication, or depending on its Bootstrap version. */
function translate({ key, source, values = {} }: Translation): string {
  if (!i18next.isInitialized) return source.replace(/\{\{\s*(\w+)\s*\}\}/g,
    (placeholder, name: string) => values[name] === undefined ? placeholder : String(values[name]));
  const shared = i18next.getResourceBundle(i18next.language, 'translation');
  const reviewed = resolveReusedGuessrTranslation(source, shared, i18next.language);
  if (reviewed !== undefined) return String(i18next.t(GUESSR_REUSED_TRANSLATIONS[source], {
    ...values, ns: 'translation', defaultValue: source,
  }));
  // For unmapped labels, an actual shared translation still takes priority.
  // A mapped label rejected above must not re-enter through a legacy alias.
  const mapValue = i18next.getResource(i18next.language, 'translation', key);
  if (!Object.hasOwn(GUESSR_REUSED_TRANSLATIONS, source) && typeof mapValue === 'string' && mapValue.trim() && mapValue !== source)
    return String(i18next.t(key, { ...values, ns: 'translation', defaultValue: source }));
  const local = i18next.getResource(i18next.language, 'guessr', source, { keySeparator: false });
  // Guessr supplies genuinely new text and replacements for rejected legacy
  // spellings; it does not override the map's reviewed terminology.
  if (typeof local === 'string' && local.trim() && local !== source) {
    return String(i18next.t(source, { ...values, ns: 'guessr', keySeparator: false, nsSeparator: false }));
  }
  return String(i18next.t(key, { ...values, ns: 'translation', defaultValue: source }));
}

function nodeBindings(node: Node): Bindings {
  let entry = bindings.get(node);
  if (!entry) {
    entry = { attributes: new Map() };
    bindings.set(node, entry);
    boundNodes.add(new WeakRef(node));
  }
  return entry;
}

export function bindAuthText<T extends Node>(node: T, key: string, source: string, values?: Values): T {
  const binding = { key, source, values };
  nodeBindings(node).text = binding;
  node.textContent = translate(binding);
  return node;
}

export function bindAuthAttribute<T extends Element>(node: T, attribute: string, key: string, source: string, values?: Values): T {
  const binding = { key, source, values };
  nodeBindings(node).attributes.set(attribute, binding);
  node.setAttribute(attribute, translate(binding));
  return node;
}

function refreshTranslations(): void {
  for (const reference of boundNodes) {
    const node = reference.deref();
    if (!node) { boundNodes.delete(reference); continue; }
    if (!node.isConnected) continue;
    const entry = bindings.get(node);
    if (entry?.text) node.textContent = translate(entry.text);
    if (node instanceof Element) {
      for (const [attribute, binding] of entry?.attributes ?? []) node.setAttribute(attribute, translate(binding));
    }
  }
}
i18next.on('languageChanged', refreshTranslations);
i18next.on('initialized', refreshTranslations);
