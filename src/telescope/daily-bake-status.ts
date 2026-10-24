export type DailyBakePrefix = 'daily' | 'previous-daily';
export type DailyBakeStatus = 'checking' | 'ready' | 'unavailable' | 'unknown';

interface Check {
  seed: number;
  status: DailyBakeStatus;
}

// Only the two published daily slots are retained. A newer check owns its
// slot so late/aborted requests cannot overwrite a successful retry.
const checks = new Map<DailyBakePrefix, Check>();
const listeners = new Set<() => void>();

export function getDailyBakeStatus(prefix: DailyBakePrefix, seed: number): DailyBakeStatus | null {
  const check = checks.get(prefix);
  return check?.seed === seed ? check.status : null;
}

export function subscribeDailyBakeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) {
    try { listener(); }
    catch (error) { console.warn('[Daily bake] Status listener failed:', error); }
  }
}

export function beginDailyBakeCheck(prefix: DailyBakePrefix, seed: number): (status: DailyBakeStatus) => void {
  const check: Check = { seed, status: 'checking' };
  checks.set(prefix, check);
  notify();
  return status => {
    if (checks.get(prefix) !== check) return;
    check.status = status;
    notify();
  };
}
