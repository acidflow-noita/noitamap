import { packStreamPublish } from "../src/guessr/stream-codec";
import { liveRoomGame } from "../src/guessr/live-room-game";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { streamRoute } from "../workers/noitamap-guessr/src/streams";
import { STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES } from '../workers/noitamap-guessr/src/result-storage';
import { handle, type Env } from "../workers/noitamap-guessr/src/index";
import { signGameTicket } from "../workers/noitamap-guessr/src/tickets";
import {
  newStreamGame,
  streamResult,
  closeStreamRound,
  revealStreamRound,
  advanceStreamRound,
} from "../src/guessr/stream-state";
import {
  STREAM_MAX_DOCUMENT_BYTES,
  STREAM_MAX_PLAYERS,
  type StreamSession,
} from "../src/guessr/stream-types";
import { gameDatabase } from "./helpers/guessr-database";
import {
  streamAnswer,
  streamHost,
  streamNow,
  streamSecret,
  streamSource,
  memoryLiveRooms,
} from "./helpers/guessr-stream";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
async function fixture() {
  const db = gameDatabase();
  cleanups.push(db.close);
  db.sqlite.exec(
    readFileSync(
      "workers/noitamap-guessr/migrations/0002_stream_results.sql",
      "utf8",
    ),
  );
  db.sqlite.exec(readFileSync("workers/noitamap-guessr/migrations/0005_stream_history.sql", "utf8"));
  db.sqlite.exec(readFileSync("workers/noitamap-guessr/migrations/0006_stream_storage.sql", "utf8"));
  const ticket = await signGameTicket(
    streamHost.sub,
    streamHost.name,
    streamSecret,
    streamHost,
    streamNow,
  );
  const env: Env = {
    DB: db.db,
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    GAME_SIGNING_SECRET: streamSecret,
    STREAM_SIGNING_SECRET: streamSecret,
    STREAM_ENABLED: "true",
    LIVE_ROOMS: memoryLiveRooms(streamNow + 1000),
    STREAM_IMAGE_ROOT: "/images",
    GAME_ENABLED: "false",
    ALLOWED_ORIGINS: "https://dynamic-map.noitamap.com",
  };
  const request = (
    path: string,
    body?: unknown,
    token: string | null = ticket.token,
  ) =>
    new Request("https://api.test/api/streams" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: "https://dynamic-map.noitamap.com",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = (
    path: string,
    body?: unknown,
    token: string | null = ticket.token,
  ) =>
    streamRoute(
      request(path, body, token),
      env,
      streamNow + 1000,
      streamSource(),
    );
  async function completed() {
    const session = (await (
      await call("/sessions", {})
    ).json()) as StreamSession;
    const game = newStreamGame(session, streamNow + 1000);
    for (let i = 0; i < session.rounds.length; i++) {
      closeStreamRound(game, streamAnswer, streamNow + 1000);
      revealStreamRound(
        game,
        await (
          await call("/reveal", { token: session.rounds[i].token })
        ).json(),
      );
      expect((await call("/advance", { gameId: session.id, roundId: session.rounds[i].id })).status).toBe(200);
      advanceStreamRound(game, streamNow + 1000);
    }
    return packStreamPublish({
      token: session.token,
      finishedAt: game.finishedAt!,
      players: streamResult(game).players,
    });
  }
  return { ...db, env, call, request, completed };
}
describe("single-document stream publication", () => {
  it('runs a Twitch game with no live object or per-round database work, then writes one final result', async () => {
    const f = await fixture(); f.env.LIVE_ROOMS = undefined;
    const start = await f.call('/sessions', { transport: 'twitch' });
    expect(start.status).toBe(201);
    const session = await start.json() as StreamSession;
    expect(session.transport).toBe('twitch');
    const game = newStreamGame(session, streamNow + 1000);
    for (let round = 0; round < 10; round++) {
      closeStreamRound(game, streamAnswer, streamNow + 1000);
      const response = await f.call('/reveal', { token: session.rounds[round].token });
      expect(response.status).toBe(200);
      revealStreamRound(game, await response.json());
      advanceStreamRound(game, streamNow + 1000);
    }
    expect(f.calls()).toBe(0);
    game.participants.push({ id: '888', login: 'viewer', name: 'Viewer', color: '#FF4500', guesses: [...game.participants[0].guesses] });
    const published = await f.call('/results', packStreamPublish({ token: session.token,
      finishedAt: game.finishedAt!, players: streamResult(game).players }));
    expect(published.status).toBe(201);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS total FROM stream_results').get()!.total).toBe(1);
    const stored = await (await f.call('/results/' + session.id, undefined, null)).json() as any;
    expect(stored.players.find((p: { id: string }) => p.id === '888').color).toBe('#FF4500');
    expect((await f.call('/reveal', { token: session.rounds[0].token }, null)).status).toBe(401);
  });
  it('quits the authenticated current game idempotently without an answer or result write', async () => {
    const f = await fixture();
    const session = await (await f.call('/sessions', {})).json() as StreamSession;
    expect((await f.call('/quit', { gameId: session.id }, null)).status).toBe(401);
    const other = await signGameTicket('account:other', 'Other', streamSecret, streamHost, streamNow);
    expect((await f.call('/quit', { gameId: session.id }, other.token)).status).toBe(403);
    const response = await f.call('/quit', { gameId: session.id });
    expect(response.status).toBe(200);
    const closed = await response.json() as any;
    expect(closed).toMatchObject({ phase: 'waiting', gameId: null, clue: null });
    expect(JSON.stringify(closed)).not.toContain('answer');
    expect(await (await f.call('/quit', { gameId: session.id })).json()).toEqual(closed);
    expect((await f.call('/pulse', { gameId: session.id })).status).toBe(410);
    expect((await f.call('/advance', { gameId: session.id, roundId: session.rounds[0].id })).status).toBe(410);
    expect((await f.call('/reveal', { token: session.rounds[0].token })).status).toBe(410);
    expect(f.calls()).toBe(0);
  });

  it('takes host Pro expiry only from the verified ticket and refreshes through the existing pulse', async () => {
    const f = await fixture();
    const session = await (await f.call('/sessions', { hostProVerifiedUntil: streamNow + 86_400_000 })).json() as StreamSession;
    expect(session.hostProVerifiedUntil).toBe(streamNow + 1_200_000);
    expect(liveRoomGame({ ...session, localChat: true }, '/images').hostProVerifiedUntil).toBeUndefined();
    const initial = await (await f.call('/pulse', { gameId: session.id, hostProVerifiedUntil: streamNow + 86_400_000 })).json() as any;
    expect(initial).toMatchObject({ hostPro: 'active', hostProVerifiedUntil: session.hostProVerifiedUntil });
    const renewed = await signGameTicket(streamHost.sub, streamHost.name, streamSecret, streamHost, streamNow + 1000);
    const refreshed = await (await f.call('/pulse', { gameId: session.id }, renewed.token)).json() as any;
    expect(refreshed.hostProVerifiedUntil).toBe(renewed.expiresAt);
    expect(refreshed.revision).toBe(initial.revision + 1);
    const repeated = await (await f.call('/pulse', { gameId: session.id }, renewed.token)).json() as any;
    expect(repeated.revision).toBe(refreshed.revision);
    expect(f.calls()).toBe(0);
  });

  it("closes the live room before returning an answer and rejects future or stale round tokens", async () => {
    const f = await fixture();
    const session = await (await f.call('/sessions', {})).json() as StreamSession;
    expect(session.live).toBe(true);
    const initial = await (await f.call('/pulse', { gameId: session.id })).json();
    expect(JSON.stringify(initial)).not.toContain('answer');
    expect((await f.call('/reveal', { token: session.rounds[1].token })).status).toBe(409);
    const submissions = [{ player: { id: '101', login: 'chatter', name: 'Chatter' }, guess: streamAnswer, maximum: 2300 }];
    expect((await f.call('/reveal', { token: session.rounds[0].token, submissions: [...submissions, ...submissions] })).status).toBe(400);
    const response = await f.call('/reveal', { token: session.rounds[0].token, submissions });
    expect(response.status).toBe(200);
    const room = await (await f.call('/pulse', { gameId: session.id })).json() as any;
    expect(room).toMatchObject({ phase: 'reveal', roundId: session.rounds[0].id });
    expect(room.outcome).toMatchObject({ answer: streamAnswer, players: [{ id: '101', score: 2300, distance: 0 }] });
    await f.call('/reveal', { token: session.rounds[0].token, submissions: [] });
    const retry = await (await f.call('/pulse', { gameId: session.id })).json() as any;
    expect(retry.outcome).toEqual(room.outcome);
    expect(JSON.stringify(room)).not.toContain(session.token);
    await f.call('/advance', { gameId: session.id, roundId: session.rounds[0].id });
    expect((await f.call('/reveal', { token: session.rounds[0].token })).status).toBe(409);
    expect(f.calls()).toBe(0); // Neither viewer guesses nor live transitions use D1.
  });
  it("declines over-cap publication before storage without truncating the submitted players", async () => {
    const f = await fixture(),
      input = await f.completed();
    input.players = Array.from(
      { length: STREAM_MAX_PLAYERS + 1 },
      () => input.players[0],
    );
    const response = await f.call("/results", input);
    expect(response.status).toBe(413);
    expect(((await response.json()) as any).error).toMatch(/complete result/);
    expect(f.calls()).toBe(0);
    expect(input.players).toHaveLength(STREAM_MAX_PLAYERS + 1);
  });
  it("has zero database work for start/reveal and one result row across repeat publication", async () => {
    const f = await fixture(),
      input = await f.completed();
    expect(f.calls()).toBe(0);
    const published = await f.call("/results", input);
    expect(published.status).toBe(201);
    const data = (await published.json()) as { id: string };
    expect((await f.call('/quit', { gameId: data.id })).status).toBe(409);
    const room = await (await f.call('/pulse', { gameId: data.id })).json() as any;
    expect(room.phase).toBe('complete');
    expect(room.result).toMatchObject({ id: data.id, format: 'compact-scores-v1' });
    expect(room.result.players).toHaveLength(1);
    expect((await f.call("/results", input)).status).toBe(200);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM stream_results").get(),
    ).toEqual({ n: 1 });
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_limits").get(),
    ).toEqual({ n: 0 });
    const writes = f.sqlite.prepare("SELECT total_changes() AS n").get();
    const response = await handle(
      f.request("/results/" + data.id, undefined, null),
      f.env,
      streamNow + 1000,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(((await response.json()) as any).players).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
      writes,
    );
    input.players[0].rounds[0] = [0, 0];
    input.players[0].score -= 5000;
    expect((await f.call("/results", input)).status).toBe(409);
  });
  it('lists only published games for one channel, with indexed pagination and no read-side writes', async () => {
    const f = await fixture(), input = await f.completed();
    const publication = await (await f.call('/results', input)).json() as any;
    const stored = f.sqlite.prepare('SELECT * FROM stream_results WHERE id=?').get(publication.id) as any;
    const original = await (await f.call('/results/' + publication.id, undefined, null)).json() as any;
    const insert = f.sqlite.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json) VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 24; i++) {
      const id = crypto.randomUUID(), result = { ...original, id };
      if (i === 23) result.host = { ...result.host, login: 'another_streamer' };
      const json = JSON.stringify(result);
      insert.run(id, stored.owner, stored.day, stored.created_at + (i % 3), new TextEncoder().encode(json).byteLength, stored.digest, json);
    }
    const changes = f.sqlite.prepare('SELECT total_changes() AS n').get();
    const calls = f.calls();
    const first = await f.call('/history/' + original.host.login, undefined, null);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toContain('max-age=30');
    const page = await first.json() as any;
    expect(page.games).toHaveLength(20); expect(page.next).toBeTruthy();
    expect(f.calls() - calls).toBe(1);
    const second = await (await f.call('/history/' + original.host.login + '?before=' + page.next, undefined, null)).json() as any;
    expect(second.games).toHaveLength(4); expect(second.next).toBeUndefined();
    expect(new Set([...page.games, ...second.games].map(game => game.id)).size).toBe(24);
    expect(Object.keys(page.games[0]).sort()).toEqual(['finishedAt', 'hostName', 'id', 'players']);
    const plan = f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM stream_results WHERE json_extract(result_json, '$.host.login')=? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 21").all(original.host.login, Number.MAX_SAFE_INTEGER, 'z');
    expect(JSON.stringify(plan)).toContain('stream_results_channel_history');
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect((await f.call('/history/' + original.host.login + '?before=broken', undefined, null)).status).toBe(400);
  });
  it("rejects unauthenticated writes before DB work, bounds bodies and hides private assets", async () => {
    const f = await fixture();
    expect((await f.call("/sessions", {}, null)).status).toBe(401);
    expect(
      (
        await f.call("/results", {
          huge: "x".repeat(STREAM_MAX_DOCUMENT_BYTES),
        })
      ).status,
    ).toBe(413);
    expect(f.calls()).toBe(0);
    expect(
      (
        await handle(
          new Request("https://api.test/game-data/catalog.json"),
          f.env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handle(
          new Request("https://api.test/game-data/native-grid.bin"),
          f.env,
        )
      ).status,
    ).toBe(404);
  });
  it('publishes beyond 200 games and accounts actual stored bytes without deleting old results', async () => {
    const f = await fixture(), input = await f.completed();
    const insert = f.sqlite.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json) VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 250; i++) insert.run('fixture-' + i, 'other', '2026-01-01', 1, 2, 'digest', '{}');
    const result = await f.call('/results', input);
    expect(result.status).toBe(201);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_results').get()).toEqual({ games: 251 });
    const sum = f.sqlite.prepare('SELECT SUM(bytes+?) AS used_bytes, COUNT(*) AS games FROM stream_results').get(STREAM_RESULT_OVERHEAD_BYTES);
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage WHERE id=1').get()).toEqual(sum);
    const before = f.sqlite.prepare('SELECT total_changes() AS n').get();
    expect((await f.call('/results', input)).status).toBe(200);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
  it("stops at the byte budget without changing existing results", async () => {
    const f = await fixture(),
      input = await f.completed();
    const insert = f.sqlite.prepare(
      "INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json) VALUES(?,?,?,?,?,?,?)",
    );
    insert.run('fixture', 'other', '2026-01-01', 1, 2, 'digest', '{}');
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1').run(STREAM_STORAGE_BUDGET_BYTES);
    const writes = f.sqlite.prepare("SELECT total_changes() AS n").get();
    const result = await f.call("/results", input);
    expect(result.status).toBe(507);
    expect(((await result.json()) as any).error).toMatch(/download/i);
    expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
      writes,
    );
  });
  it('acknowledges an already-published result even when all storage budget is used', async () => {
    const f = await fixture(), input = await f.completed();
    expect((await f.call('/results', input)).status).toBe(201);
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1').run(STREAM_STORAGE_BUDGET_BYTES);
    const before = f.sqlite.prepare('SELECT total_changes() AS n').get();
    expect((await f.call('/results', input)).status).toBe(200);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
  it('admits only one concurrent publication when the remaining byte budget fits one', async () => {
    const f = await fixture(), first = await f.completed(), second = await f.completed();
    // A real one-player result takes much less than this; two result overhead
    // allowances alone exceed it. Both requests see the same owner/day.
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1')
      .run(STREAM_STORAGE_BUDGET_BYTES - 7000);
    const responses = await Promise.all([f.call('/results', first), f.call('/results', second)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 507]);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_results').get()).toEqual({ games: 1 });
    expect((f.sqlite.prepare('SELECT used_bytes FROM stream_result_storage').get() as { used_bytes: number }).used_bytes)
      .toBeLessThanOrEqual(STREAM_STORAGE_BUDGET_BYTES);
  });
  it('distinguishes the daily publication limit from storage exhaustion and keeps the real retry time', async () => {
    const f = await fixture(), input = await f.completed();
    const insert = f.sqlite.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json) VALUES(?,?,?,?,?,?,?)');
    const day = new Date(streamNow).toISOString().slice(0, 10);
    for (let i = 0; i < 100; i++) insert.run('quota-' + i, 'other', day, streamNow, 2, 'digest', '{}');
    const result = await f.call('/results', input);
    expect(result.status).toBe(429); expect((await result.json() as any).error).toContain('Today’s result publishing limit');
    expect(Number(result.headers.get('Retry-After'))).toBeGreaterThan(60);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_results').get()).toEqual({ games: 100 });
  });
  it("rejects coerced numeric or array player IDs before publication", async () => {
    const f = await fixture(),
      input = await f.completed();
    for (const id of [100, ["100"]]) {
      const invalid = {
        ...input,
        players: [...input.players, { ...input.players[0], id }],
      };
      expect((await f.call("/results", invalid)).status).toBe(400);
    }
    expect(f.calls()).toBe(0);
  });
  it("rejects invalid score components, totals, duplicate IDs and round counts before storage", async () => {
    const f = await fixture(),
      original = await f.completed();
    const mutations: ((input: typeof original) => void)[] = [
      (input) => {
        input.players[0].rounds[0][0] = -1;
      },
      (input) => {
        input.players[0].rounds[0][0] = NaN;
      },
      (input) => {
        input.players[0].rounds[0][0] = 5001;
      },
      (input) => {
        input.players[0].rounds[0][1] = -1;
      },
      (input) => {
        input.players[0].rounds[0][0] -= 1;
      },
      (input) => {
        input.players[0].score -= 1;
      },
      (input) => {
        input.players[0].rounds.pop();
      },
      (input) => {
        input.players.push(input.players[0]);
      },
    ];
    for (const mutate of mutations) {
      const input = structuredClone(original);
      mutate(input);
      expect((await f.call("/results", input)).status).toBe(400);
    }
    expect(f.calls()).toBe(0);
  });
});
