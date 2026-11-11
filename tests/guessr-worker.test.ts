import { testGameKeys } from './helpers/game-ticket-keys';
import { describe, it, expect, vi, afterEach } from "vitest";
import { handle, type Env } from "../workers/noitamap-guessr/src/index";
import {
  signGameTicket,
  verifyGameTicket,
} from "./helpers/game-ticket-keys";
import { gameDatabase } from "./helpers/guessr-database";
const secret = "local-test-only-game-signing-key-0123456789",
  now = Date.UTC(2026, 9, 12, 12),
  origin = "https://noitamap.com";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
async function fixture() {
  const database = gameDatabase();
  cleanup.push(database.close);
  database.sqlite
    .prepare("INSERT INTO challenges(id,day,title,opens_at,closes_at,reveal_at,bounds_json,round_seconds,enabled) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      "daily-test",
      "2026-10-12",
      "A daily",
      now - 3600000,
      now + 3600000,
      now + 3600000,
      JSON.stringify({ x: -1000, y: -1000, width: 2000, height: 2000 }),
      90,
      1,
    );
  for (let i = 0; i < 10; i++)
    database.sqlite
      .prepare("INSERT INTO questions(challenge_id,ordinal,asset_key,name,biome,x,y,seed) VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "daily-test",
        i,
        "a".repeat(64) + ".webp",
        "Private answer " + i,
        "Secret biome",
        i * 50,
        i * 100,
        123,
      );
  const env: Env = {
    DB: database.db,
    ASSETS: {
      fetch: vi.fn(
        async () =>
          new Response("image", { headers: { "Content-Type": "image/webp" } }),
      ),
    },
    GAME_SIGNING_SECRET: secret, GAME_TICKET_PUBLIC_KEY: (await testGameKeys(secret)).publicKey,
    ALLOWED_ORIGINS: origin,
    GAME_ENABLED: "true",
  };
  const ticket = await signGameTicket("twitch:one", "Explorer", secret, now);
  async function call(
    path: string,
    body?: unknown,
    at = now,
    token: string | null = ticket.token,
  ) {
    return handle(
      new Request("https://guessr-api.sage-data.xyz" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      at,
    );
  }
  const start = async () => {
    const r = await call("/api/attempts", { challengeId: "daily-test" });
    expect(r.status).toBe(200);
    return r.json() as Promise<any>;
  };
  return { ...database, env, call, start, ticket };
}
describe('public Daily results', () => {
  it('serves an explicit score allowlist without auth, question reads, rate writes or account changes', async () => {
    const f = await fixture(), a = await f.start();
    for (let round = 0; round < 10; round++) await f.call(`/api/attempts/${a.id}/guess`, {
      round, guess: round === 9 ? null : { x: round * 50, y: round * 100 }, requestId: `public-score-request-${round}`,
    });
    const changes = f.sqlite.prepare('SELECT total_changes() AS n').get();
    const prepare = vi.spyOn(f.db, 'prepare');
    const response = await f.call(`/api/daily/results/${a.id}`, undefined, now, null);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    const result: any = await response.json();
    expect(Object.keys(result).sort()).toEqual(['id', 'day', 'status', 'totalRounds', 'score', 'results'].sort());
    expect(result).toMatchObject({ id: a.id, day: '2026-10-12', status: 'complete', totalRounds: 10, score: 45000 });
    expect(result.results).toHaveLength(10);
    expect(result.results[0]).toEqual({ ordinal: 0, guess: { score: 5000, area_score: null, position_score: null } });
    expect(result.results[9].guess.score).toBe(0);
    expect(prepare.mock.calls).toHaveLength(2);
    expect(prepare.mock.calls.map(([sql]) => sql).join(' ')).not.toMatch(/questions|usage_limits|user_id|display_name/);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(JSON.stringify(result)).not.toMatch(/answer|seed|biome|clue|image|request_id|twitch|Explorer|Private/);
  });
  it('reveals only completed attempts, supports public legacy images and preserves private play guards', async () => {
    const f = await fixture(), a = await f.start(), base = `/api/daily/results/${a.id}`;
    for (const suffix of ['', '/answers', '/image/0'])
      expect((await f.call(base + suffix, undefined, now, null)).status).toBe(409);
    expect((await f.call('/api/daily/results/missing', undefined, now, null)).status).toBe(404);
    expect((await f.call(base, {}, now, null)).status).toBe(405);
    await f.call(`/api/attempts/${a.id}/quit`, {});
    const writes = f.sqlite.prepare('SELECT total_changes() AS n').get();
    const summary: any = await (await f.call(base, undefined, now, null)).json();
    expect(summary.results.every((r: any) => r.guess === null)).toBe(true);
    const answers = await f.call(base + '/answers', undefined, now, null);
    expect(answers.status).toBe(200);
    const result: any = await answers.json();
    expect(result.results).toHaveLength(10);
    expect(result.results[0]).toMatchObject({ answer: { x: 0, y: 0 }, image: base + '/image/0', name: 'Private answer 0' });
    const image = await f.call(base + '/image/0', undefined, now, null);
    expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/webp');
    expect(await image.text()).toBe('image');
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
    expect((await f.call(`/api/attempts/${a.id}`, undefined, now, null)).status).toBe(401);
    expect((await f.call('/api/attempts', { challengeId: 'daily-test' }, now, null)).status).toBe(401);
    expect((await f.call(`/api/attempts/${a.id}/guess`, {}, now, null)).status).toBe(401);
    // Disabling new games must not disable saved result viewing.
    f.env.GAME_ENABLED = 'false';
    expect((await f.call(base, undefined, now, null)).status).toBe(200);
  });
});
describe("ranked game authority", () => {
  it('includes the current puzzle difficulty while keeping its area and answer private', async () => {
    const f = await fixture();
    f.sqlite.prepare('UPDATE challenges SET image_config_json=? WHERE id=?')
      .run(JSON.stringify({ version: 'prepared-test' }), 'daily-test');
    f.sqlite.prepare('UPDATE questions SET clue_json=?, area_json=? WHERE challenge_id=?')
      .run(JSON.stringify({ frames: [{ image: '/opaque.webp', x: -10, y: -10, width: 20, height: 20 }] }),
        JSON.stringify({ id: 'private-area-id', label: 'Private area label', difficultyTier: 'hard', runs: [[99, 12, 14]] }), 'daily-test');
    const state = await f.start();
    expect(state.difficultyTier).toBe('hard');
    expect(state.results).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('private-area-id');
    expect(JSON.stringify(state)).not.toContain('Private area label');
    expect(state).not.toHaveProperty('answer');
    expect(state).not.toHaveProperty('runs');
  });
  it("requires a valid Pro game ticket before any database work", async () => {
    const f = await fixture();
    expect((await f.call("/api/daily", undefined, now, null)).status).toBe(401);
    expect(f.calls()).toBe(0);
    expect((await f.call("/api/daily", undefined, now, "fake")).status).toBe(
      401,
    );
    expect(f.calls()).toBe(0);
    const r = await f.call("/api/daily");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ challenge: { id: "daily-test" } });
  });
  it("rejects expired, wrong-key, tampered and wrong-purpose tickets", async () => {
    const signed = await signGameTicket("patreon:42", "P", secret, now);
    expect(await verifyGameTicket(signed.token, secret, now)).toMatchObject({
      sub: "patreon:42",
    });
    expect(
      await verifyGameTicket(signed.token, secret, now + 1200001),
    ).toBeNull();
    expect(
      await verifyGameTicket(signed.token, secret + "wrong", now),
    ).toBeNull();
    const parts = signed.token.split(".");
    parts[1] = btoa(
      JSON.stringify({ sub: "patreon:42", pro: true, aud: "other" }),
    ).replace(/=+$/, "");
    expect(await verifyGameTicket(parts.join("."), secret, now)).toBeNull();
  });
  it("creates only one attempt even with concurrent starts", async () => {
    const f = await fixture(),
      [a, b] = await Promise.all([f.start(), f.start()]);
    expect(a.id).toBe(b.id);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM attempts").get(),
    ).toMatchObject({ n: 1 });
    expect(await (await f.call('/api/daily')).json()).toMatchObject({ attemptId: a.id, attemptStatus: 'active' });
  });
  it('refuses a completed Daily restart while keeping its result available', async () => {
    const f = await fixture(), a = await f.start();
    for (let round = 0; round < 10; round++) {
      const response = await f.call(`/api/attempts/${a.id}/guess`, {
        round, guess: { x: round * 50, y: round * 100 }, requestId: `finished-daily-round-${round}`,
      });
      expect(response.status).toBe(200);
    }
    expect(await (await f.call('/api/daily')).json()).toMatchObject({ attemptId: a.id, attemptStatus: 'complete' });
    const restart = await f.call('/api/attempts', { challengeId: 'daily-test' });
    expect(restart.status).toBe(409); expect(await restart.json()).toEqual({ error: 'You’ve already played this Daily.' });
    expect(await (await f.call(`/api/attempts/${a.id}`)).json()).toMatchObject({ id: a.id, status: 'complete', score: 50000 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toMatchObject({ n: 1 });
  });
  it("quits without discarding earned points or allowing the daily to restart", async () => {
    const f = await fixture(),
      a = await f.start();
    expect(
      (
        await f.call(`/api/attempts/${a.id}/guess`, {
          round: 0,
          guess: { x: 0, y: 0 },
          requestId: "request-before-quit",
        })
      ).status,
    ).toBe(200);
    const guesses = f.sqlite.prepare("SELECT * FROM guesses").all();
    const response = await f.call(
      `/api/attempts/${a.id}/quit`, {}, now + 1000,
    );
    expect(response.status).toBe(200);
    const completed = (await response.json()) as any;
    expect(completed).toMatchObject({
      id: a.id,
      round: 10,
      status: "complete",
      score: 5000,
      elapsedMs: 0,
      image: null,
      submitted: [0],
    });
    expect(completed.results).toHaveLength(10);
    expect(completed.results[0].guess).toMatchObject({ score: 5000 });
    expect(
      completed.results.slice(1).map((result: any) => result.guess),
    ).toEqual(Array(9).fill(null));
    const saved = f.sqlite.prepare("SELECT * FROM attempts").get();
    expect(saved).toMatchObject({ next_round: 10, completed_at: now + 1000 });
    expect(
      (await f.call(`/api/attempts/${a.id}/quit`, {}, now + 2000)).status,
    ).toBe(200);
    expect(f.sqlite.prepare("SELECT * FROM attempts").get()).toEqual(saved);
    expect(f.sqlite.prepare("SELECT * FROM guesses").all()).toEqual(guesses);
    const retry = await f.call('/api/attempts', { challengeId: 'daily-test' });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: 'You’ve already played this Daily.' });
    expect(await (await f.call(`/api/attempts/${a.id}`)).json()).toMatchObject({
      id: a.id,
      status: "complete",
      round: 10,
      score: 5000,
    });
    expect(
      (
        await f.call(`/api/attempts/${a.id}/guess`, {
          round: 1,
          guess: { x: 50, y: 100 },
          requestId: "request-after-quit",
        })
      ).status,
    ).toBe(409);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM attempts").get(),
    ).toMatchObject({ n: 1 });
  });
  it("allows concurrent quit retries before the first guess", async () => {
    const f = await fixture(),
      a = await f.start();
    const responses = await Promise.all([
      f.call(`/api/attempts/${a.id}/quit`, {}, now + 1000),
      f.call(`/api/attempts/${a.id}/quit`, {}, now + 2000),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: a.id,
        status: "complete",
        round: 10,
        score: 0,
        submitted: [],
        results: Array.from({ length: 10 }, () => ({ guess: null })),
      });
    }
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM guesses").get(),
    ).toMatchObject({ n: 0 });
  });
  it("requires the owning account to quit an attempt", async () => {
    const f = await fixture(),
      a = await f.start(),
      other = await signGameTicket("twitch:other", "Other", secret, now);
    const calls = f.calls();
    expect(
      (await f.call(`/api/attempts/${a.id}/quit`, {}, now, null)).status,
    ).toBe(401);
    expect(f.calls()).toBe(calls);
    expect(
      (await f.call(`/api/attempts/${a.id}/quit`, {}, now, other.token)).status,
    ).toBe(404);
    expect(
      f.sqlite.prepare("SELECT next_round,completed_at FROM attempts").get(),
    ).toMatchObject({ next_round: 0, completed_at: null });
  });
  it("reveals each submitted result immediately without revealing future answers", async () => {
    const f = await fixture(),
      a = await f.start();
    expect(a.results).toEqual([]);
    expect(a.score).toBe(0);
    const response = await f.call(
      `/api/attempts/${a.id}/guess`,
      { round: 0, guess: { x: 0, y: 0 }, requestId: "request-first-000000" },
      now + 1000,
    );
    const next = (await response.json()) as any;
    expect(next.round).toBe(1);
    expect(next.score).toBe(5000);
    expect(next.results).toHaveLength(1);
    expect(next.results[0].answer).toEqual({ x: 0, y: 0 });
    expect(JSON.stringify(next)).not.toContain("Private answer 1");
  });
  it("accepts a round once and makes an identical retry idempotent", async () => {
    const f = await fixture(),
      a = await f.start(),
      data = {
        round: 0,
        guess: { x: 0, y: 0 },
        requestId: "request-first-000000",
      };
    const [x, y] = await Promise.all([
      f.call(`/api/attempts/${a.id}/guess`, data, now + 1000),
      f.call(`/api/attempts/${a.id}/guess`, data, now + 1000),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(
      f.sqlite.prepare("SELECT next_round,score FROM attempts").get(),
    ).toMatchObject({ next_round: 1, score: 5000 });
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM guesses").get(),
    ).toMatchObject({ n: 1 });
    expect(
      (
        await f.call(`/api/attempts/${a.id}/guess`, {
          ...data,
          guess: { x: 50, y: 50 },
        })
      ).status,
    ).toBe(409);
  });
  it("rejects client-supplied scores, future rounds and out-of-bounds pins", async () => {
    const f = await fixture(),
      a = await f.start();
    for (const data of [
      { round: 0, guess: { x: 0, y: 0 }, score: 99999 },
      { round: 4, guess: { x: 0, y: 0 } },
      { round: 0, guess: { x: 99999, y: 0 } },
    ]) {
      expect(
        (
          await f.call(`/api/attempts/${a.id}/guess`, {
            requestId: "request-0000000000",
            ...data,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM guesses").get(),
    ).toMatchObject({ n: 0 });
  });
  it("prevents another user from reading attempts or fetching future/private assets", async () => {
    const f = await fixture(),
      a = await f.start(),
      other = await signGameTicket("twitch:other", "Other", secret, now);
    expect(
      (await f.call(`/api/attempts/${a.id}`, undefined, now, other.token))
        .status,
    ).toBe(404);
    expect((await f.call(`/api/attempts/${a.id}/image/1`)).status).toBe(403);
    expect((await f.call("/" + "a".repeat(64) + ".webp")).status).toBe(404);
    expect(f.env.ASSETS.fetch).not.toHaveBeenCalled();
    expect((await f.call(`/api/attempts/${a.id}/image/0`)).status).toBe(200);
  });
  it("has no guess timeout and allows an existing daily to continue after midnight", async () => {
    const f = await fixture(),
      a = await f.start(),
      later = now + 86400000;
    const token = (
      await signGameTicket("twitch:one", "Explorer", secret, later)
    ).token;
    const resumed = (await (
      await f.call(`/api/attempts/${a.id}`, undefined, later, token)
    ).json()) as any;
    expect(resumed.status).toBe("active");
    expect(resumed.deadline).toBeNull();
    const result = await f.call(
      `/api/attempts/${a.id}/guess`,
      { round: 0, guess: { x: 0, y: 0 }, requestId: "request-late-000000" },
      later,
      token,
    );
    expect(result.status).toBe(200);
    expect(f.sqlite.prepare("SELECT score,x FROM guesses").get()).toMatchObject(
      { score: 5000, x: 0 },
    );
    expect(
      await (
        await f.call("/api/daily?day=2026-10-12", undefined, later, token)
      ).json(),
    ).toMatchObject({ challenge: { id: "daily-test" }, attemptId: a.id });
    const quit = await f.call(`/api/attempts/${a.id}/quit`, {}, later, token);
    expect(quit.status).toBe(200);
    expect(await quit.json()).toMatchObject({
      status: "complete", score: 5000,
    });
  });
  it("shows completed results immediately and keeps prototype rankings free of account ids", async () => {
    const f = await fixture(),
      a = await f.start();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.call(
            `/api/attempts/${a.id}/guess`,
            {
              round: i,
              guess: { x: i * 50, y: i * 100 },
              requestId: `request-round-${i}-0000`,
            },
            now + (i + 1) * 1000,
          )
        ).status,
      ).toBe(200);
    expect(
      (await (await f.call(`/api/attempts/${a.id}`)).json()) as any,
    ).toHaveProperty("score", 50000);
    const completed = f.sqlite.prepare("SELECT * FROM attempts").get();
    const quit = await f.call(`/api/attempts/${a.id}/quit`, {}, now + 10000);
    expect(quit.status).toBe(200);
    expect(await quit.json()).toMatchObject({
      status: "complete",
      score: 50000,
      submitted: Array.from({ length: 10 }, (_, i) => i),
    });
    expect(f.sqlite.prepare("SELECT * FROM attempts").get()).toEqual(completed);
    expect(
      await (await f.call("/api/leaderboard?day=2026-10-12")).json(),
    ).toMatchObject({ pending: true, rows: [] });
    const later = now + 3600001,
      token = (await signGameTicket("twitch:one", "Explorer", secret, later))
        .token;
    const revealed = (await (
      await f.call(`/api/attempts/${a.id}`, undefined, later, token)
    ).json()) as any;
    expect(revealed.score).toBe(50000);
    expect(revealed.results[0].answer).toEqual({ x: 0, y: 0 });
    const board = (await (
      await f.call("/api/leaderboard?day=2026-10-12", undefined, later, token)
    ).json()) as any;
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({ name: "Explorer", score: 50000 });
    expect(JSON.stringify(board)).not.toContain("twitch:one");
  });
  it("rejects disallowed origins and limits repeated requests", async () => {
    const f = await fixture();
    const wrong = new Request("https://api.test/api/daily", {
      headers: {
        Origin: "https://evil.test",
        Authorization: "Bearer " + f.ticket.token,
      },
    });
    expect((await handle(wrong, f.env, now)).status).toBe(403);
    expect(f.calls()).toBe(0);
    for (let i = 0; i < 30; i++)
      expect((await f.call("/api/daily")).status).toBe(200);
    const limited = await f.call("/api/daily");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });
  it("keeps the unpublished service disabled by default", async () => {
    const f = await fixture();
    f.env.GAME_ENABLED = "false";
    expect((await f.call("/api/daily")).status).toBe(503);
    expect(f.calls()).toBe(0);
  });
  it("enforces the shared daily budget independently of individual limits", async () => {
    const f = await fixture();
    f.env.DAILY_REQUEST_BUDGET = "100";
    f.sqlite
      .prepare("INSERT INTO usage_limits VALUES(?,?,?)")
      .run("all:2026-10-12", 100, now + 86400000);
    const r = await f.call("/api/daily");
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({
      error: expect.stringContaining("resting for today"),
    });
    expect(
      f.sqlite
        .prepare("SELECT count FROM usage_limits WHERE key=?")
        .get("all:2026-10-12"),
    ).toMatchObject({ count: 100 });
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_limits").get(),
    ).toMatchObject({ n: 1 });
  });
  it("rejects oversized requests and impossible leaderboard dates", async () => {
    const f = await fixture();
    expect(
      (await f.call("/api/attempts", { challengeId: "x".repeat(2200) })).status,
    ).toBe(413);
    expect((await f.call("/api/leaderboard?day=2026-02-31")).status).toBe(400);
  });
});
