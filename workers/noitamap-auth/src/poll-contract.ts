export const HARD_PUZZLE_POLL = 'hard-puzzles-v1';
export const HARD_PUZZLE_POLL_PATH = '/auth/polls/' + HARD_PUZZLE_POLL;
export const HARD_PUZZLE_POLL_SECONDS = 3 * 24 * 60 * 60;
export type PollChoice = 'yes' | 'no';
export interface GuessrBallot {
  phase: 'scheduled' | 'open' | 'closed';
  serverNow: number;
  opensAt: number;
  closesAt: number;
  vote: PollChoice | null;
  totals?: { yes: number; no: number };
}
