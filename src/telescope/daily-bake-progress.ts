/** Sanitized CI reports served as static assets; no GitLab requests or links. */
export const DAILY_BAKE_PROGRESS_URL = 'https://bake-status.acidflow.stream/status.json';
export type BakePhase = 'running' | 'waiting' | 'publishing' | 'failed' | 'canceled' | 'ready';
export interface BakeProgress {
  seed: number;
  phase: BakePhase;
  requestedAt: string;
  startedAt: string;
  updatedAt: string;
  expectedReadyAt: string;
  expiresAt: string;
}
const phases = new Set<BakePhase>(['running', 'waiting', 'publishing', 'failed', 'canceled', 'ready']);
const timestamps = ['requestedAt', 'startedAt', 'updatedAt', 'expectedReadyAt', 'expiresAt'] as const;

export function parseBakeProgress(value: unknown, now = Date.now()): BakeProgress[] {
  const document = value as { schemaVersion?: unknown; entries?: unknown[] } | null;
  if (document?.schemaVersion !== 1 || !Array.isArray(document.entries) || document.entries.length > 4) return [];
  return document.entries.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const row = value as BakeProgress;
    if (!Number.isSafeInteger(row.seed) || row.seed <= 0 || row.seed > 0xffffffff || !phases.has(row.phase)
      || timestamps.some(key => typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key])))
      || Date.parse(row.startedAt) > now + 120_000 || Date.parse(row.updatedAt) > now + 120_000
      || Date.parse(row.expiresAt) <= now || Date.parse(row.expiresAt) > now + 3 * 86400_000) return [];
    // Only this whitelist can reach a visitor. Ignore any additional CI fields.
    return [{ seed: row.seed, phase: row.phase, requestedAt: row.requestedAt, startedAt: row.startedAt,
      updatedAt: row.updatedAt, expectedReadyAt: row.expectedReadyAt, expiresAt: row.expiresAt }];
  });
}

/** The seed updater's configured cron is 00:01 UTC; allow 15 minutes. */
export function scheduledBakeReadyAt(prefix: 'daily' | 'previous-daily', now = Date.now()): string {
  const day = new Date(now - (prefix === 'previous-daily' ? 86400_000 : 0));
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 16)).toISOString();
}

export function localBakeTime(iso: string, language?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(language === 'br' ? 'pt-BR' : language, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
