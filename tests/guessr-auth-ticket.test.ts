import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { build } from "esbuild";
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signGameTicket as gameSigner, verifyGameTicket } from "../workers/noitamap-guessr/src/tickets";
import { signGameTicket as authSigner } from '../workers/noitamap-auth/src/game-ticket';
let worker: { fetch(request: Request, env: unknown): Promise<Response> };
let standalone: string;
const loginKey = "local-auth-test-key-not-used-in-production",
  gameKey = "separate-game-test-key-not-used-in-production";
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
    b64({ alg: "HS256", typ: "JWT" }) +
    "." +
    b64({
      typ: "access",
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
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(loginKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
) {
  return worker.fetch(
    new Request("https://auth.test/auth/game-ticket", {
      method,
      headers: {
        Origin: "https://noitamap.com",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    }),
    {
      JWT_SECRET: { get: async () => loginKey },
      GAME_SIGNING_SECRET: key,
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
    const auth = await authSigner(sub, name, gameKey, identity ?? now, now);
    expect(auth).toEqual(await gameSigner(sub, name, gameKey, identity ?? now, now));
    expect(await verifyGameTicket(auth.token, gameKey, now)).toMatchObject({ sub, name: name.slice(0, 48), pro: true });
    expect(await verifyGameTicket(auth.token, loginKey, now)).toBeNull();
  });
  it("issues a game-only identity for a verified Pro session", async () => {
    const response = await call(await access(true));
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(await verifyGameTicket(data.token, gameKey)).toMatchObject({
      sub: "twitch:42",
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
