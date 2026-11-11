import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
/** Durable account links. Provider credentials are encrypted by the caller. */
export type Provider = 'patreon' | 'twitch';
export interface Identity {
  provider: Provider;
  provider_user_id: string;
  account_id: string;
  username: string;
  nickname: string | null;
  login: string | null;
  is_follower: number;
  is_subscriber: number;
  checked_at: number;
  status: 'active' | 'reconnect';
  credentials: string;
  refresh_lock: string | null;
  refresh_lock_until: number;
}
export type VerifiedIdentity = Omit<Identity, 'account_id' | 'refresh_lock' | 'refresh_lock_until'>;
export interface Account { id: string; version: number; identities: Identity[] }
export interface LinkIntent {
  id: string;
  account_id: string;
  account_version: number;
  provider: Provider;
  /** 0: sign-in only; 1: read/write chat; 2: also announcements. */
  chat: number;
  redirect_url: string;
  expires_at: number;
  started: number;
  candidate: string | null;
  completion: string | null;
}

export async function readAccount(db: D1Database, id: string): Promise<Account | null> {
  const rows = await db.prepare(`SELECT i.*, a.version AS account_version FROM auth_identities i
    JOIN auth_accounts a ON a.id = i.account_id WHERE a.id = ? ORDER BY i.provider`)
    .bind(id).all<Identity & { account_version: number }>();
  return rows.results.length ? { id, version: rows.results[0].account_version, identities: rows.results } : null;
}

export async function saveIdentity(db: D1Database, identity: VerifiedIdentity, target?: { id: string; version: number }): Promise<Account> {
  const existing = await db.prepare('SELECT * FROM auth_identities WHERE provider = ? AND provider_user_id = ?')
    .bind(identity.provider, identity.provider_user_id).first<Identity>();
  const id = target?.id || existing?.account_id || crypto.randomUUID();
  if (target) {
    const account = await readAccount(db, id);
    if (!account || account.version !== target.version) throw new Error('link_session_changed');
    if (account.identities.some(row => row.provider === identity.provider && row.provider_user_id !== identity.provider_user_id)) {
      throw new Error('provider_already_linked');
    }
  }
  // An independently signed-in single-provider account can be merged after
  // OAuth has proved ownership of that provider. Never absorb other links.
  if (existing && existing.account_id !== id) {
    const source = await readAccount(db, existing.account_id);
    if (!source || source.identities.length !== 1) throw new Error('account_already_linked');
  }
  const statements: D1PreparedStatement[] = [];
  if (!target) statements.push(db.prepare('INSERT OR IGNORE INTO auth_accounts (id) VALUES (?)').bind(id));
  if (existing && existing.account_id !== id) {
    statements.push(db.prepare(`UPDATE auth_identities SET account_id = ?
      WHERE provider = ? AND provider_user_id = ? AND account_id = ?
      AND (SELECT COUNT(*) FROM auth_identities WHERE account_id = ?) = 1
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = ? AND version = ?)`)
      .bind(id, identity.provider, identity.provider_user_id, existing.account_id, existing.account_id, id, target!.version));
  }
  statements.push(db.prepare(`INSERT INTO auth_identities
    (provider, provider_user_id, account_id, username, nickname, login, is_follower, is_subscriber, checked_at, status, credentials)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE id = ? AND (? IS NULL OR version = ?))
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      username = excluded.username, nickname = excluded.nickname, login = excluded.login,
      is_follower = excluded.is_follower, is_subscriber = excluded.is_subscriber,
      checked_at = excluded.checked_at, status = excluded.status, credentials = excluded.credentials,
      refresh_lock = NULL, refresh_lock_until = 0
    WHERE auth_identities.account_id = excluded.account_id`)
    .bind(identity.provider, identity.provider_user_id, id, identity.username, identity.nickname, identity.login,
      identity.is_follower, identity.is_subscriber, identity.checked_at, identity.status, identity.credentials,
      id, target?.version ?? null, target?.version ?? null));
  if (target) statements.push(db.prepare(`UPDATE auth_accounts SET version = version + 1
    WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM auth_identities
      WHERE account_id = ? AND provider = ? AND provider_user_id = ?)`)
    .bind(id, target.version, id, identity.provider, identity.provider_user_id));
  const saved = await db.batch(statements);
  if (target && saved[saved.length - 1].meta.changes !== 1) throw new Error('link_session_changed');
  const account = await readAccount(db, id);
  if (!account || !account.identities.some(row => row.provider === identity.provider && row.provider_user_id === identity.provider_user_id)) {
    throw new Error('link_session_changed');
  }
  return account;
}

export async function unlinkIdentity(db: D1Database, account: Account, provider: Provider): Promise<Account | null> {
  // Both the count guard and version guard run in the same SQL statement.
  // A delete trigger revokes existing account sessions, including the removed
  // provider's sessions; the caller signs in again through a remaining one.
  const removed = await db.prepare(`DELETE FROM auth_identities
    WHERE account_id = ? AND provider = ?
    AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = ? AND version = ?)
    AND EXISTS (SELECT 1 FROM auth_identities WHERE account_id = ? AND provider <> ? AND status = 'active')
    RETURNING provider`).bind(account.id, provider, account.id, account.version, account.id, provider).first();
  return removed ? readAccount(db, account.id) : null;
}

export async function createLinkIntent(db: D1Database, intent: Omit<LinkIntent, 'started' | 'candidate' | 'completion'>): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM auth_link_intents WHERE expires_at < ?').bind(Date.now()),
    db.prepare(`INSERT INTO auth_link_intents
      (id, account_id, account_version, provider, chat, redirect_url, expires_at, session_format) VALUES (?, ?, ?, ?, ?, ?, ?, 2)`)
      .bind(intent.id, intent.account_id, intent.account_version, intent.provider, intent.chat, intent.redirect_url, intent.expires_at),
  ]);
}

export async function startLinkIntent(db: D1Database, id: string): Promise<LinkIntent | null> {
  return db.prepare(`UPDATE auth_link_intents SET started = 1
    WHERE id = ? AND session_format = 2 AND started = 0 AND expires_at > ? RETURNING *`).bind(id, Date.now()).first<LinkIntent>();
}

export async function finishLinkOAuth(db: D1Database, id: string, candidate: string, completion: string): Promise<boolean> {
  const row = await db.prepare(`UPDATE auth_link_intents SET candidate = ?, completion = ?
    WHERE id = ? AND session_format = 2 AND started = 1 AND candidate IS NULL AND expires_at > ? RETURNING id`)
    .bind(candidate, completion, id, Date.now()).first();
  return !!row;
}

export async function consumeLinkIntent(db: D1Database, completion: string, account: Account): Promise<LinkIntent | null> {
  return db.prepare(`DELETE FROM auth_link_intents WHERE completion = ? AND account_id = ?
    AND account_version = ? AND session_format = 2 AND expires_at > ? RETURNING *`)
    .bind(completion, account.id, account.version, Date.now()).first<LinkIntent>();
}

export async function reviewLinkIntent(db: D1Database, completion: string, account: Account): Promise<LinkIntent | null> {
  return db.prepare(`SELECT * FROM auth_link_intents WHERE completion=? AND account_id=?
    AND account_version=? AND session_format=2 AND expires_at>? AND candidate IS NOT NULL`)
    .bind(completion, account.id, account.version, Date.now()).first<LinkIntent>();
}
