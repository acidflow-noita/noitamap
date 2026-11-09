import type { RankedState } from './api';

export interface DailyShareData {
  readonly day: string;
  readonly scores: readonly number[];
  readonly total: number;
}

export const DAILY_SHARE_MAXIMUM = 50_000;

/** An explicit allowlist: never give the renderer the attempt, identity, seed,
 * clue URLs, coordinates or location names from a full result response. */
export function dailyShareData(state: RankedState): DailyShareData | null {
  if (state.status !== 'complete' || state.totalRounds !== 10 || state.results?.length !== 10) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day)) return null;
  const date = new Date(`${state.day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== state.day) return null;
  const scores: number[] = [];
  for (const round of state.results) {
    if (!Number.isInteger(round.ordinal) || round.ordinal < 0 || round.ordinal >= 10 || round.ordinal in scores) return null;
    const score = round.guess === null ? 0 : round.guess?.score;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 5000) return null;
    scores[round.ordinal] = score;
  }
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (state.score !== undefined && state.score !== total) return null;
  return Object.freeze({ day: state.day, scores: Object.freeze(scores), total });
}

export function dailyShareFilename(data: DailyShareData): string {
  return `noitaguessr-daily-${data.day}.png`;
}
