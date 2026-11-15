import { bindText, formatGuessrNumber, tr } from './i18n';
import type { NetworkReviewFlag, StreamPlayer } from './stream-types';

export function networkReviewText(flag: NetworkReviewFlag, players: readonly StreamPlayer[], playerId?: string): string {
  const names = new Map(players.map(p => [p.id, p.name]));
  const ids = [...new Set([...(playerId ? [playerId] : flag.highScorers), ...flag.explorers])];
  let people = ids.slice(0, 8).map(id => names.get(id)).filter(Boolean).join(', ');
  if (ids.length > 8) people += ', ' + tr('and {{count}} more', { count: ids.length - 8 });
  return [tr('{{players}} used the same internet connection in round {{round}}.', { players: people, round: formatGuessrNumber(flag.round) }),
    flag.nonSubmitting.length ? tr('At least one of those accounts did not submit a guess for this round.') : '',
    tr('Shared connections can cause this flag. It does not prove cheating, and scores are unchanged.')].filter(Boolean).join(' ');
}
/** Only public evidence enters this view, never raw IPs or network identifiers. */
export function networkReviewView(flags: readonly NetworkReviewFlag[] | undefined, players: readonly StreamPlayer[], playerId: string): HTMLElement | undefined {
  const relevant = flags?.filter(flag => flag.highScorers.includes(playerId));
  if (!relevant?.length) return;
  const details = document.createElement('details'); details.className = 'network-review';
  const summary = document.createElement('summary'); bindText(summary, 'Shared internet connection'); details.append(summary);
  for (const flag of relevant) { const text = document.createElement('p'); bindText(text, () => networkReviewText(flag, players, playerId)); details.append(text); }
  return details;
}

export function networkReviewSummary(flags: readonly NetworkReviewFlag[] | undefined, players: readonly StreamPlayer[]): HTMLElement | undefined {
  if (!flags?.length) return;
  const groups = new Map<string, NetworkReviewFlag[]>();
  for (const flag of flags) {
    const key = [...new Set([...flag.highScorers, ...flag.explorers])].sort().join(',');
    const group = groups.get(key) ?? []; group.push(flag); groups.set(key, group);
  }
  const details = document.createElement('details'); details.className = 'network-review network-review-summary';
  const summary = document.createElement('summary'); bindText(summary, 'Shared connection groups: {{count}}', { count: groups.size }); details.append(summary);
  let number = 0;
  for (const group of groups.values()) {
    const section = document.createElement('section'), heading = document.createElement('h3');
    bindText(heading, 'Group {{number}}', { number: formatGuessrNumber(++number) }); section.append(heading);
    for (const flag of group) { const p = document.createElement('p'); bindText(p, () => networkReviewText(flag, players)); section.append(p); }
    details.append(section);
  }
  return details;
}
