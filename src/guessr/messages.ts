import { bindText, formatGuessrNumber, guessrLocale, tr, type TranslationValues } from './i18n';
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
export function quotaTiming(resetAt: number, checking: boolean, now = Date.now()): string {
  const locale = guessrLocale(), reset = new Date(resetAt);
  const ms = Math.max(0, resetAt - now), minutes = Math.ceil(ms / 60000);
  const units: string[] = [];
  const unit = (value: number, name: string) => formatGuessrNumber(value, { style: 'unit', unit: name, unitDisplay: 'long' });
  if (ms <= 60000) units.push(unit(Math.ceil(ms / 1000), 'second'));
  else {
    if (minutes >= 60) units.push(unit(Math.floor(minutes / 60), 'hour'));
    if (minutes % 60) units.push(unit(minutes % 60, 'minute'));
  }
  return tr(checking ? 'Next availability check in {{duration}} (at {{time}} on {{date}}).'
    : 'Limits reset in {{duration}} (at {{time}} on {{date}}).', {
    duration: new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(units),
    time: reset.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    date: reset.toLocaleDateString(locale, { month: 'short', day: 'numeric',
      ...(reset.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) }),
  });
}
/** Provider/system diagnostics may be arbitrary English; known app errors use
 * their catalog entry and unexpected errors have a localized recovery message. */
export function localizedError(cause: unknown): string {
  const source = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (Object.hasOwn(english, source)) {
    const resetAt = (cause as { resetAt?: unknown } | null)?.resetAt;
    const message = tr(source);
    if (typeof resetAt === 'number' && resetAt > Date.now() && resetAt < 8640000000000000)
      return message + ' ' + quotaTiming(resetAt, source === 'New games are paused while availability is checked.');
    return message;
  }
  return guessrLocale().startsWith('en') && source ? source : tr('Something went wrong. Please try again.');
}
