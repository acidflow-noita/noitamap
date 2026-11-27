import type { StreamPublishedResult } from '../../../src/guessr/stream-types';
import translations from './review-locales.json';

/** Called only after result ownership is verified. Localized case details stay in the Worker bundle. */
export function privateReviewReasons(result: StreamPublishedResult, requested: string): string[] {
  const requestedTag = requested.split(',')[0].trim().toLowerCase().split(/[-;]/)[0];
  const key = requestedTag === 'pt' ? 'br' : requestedTag;
  const language = Object.hasOwn(translations, key) ? (key as keyof typeof translations) : 'en';
  const strings = translations[language];
  const format = new Intl.NumberFormat(language === 'br' ? 'pt-BR' : language);
  const names = new Map(result.players.map(p => [p.id, p.name]));
  const reasons: string[] = [];
  for (const flag of result.reviewFlags ?? []) {
    const ids = [...new Set([...flag.highScorers, ...flag.explorers])];
    let people = ids
      .slice(0, 8)
      .map(id => names.get(id) ?? id)
      .join(', ');
    if (ids.length > 8) people += ' (+' + format.format(ids.length - 8) + ')';
    const group = strings.accountGroup.replace(/\{\{(players|round)\}\}/g, (_, value) =>
      value === 'players' ? people : format.format(flag.round)
    );
    reasons.push(group + (flag.nonSubmitting.length ? ' ' + strings.noGuess : ''));
  }
  if (reasons.length) reasons.push(strings.context);
  return reasons;
}
