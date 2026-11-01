import { DAILY_BAKE_PROGRESS_URL, parseBakeProgress, type BakeProgress } from './daily-bake-progress';

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
let progress: BakeProgress[] = [];
let fetchedAt = -Infinity;
let pending: Promise<void> | undefined;

export function getDailyBakeProgress(seed: number): BakeProgress | null {
  return progress.find(row => row.seed === seed && Date.parse(row.expiresAt) > Date.now()) ?? null;
}

/** One shared read on a missing bake or a reopened popover; never a polling loop. */
export function refreshDailyBakeProgress(): Promise<void> {
  if (pending) return pending;
  if (Date.now() - fetchedAt < 60_000) return Promise.resolve();
  fetchedAt = Date.now();
  pending = (async () => {
    try {
      const response = await fetch(DAILY_BAKE_PROGRESS_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > 8192) return;
      progress = parseBakeProgress(JSON.parse(text));
      notify();
    } catch { /* An unavailable status feed is unknown, never proof of failure. */ }
  })().finally(() => { pending = undefined; });
  return pending;
}

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
    if (status === 'unavailable') void refreshDailyBakeProgress();
  };
}
