import type { RankedState } from './api';

export const ACTIVE_MODE_KEY = 'noitamap-guessr-active-mode-v1';
export const DAILY_RESUME_KEY = 'noitamap-guessr-daily-resume-v1';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface DailyResume { id: string; day: string; round: number; totalRounds: number; completedRounds: number }

/** A small bookmark lets the lobby offer Continue daily without an auth/API request. */
export function readDailyResume(storage: Pick<Storage, 'getItem'>): DailyResume | null {
  try {
    const value = JSON.parse(storage.getItem(DAILY_RESUME_KEY) || 'null');
    return value && typeof value.id === 'string' && /^[\w-]{1,100}$/.test(value.id)
      && typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
      && Number.isInteger(value.totalRounds) && value.totalRounds >= 1 && value.totalRounds <= 5
      && Number.isInteger(value.round) && value.round >= 0 && value.round < value.totalRounds
      && Number.isInteger(value.completedRounds) && value.completedRounds >= 0 && value.completedRounds <= value.totalRounds
      ? value : null;
  } catch { return null; }
}
export function forgetDailyResume(id: string, storage: Storage): void {
  if (readDailyResume(storage)?.id === id) storage.removeItem(DAILY_RESUME_KEY);
}
export function rememberDailyResume(state: RankedState, storage: Storage): void {
  if (state.status !== 'active') { forgetDailyResume(state.id, storage); return; }
  storage.setItem(DAILY_RESUME_KEY, JSON.stringify({ id: state.id, day: state.day, round: state.round,
    totalRounds: state.totalRounds, completedRounds: state.submitted.length } satisfies DailyResume));
  storage.setItem(ACTIVE_MODE_KEY, 'daily');
}
