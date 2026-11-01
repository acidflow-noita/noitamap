import { prepareAreaScorer } from './area-rules.ts';
import { ImageGameError } from './image-game-server.ts';
import { within, type Bounds, type Point } from './rules.ts';
import { STREAM_MAX_PLAYERS, type StreamReveal, type StreamRoundOutcome } from './stream-types.ts';

/** Scores one bounded host roster with the same source-cell scorer as the host UI.
 * Twitch delivery and assistance remain host-reported; coordinates and budgets
 * are validated here, and answer/area/bounds come from the opened private token. */
export function prepareStreamRoundOutcome(
  reveal: StreamReveal,
  submissions: unknown,
  bounds: Bounds,
): StreamRoundOutcome {
  if (submissions === undefined) submissions = [];
  if (!Array.isArray(submissions)) throw new ImageGameError(400, 'Invalid round submissions.');
  if (submissions.length > STREAM_MAX_PLAYERS)
    throw new ImageGameError(413, `Live round results support up to ${STREAM_MAX_PLAYERS} players.`);
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || !within(reveal.answer, bounds))
    throw new ImageGameError(400, 'Invalid round bounds or answer.');
  const scorer = prepareAreaScorer(reveal.area, reveal.answer);
  const ids = new Set<string>();
  const players = submissions.map((entry) => {
    const player = entry?.player;
    if (!player || typeof player.id !== 'string' || !/^\d{1,30}$/.test(player.id)
      || ids.has(player.id) || typeof player.login !== 'string' || !/^[a-z0-9_]{1,25}$/.test(player.login)
      || typeof player.name !== 'string' || !player.name.length || player.name.length > 48
      || !Number.isInteger(entry.maximum) || entry.maximum < 0 || entry.maximum > 5000
      || entry.guess !== null && !within(entry.guess, bounds))
      throw new ImageGameError(400, 'Invalid round participant, guess, or score limit.');
    ids.add(player.id);
    const guess: Point | null = entry.guess === null ? null : { x: entry.guess.x, y: entry.guess.y };
    const { score, areaScore, positionScore, distance } = scorer(guess, entry.maximum);
    return { id: player.id, guess, score, areaScore, positionScore, distance };
  });
  return {
    roundId: reveal.roundId,
    answer: { x: reveal.answer.x, y: reveal.answer.y },
    label: reveal.area.label,
    difficultyTier: reveal.area.difficultyTier!,
    players,
  };
}
