type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export const DAILY_ANSWERS_PREFIX = 'noitamap-guessr-answers-v1-';
export const ANSWERS_VIEWED_MESSAGE = 'You viewed the answers. You can no longer play this game in this browser.';
export const VIEW_ANSWERS_WARNING = 'Viewing answers prevents you from playing or continuing this game in this browser.';
const memory = new WeakMap<Storage, Set<string>>();

/** A local spoiler reminder, not account-wide enforcement or an API guard. */
export function hasViewedDailyAnswers(day: string, storage: Storage): boolean {
  if (memory.get(storage)?.has(day)) return true;
  try { return storage.getItem(DAILY_ANSWERS_PREFIX + day) === '1'; }
  catch { return false; }
}
export function rememberDailyAnswers(day: string, storage: Storage): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid daily date.');
  const seen = memory.get(storage) ?? new Set<string>();
  seen.add(day); memory.set(storage, seen);
  // Keep the current tab consistent even when the browser refuses persistence.
  storage.setItem(DAILY_ANSWERS_PREFIX + day, '1');
}
