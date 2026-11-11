import { afterEach, beforeEach, expect, it } from 'vitest';
import { accountDatabase } from './helpers/auth-account-db';
import { readAccount, saveIdentity } from '../workers/noitamap-auth/src/accounts';
import { createLoginSession, readSessionAccount, revokeLoginSession, rotateRefresh } from '../workers/noitamap-auth/src/sessions';
import { authKey, encryptCredential, decryptCredential } from '../workers/noitamap-auth/src/crypto';

let database: ReturnType<typeof accountDatabase>;
beforeEach(() => { database = accountDatabase(); });
afterEach(() => database.sqlite.close());
const key = 'test-only-session-purpose-key-with-sufficient-length';
const credentialKeys = { key: 'test-only-provider-encryption-key-independent-of-session', id: 'current' };
const now = Date.UTC(2026, 10, 11);
async function fixture() {
  const db = database.binding as unknown as Parameters<typeof createLoginSession>[0];
  const account = await saveIdentity(db, { provider: 'twitch', provider_user_id: '123', username: 'Viewer',
    nickname: null, login: 'viewer', is_follower: 0, is_subscriber: 1, checked_at: now, status: 'active', credentials: 'unused' });
  const session = await createLoginSession(db, account, now);
  const claims = { sid: session.id, account_id: account.id, account_version: account.version };
  return { db, account, session, claims };
}
it('rotates once, rejects a simultaneous duplicate without issuing a token, and revokes on later reuse', async () => {
  const f = await fixture();
  expect(await rotateRefresh(f.db, f.session, 0, now + 1)).toBe('ok');
  const current = (await readSessionAccount(f.db, f.claims, now + 1))!;
  expect(current.session.refresh_version).toBe(1);
  expect(await rotateRefresh(f.db, current.session, 0, now + 2)).toBe('retry');
  expect(await readSessionAccount(f.db, f.claims, now + 3)).not.toBeNull();
  expect(await rotateRefresh(f.db, current.session, 0, now + 10002)).toBe('revoked');
  expect(await readSessionAccount(f.db, f.claims, now + 10003)).toBeNull();
});
it('keeps concurrent rotation atomic and the absolute lifetime fixed', async () => {
  const f = await fixture();
  const results = await Promise.all([rotateRefresh(f.db, f.session, 0, now + 1), rotateRefresh(f.db, f.session, 0, now + 1)]);
  expect(results.sort()).toEqual(['ok', 'retry']);
  const current = (await readSessionAccount(f.db, f.claims, now + 2))!;
  expect(current.session.expires_at).toBe(now + 90 * 86400000);
  expect(await readSessionAccount(f.db, f.claims, now + 90 * 86400000)).toBeNull();
});
it('revokes only the logged-out session and rejects sessions invalidated by linking', async () => {
  const f = await fixture();
  const other = await createLoginSession(f.db, f.account, now);
  await revokeLoginSession(f.db, f.session.id, f.account.id, now + 1);
  expect(await readSessionAccount(f.db, f.claims, now + 2)).toBeNull();
  expect(await readSessionAccount(f.db, { ...f.claims, sid: other.id }, now + 2)).not.toBeNull();
  database.sqlite.prepare('UPDATE auth_accounts SET version=version+1 WHERE id=?').run(f.account.id);
  expect(await readSessionAccount(f.db, { ...f.claims, sid: other.id }, now + 3)).toBeNull();
});
it('uses distinct access, refresh and OAuth state signing keys', async () => {
  const value = new TextEncoder().encode('same payload');
  const signatures = await Promise.all((['access','refresh','oauth-state'] as const).map(async purpose => {
    const signing = await authKey(key, purpose); return crypto.subtle.sign('HMAC', signing, value);
  }));
  expect(new Set(signatures.map(value => Buffer.from(value).toString('hex'))).size).toBe(3);
  expect(await crypto.subtle.verify('HMAC', await authKey(key, 'refresh'), signatures[0], value)).toBe(false);
});
it('versions provider encryption separately and authenticates key IDs and ciphertext', async () => {
  const encrypted = await encryptCredential('provider-refresh-secret', credentialKeys);
  expect(encrypted).toMatch(/^c2\.current\./); expect(encrypted).not.toContain('provider-refresh-secret');
  expect(await decryptCredential(encrypted, credentialKeys)).toBe('provider-refresh-secret');
  expect(await decryptCredential(encrypted, { ...credentialKeys, key })).toBeNull();
  const rotated = { key: 'test-only-new-provider-encryption-key-after-rotation', id: 'next', previousId: 'current', previousKey: credentialKeys.key };
  expect(await decryptCredential(encrypted, rotated)).toBe('provider-refresh-secret');
  expect(await decryptCredential(encrypted.replace('c2.current.', 'c2.next.'), rotated)).toBeNull();
});
