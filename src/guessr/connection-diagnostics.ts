/** Bounded support evidence only. Never record tokens, URLs, payloads or guesses. */
export interface ConnectionDiagnostic {
  event: 'socket-close' | 'keepalive-timeout' | 'game-update-timeout' | 'subscription-failed' | 'subscription-revoked'
    | 'send-failed' | 'broadcast-retry' | 'broadcast-failed' | 'connected';
  status?: number;
  code?: string;
  attempt?: number;
}
const KEY = 'noitamap-guessr-connection-diagnostics-v1';
const events: (ConnectionDiagnostic & { at: string })[] = [];
const names = new Set(['socket-close', 'keepalive-timeout', 'game-update-timeout', 'subscription-failed', 'subscription-revoked',
  'send-failed', 'broadcast-retry', 'broadcast-failed', 'connected']);
function safeRecord(value: any): ConnectionDiagnostic & { at: string } | null {
  if (!value || !names.has(value.event) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  const record: ConnectionDiagnostic & { at: string } = { at: value.at, event: value.event };
  if (Number.isSafeInteger(value.status)) record.status = value.status;
  if (typeof value.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.code)) record.code = value.code;
  if (Number.isSafeInteger(value.attempt)) record.attempt = value.attempt;
  return record;
}
try {
  const saved = localStorage.getItem(KEY);
  if (saved && saved.length <= 16_000) {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) for (const value of parsed.slice(-60)) {
      const record = safeRecord(value); if (record) events.push(record);
    }
  }
} catch { /* Storage is optional. */ }
export function connectionDiagnostic(value: ConnectionDiagnostic): void {
  const record: ConnectionDiagnostic & { at: string } = { at: new Date().toISOString(), event: value.event };
  if (Number.isSafeInteger(value.status)) record.status = value.status;
  if (typeof value.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.code)) record.code = value.code;
  if (Number.isSafeInteger(value.attempt)) record.attempt = value.attempt;
  events.push(record); if (events.length > 60) events.shift();
  try { localStorage.setItem(KEY, JSON.stringify(events)); } catch { /* Diagnostics never block play. */ }
}
export function connectionDiagnostics(): unknown[] {
  try {
    const old = localStorage.getItem(KEY);
    if (old && old.length <= 16_000) {
      const parsed = JSON.parse(old);
      if (Array.isArray(parsed)) return parsed.slice(-60).map(safeRecord).filter(Boolean);
    }
  } catch { /* Storage is optional. */ }
  return events.map(event => ({ ...event }));
}
if (typeof window !== 'undefined') Object.assign(window, { __noitaGuessrConnectionDiagnostics: connectionDiagnostics });
