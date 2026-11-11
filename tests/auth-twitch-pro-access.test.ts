import { accountDatabase } from './helpers/auth-account-db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { verifyGameTicket } from "../workers/noitamap-guessr/src/tickets";

let worker: { fetch(request: Request, env: unknown): Promise<Response> };
const loginKey = "test-only-twitch-auth-signing-key-not-production";
const gameKey = "test-only-separate-game-signing-key-not-production";
const secret = (value: string) => ({ get: async () => value });
let accountDb: ReturnType<typeof accountDatabase>;
const env = {
  ACCOUNT_DB: undefined as ReturnType<typeof accountDatabase>['binding'] | undefined,
  CREDENTIAL_ENCRYPTION_SECRET: secret('local-only-provider-encryption-key-for-tests'),
  SESSION_SIGNING_SECRET: secret(loginKey),
  GAME_SIGNING_SECRET: gameKey,
  TWITCH_PRO_USER_IDS: '1001,1002',
  TWITCH_CLIENT_ID: secret("test-client"),
  TWITCH_CLIENT_SECRET: secret("test-client-secret"),
  ALLOWED_ORIGINS: "https://noitamap.test",
  WORKER_URL: "https://auth.test",
};
beforeEach(() => { accountDb = accountDatabase(); env.ACCOUNT_DB = accountDb.binding; vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { accountDb.sqlite.close(); vi.restoreAllMocks(); });
beforeAll(async () => {
  const result = await build({
    entryPoints: ["workers/noitamap-auth/src/index.ts"],
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
afterEach(() => vi.unstubAllGlobals());

function provider(login: string, displayName = login, id = '2001') {
  const identity = {
    id,
    login: login.toLowerCase(),
    display_name: displayName,
  };
  const fetch = vi.fn(
    async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.href === "https://id.twitch.tv/oauth2/token")
        return Response.json({
          access_token: "viewer-access",
          refresh_token: "viewer-refresh",
        });
      if (url.href === "https://api.twitch.tv/helix/users") {
        expect(new Headers(options?.headers).get("Authorization")).toBe(
          "Bearer viewer-access",
        );
        return Response.json({ data: [identity] });
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
  );
  vi.stubGlobal("fetch", fetch);
  return { identity, fetch };
}
async function login(bindings = env) {
  const start = await worker.fetch(
    new Request(
      "https://auth.test/auth/twitch/login?redirect=https://noitamap.test/guess/?auth_nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    bindings,
  );
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location")!).searchParams.get(
    "state",
  )!;
  const callback = new URL("https://auth.test/auth/twitch/callback");
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", state);
  // Arbitrary client-supplied names must never grant access.
  callback.searchParams.set("username", "wuote");
  const response = await worker.fetch(
    new Request(callback, {
      headers: { Cookie: start.headers.get("Set-Cookie")!.split(";")[0] },
    }),
    bindings,
  );
  expect(response.status).toBe(302);
  const fragment = new URLSearchParams(
    new URL(response.headers.get("Location")!).hash.slice(1),
  );
  expect(fragment.get("auth")).toBe("success");
  return {
    token: fragment.get("token")!,
    refresh: fragment.get("refresh_token")!,
  };
}
async function request(path: string, token: string, method = "GET") {
  return worker.fetch(
    new Request("https://auth.test" + path, {
      method,
      headers: {
        Origin: "https://noitamap.test",
        Authorization: "Bearer " + token,
      },
    }),
    env,
  );
}

describe("owner-approved Twitch Pro access", () => {
  it.each(["wuote", "dunkorslam", "Wuote", "DunkOrSlam"])(
    "grants %s Pro on verified login, game-ticket issuance and silent refresh without broadcaster setup",
    async (name) => {
      const { fetch } = provider(name, 'Display name is not the entitlement', name.toLowerCase() === 'wuote' ? '1001' : '1002');
      const session = await login();
      expect(
        await (await request("/auth/check", session.token)).json(),
      ).toMatchObject({
        authenticated: true,
        provider: "twitch",
        isSubscriber: true,
      });
      const ticketResponse = await request(
        "/auth/game-ticket",
        session.token,
        "POST",
      );
      expect(ticketResponse.status).toBe(200);
      const ticket = (await ticketResponse.json()) as { token: string };
      expect(await verifyGameTicket(ticket.token, gameKey)).toMatchObject({
        sub: expect.stringMatching(/^account:/),
        pro: true,
      });
      const renewed = (await (
        await request("/auth/refresh", session.refresh, "POST")
      ).json()) as any;
      expect(renewed).toMatchObject({
        authenticated: true,
        isSubscriber: true,
        provider: "twitch",
      });
      expect(
        await (await request("/auth/check", renewed.token)).json(),
      ).toMatchObject({ isSubscriber: true });
      expect(
        fetch.mock.calls.every(
          ([url]) => !String(url).includes("subscriptions"),
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["ordinary-viewer", "wuote"],
    ["ordinary-viewer", "dunkorslam"],
    ["dunkorslam_other", "dunkorslam"],
  ])(
    "does not grant Pro to %s using display name %s or a supplied username",
    async (name, display) => {
      provider(name, display);
      const session = await login();
      expect(
        await (await request("/auth/check", session.token)).json(),
      ).toMatchObject({ isSubscriber: false });
      expect(
        (await request("/auth/game-ticket", session.token, "POST")).status,
      ).toBe(403);
      expect(
        await (await request("/auth/refresh", session.refresh, "POST")).json(),
      ).toMatchObject({ isSubscriber: false });
    },
  );

  it('keeps an explicit grant through rename but rejects reuse of that name by a different ID', async () => {
    const { identity } = provider('dunkorslam', 'DunkOrSlam', '1002');
    const session = await login(); identity.login = 'renamed-viewer';
    accountDb.sqlite.prepare('UPDATE auth_identities SET checked_at=?').run(Date.now() - 7200000);
    const renewed = await (await request('/auth/refresh', session.refresh, 'POST')).json() as any;
    expect(renewed).toMatchObject({ isSubscriber: true });
    identity.id = '99999'; identity.login = 'dunkorslam';
    accountDb.sqlite.prepare('UPDATE auth_identities SET checked_at=?').run(Date.now() - 7200000);
    expect(await (await request('/auth/refresh', renewed.refresh_token, 'POST')).json()).toMatchObject({ isSubscriber: false });
    const newcomer = await login();
    expect(await (await request('/auth/check', newcomer.token)).json()).toMatchObject({ isSubscriber: false });
  });

  it("retains the existing creator-ID grant for a renamed broadcaster", async () => {
    provider("renamed-creator");
    const session = await login({
      ...env,
      TWITCH_BROADCASTER_ID: secret("2001"),
    } as typeof env);
    expect(
      await (await request("/auth/check", session.token)).json(),
    ).toMatchObject({ isSubscriber: true });
  });
});
