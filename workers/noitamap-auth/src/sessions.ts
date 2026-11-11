import type { D1Database } from '@cloudflare/workers-types';
import type { Account, Identity } from './accounts';

export interface LoginSession {
  id: string;
  account_id: string;
  account_version: number;
  refresh_version: number;
  created_at: number;
  refreshed_at: number;
  expires_at: number;
  revoked_at: number | null;
}
export interface SessionClaims { sid: string; account_id: string; account_version: number }
export type SessionAccount = Account & { session: LoginSession };

export async function createLoginSession(db: D1Database, account: Account, now = Date.now()): Promise<LoginSession> {
  const session: LoginSession = { id: crypto.randomUUID(), account_id: account.id, account_version: account.version,
    refresh_version: 0, created_at: now, refreshed_at: now, expires_at: now + 90 * 86400000, revoked_at: null };
  const result = await db.prepare(`INSERT INTO auth_sessions(id,account_id,account_version,created_at,refreshed_at,expires_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND version=?)`)
    .bind(session.id, account.id, account.version, now, now, session.expires_at, account.id, account.version).run();
  if (result.meta.changes !== 1) throw Error('Account changed during sign-in.');
  return session;
}
export async function readSessionAccount(db: D1Database, claims: SessionClaims, now = Date.now()): Promise<SessionAccount | null> {
  const rows = await db.prepare(`SELECT i.*, a.version AS account_version,
    s.id AS session_id,s.refresh_version,s.created_at,s.refreshed_at,s.expires_at
    FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id JOIN auth_identities i ON i.account_id=a.id
    WHERE s.id=? AND s.account_id=? AND s.account_version=? AND a.version=s.account_version
      AND s.revoked_at IS NULL AND s.expires_at>? ORDER BY i.provider`)
    .bind(claims.sid, claims.account_id, claims.account_version, now)
    .all<Identity & { account_version: number; session_id: string; refresh_version: number; created_at: number; refreshed_at: number; expires_at: number }>();
  const first = rows.results[0];
  if (!first) return null;
  return { id: claims.account_id, version: first.account_version, identities: rows.results,
    session: { id: first.session_id, account_id: claims.account_id, account_version: first.account_version,
      refresh_version: first.refresh_version, created_at: first.created_at, refreshed_at: first.refreshed_at,
      expires_at: first.expires_at, revoked_at: null } };
}
export async function rotateRefresh(db: D1Database, session: LoginSession, version: number, now = Date.now()): Promise<'ok' | 'retry' | 'revoked'> {
  if (version !== session.refresh_version) {
    // A concurrent tab gets no replacement token. Web Locks normally serialize
    // refreshes; this short window prevents a race from revoking the whole login.
    if (version === session.refresh_version - 1 && now - session.refreshed_at < 10000) return 'retry';
    if (version < session.refresh_version) await revokeLoginSession(db, session.id, session.account_id, now);
    return 'revoked';
  }
  const rotated = await db.prepare(`UPDATE auth_sessions SET refresh_version=refresh_version+1,refreshed_at=?
    WHERE id=? AND account_id=? AND refresh_version=? AND revoked_at IS NULL AND expires_at>?
      AND EXISTS (SELECT 1 FROM auth_accounts a WHERE a.id=auth_sessions.account_id AND a.version=auth_sessions.account_version)`)
    .bind(now, session.id, session.account_id, version, now).run();
  return rotated.meta.changes === 1 ? 'ok' : 'retry';
}
export async function revokeLoginSession(db: D1Database, id: string, accountId: string, now = Date.now()): Promise<void> {
  await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL')
    .bind(now, id, accountId).run();
}
