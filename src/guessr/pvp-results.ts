import type { StreamResult } from './stream-types';
import { formatGuessrNumber, tr } from './i18n';

export function pvpResultHeadline(result: StreamResult): string {
  const conceded = result.players.find(p => p.id === result.concededBy);
  if (conceded) return tr('{{player}} conceded the match.', { player: conceded.name });
  const [first, second] = [...result.players].sort((a, b) => b.score - a.score);
  if (!second || first.score === second.score) return tr('Draw');
  const gap = first.score - second.score;
  return tr('{{player}} won by {{score}}.', { player: first.name,
    score: tr('{{points}} points', { count: gap, points: formatGuessrNumber(gap) }) });
}
