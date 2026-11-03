import type {
  StreamPublishedResult,
  StreamPublishInput,
  StreamPublishWireInput,
  StreamResult,
} from "./stream-types";
import { twitchColor } from './player-color';

/** Numeric pairs keep the once-per-game upload/store small. Local state and
 * downloads retain readable field names; no player or score is omitted. */
export function packStreamPublish(
  input: StreamPublishInput,
): StreamPublishWireInput {
  return {
    token: input.token,
    finishedAt: input.finishedAt,
    players: input.players.map((player) => ({
      id: player.id,
      name: player.name,
      login: player.login,
      ...(twitchColor(player.color) ? { color: twitchColor(player.color) } : {}),
      score: player.score,
      rounds: player.rounds.map((round): [number, number] => {
        if (round.score !== round.areaScore + round.positionScore)
          throw new Error("Invalid round score total.");
        return [round.areaScore, round.positionScore];
      }),
    })),
  };
}
export function expandStreamResult(
  input: StreamPublishedResult | StreamResult,
): StreamResult {
  if (!("format" in input)) return input;
  if (input.format !== "compact-scores-v1")
    throw new Error("This result format is not supported.");
  const { format: _format, players, ...result } = input;
  return {
    ...result,
    players: players.map((player) => ({
      ...player,
      rounds: player.rounds.map(([areaScore, positionScore]) => ({
        areaScore,
        positionScore,
        score: areaScore + positionScore,
      })),
    })),
  };
}
