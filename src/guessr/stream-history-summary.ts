import type { StreamPublishedResult, StreamResult } from './stream-types';
import { streamHostName, streamPlayerName } from './stream-display-name';

/** Public totals only. Clues, answers and individual guesses stay out of history. */
export interface StreamHistorySummary {
  hostId: string;
  maximum: number;
  standings: [id: string, name: string, rank: number, score: number][];
}

export function streamHistorySummary(result: StreamPublishedResult | StreamResult): StreamHistorySummary {
  const hostName = streamHostName(result.host, result.players.find(player => player.id === result.host.id));
  return { hostId: result.host.id, maximum: (result.scheduledRounds ?? result.rounds.length) * 5000,
    standings: result.players.map(player => [player.id,
      streamPlayerName(player.id === result.host.id ? hostName : player.name, player.login), player.rank, player.score]) };
}
