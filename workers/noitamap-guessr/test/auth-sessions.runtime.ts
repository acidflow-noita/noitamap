import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import accounts from '../../noitamap-auth/migrations/0001_linked_accounts.sql?raw';
import sessions from '../../noitamap-auth/migrations/0002_sessions.sql?raw';
import { saveIdentity } from '../../noitamap-auth/src/accounts';
import { createLoginSession, readSessionAccount, rotateRefresh, revokeLoginSession } from '../../noitamap-auth/src/sessions';
afterEach(() => reset());
it('enforces auth session rotation, expiry and revocation with actual D1 statements', async () => {
  for (const schema of [accounts, sessions]) {
    const statements = schema.replace(/^\s*--.*$/gm, '').trim().split(/;\s*(?=(?:CREATE|ALTER|DROP|PRAGMA)\b|$)/).filter(s => s.trim());
    for (const sql of statements) await env.DB.prepare(sql).run();
  }
  const now = Date.now();
  const account = await saveIdentity(env.DB, { provider: 'twitch', provider_user_id: '100', username: 'User',
    nickname: null, login: 'user', is_follower: 0, is_subscriber: 1, checked_at: now, status: 'active', credentials: '' });
  const session = await createLoginSession(env.DB, account, now);
  const claims = { sid: session.id, account_id: account.id, account_version: account.version };
  const outcomes = await Promise.all([rotateRefresh(env.DB, session, 0, now + 1), rotateRefresh(env.DB, session, 0, now + 1)]);
  expect(outcomes.sort()).toEqual(['ok', 'retry']);
  expect((await readSessionAccount(env.DB, claims, now + 2))?.session.refresh_version).toBe(1);
  expect(await readSessionAccount(env.DB, claims, session.expires_at)).toBeNull();
  await revokeLoginSession(env.DB, session.id, account.id, now + 3);
  expect(await readSessionAccount(env.DB, claims, now + 4)).toBeNull();
});
