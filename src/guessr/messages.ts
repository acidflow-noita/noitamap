import { bindText, formatGuessrNumber, tr, type TranslationValues } from './i18n';
import { guessrLocale } from './i18n';
import english from './locales/en.json';

export type Message = { source: string | (() => string); values?: TranslationValues | (() => TranslationValues) };
export type LocalizedText = string | Message;
/** Explicit messages keep player names, chat and identifiers out of translation. */
export function msg(source: Message['source'], values?: Message['values']): Message { return { source, values }; }
export function setText<T extends Node>(node: T, value: LocalizedText): T {
  if (typeof value === 'string') node.textContent = value;
  else bindText(node, value.source, value.values);
  return node;
}
export function localizedDistance(distance: number | null): string {
  if (distance === null) return tr('Skipped');
  if (distance <= 64) return tr('Right on the spot');
  const chunks = distance / 512;
  const count = chunks < 10 ? Math.round(chunks * 10) / 10 : Math.round(chunks);
  return tr('{{distance}} chunks away', { count, distance: formatGuessrNumber(count, { maximumFractionDigits: chunks < 10 ? 1 : 0 }) });
}
/** Provider/system diagnostics may be arbitrary English; known app errors use
 * their catalog entry and unexpected errors have a localized recovery message. */
export function localizedError(cause: unknown): string {
  const source = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (Object.hasOwn(english, source)) {
    const resetAt = (cause as { resetAt?: unknown } | null)?.resetAt;
    const message = tr(source);
    if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > 0 && resetAt < 8640000000000000)
      return message + ' ' + tr('The game creation limit resets at {{time}}.', { time: new Date(resetAt).toLocaleString(guessrLocale(), {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }) });
    return message;
  }
  return guessrLocale().startsWith('en') && source ? source : tr('Something went wrong. Please try again.');
}
