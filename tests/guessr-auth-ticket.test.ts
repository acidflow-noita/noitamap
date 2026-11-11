import { testGameKeys } from './helpers/game-ticket-keys';
import { accountDatabase } from './helpers/auth-account-db';
import { authKey } from '../workers/noitamap-auth/src/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { build } from "esbuild";
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyGameTicket, verifyResultManagementTicket } from "../workers/noitamap-guessr/src/tickets";
import { signGameTicket as authSigner } from '../workers/noitamap-auth/src/game-ticket';
let worker: { fetch(request: Request, env: unknown): Promise<Response> };
let standalone: string;
const loginKey = "local-auth-test-key-not-used-in-production",
  gameKey = "separate-game-test-key-not-used-in-production";
let db: ReturnType<typeof accountDatabase>;
const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  db = accountDatabase();
  const now = Date.now();
  db.sqlite.prepare('INSERT INTO auth_accounts(id) VALUES(?)').run(accountId);
  db.sqlite.prepare('INSERT INTO auth_identities(provider,provider_user_id,account_id,username,nickname,login,is_follower,is_subscriber,checked_at,status,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('twitch','42',accountId,'Explorer',null,'explorer',1,1,now,'active','unused');
  db.sqlite.prepare('INSERT INTO auth_sessions(id,account_id,account_version,created_at,refreshed_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(sessionId,accountId,1,now,now,now+86400000);
});
afterEach(() => db.sqlite.close());
beforeAll(async () => {
  // Match copying only the auth folder: a sibling Guessr checkout cannot mask
  // an undeclared build dependency in this test.
  standalone = await mkdtemp(join(tmpdir(), 'noitamap-auth-isolated-test-'));
  await cp('workers/noitamap-auth/src', join(standalone, 'src'), { recursive: true });
  const result = await build({
    entryPoints: [join(standalone, 'src/index.ts')],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "TestAuthWorker",
    platform: "neutral",
    target: "es2022",
  });
  worker = new Function(
    result.outputFiles[0].text + "\nreturn TestAuthWorker.default;",
  )();
});
afterAll(async () => { if (standalone) await rm(standalone, { recursive: true, force: true }); });
async function access(
  subscriber: boolean,
  extra: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000),
    enc = new TextEncoder();
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data =
    b64({ alg: "HS256", typ: "JWT", kid: "auth-v2" }) +
    "." +
    b64({
      typ: "access", v: 2, aud: "noitamap-auth", sid: sessionId, account_id: accountId, account_version: 1,
      sub: "42",
      username: "Explorer",
      nickname: null,
      is_follower: true,
      is_subscriber: subscriber,
      provider: "twitch",
      iat: now,
      exp: now + 600,
      ...extra,
    });
  db.sqlite.prepare('UPDATE auth_identities SET is_subscriber=?').run(Number(subscriber));
  const key = await authKey(loginKey, 'access');
  return (
    data +
    "." +
    Buffer.from(
      await crypto.subtle.sign("HMAC", key, enc.encode(data)),
    ).toString("base64url")
  );
}
async function call(
  token: string | null,
  key: string | undefined = gameKey,
  method = "POST",
  path = "/auth/game-ticket",
) {
  return worker.fetch(
    new Request("https://auth.test" + path, {
      method,
      headers: {
        Origin: "https://noitamap.com",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    }),
    {
      SESSION_SIGNING_SECRET: { get: async () => loginKey },
      CREDENTIAL_ENCRYPTION_SECRET: { get: async () => 'local-only-provider-encryption-key-for-tests' },
      ACCOUNT_DB: db.binding,
      GAME_TICKET_PRIVATE_KEY: key ? (await testGameKeys(key)).privateKey : key,
      ALLOWED_ORIGINS: "https://noitamap.com",
      WORKER_URL: "https://auth.test",
    },
  );
}
describe("separate game-ticket issuer", () => {
  it.each([
    ['patreon:42', 'Patron', undefined],
    ['account:linked', '配信者', { twitchUserId: '12345', twitchLogin: 'mychannel' }],
    ['twitch:12345', 'A'.repeat(60), { twitchUserId: '12345', twitchLogin: 'mychannel' }],
  ] as const)('keeps standalone signing compatible for %s', async (sub, name, identity) => {
    const now = Date.UTC(2026, 10, 10, 12);
    const auth = await authSigner(sub, name, (await testGameKeys(gameKey)).privateKey, identity ?? now, now);
    expect(JSON.parse(Buffer.from(auth.token.split('.')[0], 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'game-v2' });
    expect(await verifyGameTicket(auth.token, (await testGameKeys(gameKey)).publicKey, now)).toMatchObject({ sub, name: name.slice(0, 48), pro: true });
    expect(await verifyGameTicket(auth.token, loginKey, now)).toBeNull();
  });
  it("issues a game-only identity for a verified Pro session", async () => {
    const response = await call(await access(true));
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(await verifyGameTicket(data.token, (await testGameKeys(gameKey)).publicKey)).toMatchObject({
      sub: `account:${accountId}`,
      pro: true,
      aud: "noitamap-guessr",
      typ: "game",
    });
    expect(await verifyGameTicket(data.token, loginKey)).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("rejects guests, non-Pro members, refresh tokens and expired sessions", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call(await access(false))).status).toBe(403);
    expect((await call(await access(true, { typ: "refresh" }))).status).toBe(
      401,
    );
    expect((await call(await access(true, { exp: 1 }))).status).toBe(401);
  });
  it("requires POST and fails closed when the optional game key is not configured", async () => {
    expect((await call(await access(true), gameKey, "GET")).status).toBe(405);
    expect((await call(await access(true), "")).status).toBe(503);
  });
});


it('issues a separate management ticket without Pro and cannot use it for gameplay', async () => {
  const response = await call(await access(false), gameKey, 'POST', '/auth/result-ticket');
  expect(response.status).toBe(200);
  const data = await response.json() as { token: string }, keys = await testGameKeys(gameKey);
  expect(await verifyResultManagementTicket(data.token, keys.publicKey)).toMatchObject({ sub: `account:${accountId}`, pro: false, typ: 'result-management' });
  expect(await verifyGameTicket(data.token, keys.publicKey)).toBeNull();
  expect(await verifyResultManagementTicket(data.token, keys.privateKey)).toBeNull();
});
it('does not let the public verification key sign tickets', async () => {
  const keys = await testGameKeys(gameKey);
  await expect(authSigner('account:test', 'Player', keys.publicKey)).rejects.toThrow('signing key');
  const ticket = await authSigner('account:test', 'Player', keys.privateKey);
  expect(await verifyGameTicket(ticket.token, keys.privateKey)).toBeNull();
});
