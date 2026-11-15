import { persistStreamResult } from '../workers/noitamap-guessr/src/result-publication';
import { StreamService } from '../src/guessr/stream-server';
import { verifyGameTicket } from '../workers/noitamap-guessr/src/tickets';
import { ImageGameError } from '../src/guessr/image-game-server';
import { testGameKeys, signResultManagementTicket } from './helpers/game-ticket-keys';
import { packStreamPublish } from "../src/guessr/stream-codec";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { streamRoute } from "../workers/noitamap-guessr/src/streams";
import { STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES } from '../workers/noitamap-guessr/src/result-storage';
import { handle, type Env } from "../workers/noitamap-guessr/src/index";
import { signGameTicket } from "./helpers/game-ticket-keys";
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
import type { ParallelInitialization } from '../src/guessr/parallel-types';
import {
  streamAnswer,
  streamHost,
  streamNow,
  streamSecret,
  streamSource,
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
  db.sqlite.exec(readFileSync('workers/noitamap-guessr/migrations/0007_result_ownership.sql', 'utf8'));
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
    GAME_SIGNING_SECRET: streamSecret, GAME_TICKET_PUBLIC_KEY: (await testGameKeys(streamSecret)).publicKey,
    STREAM_SIGNING_SECRET: streamSecret,
    STREAM_ENABLED: "true",
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
  const service = new StreamService(streamSource(), streamSecret);
  async function owner(token: string) {
    const user = (await verifyGameTicket(token, env.GAME_TICKET_PUBLIC_KEY!, streamNow + 1000))!;
    return { sub: user.sub, name: user.name, twitchUserId: user.twitchUserId!, twitchLogin: user.twitchLogin!, ticketIssuedAt: user.iat * 1000 };
  }
  async function completed(hostToken = ticket.token) {
    const user = await owner(hostToken), session = await service.start(user, streamNow + 1000, 'parallel', 10);
    const game = newStreamGame(session, streamNow + 1000);
    for (let i = 0; i < session.rounds.length; i++) {
      closeStreamRound(game, streamAnswer, streamNow + 1000);
      revealStreamRound(game, await service.reveal(session.rounds[i].token, user, streamNow + 1000));
      advanceStreamRound(game, streamNow + 1000);
    }
    return packStreamPublish({ token: session.token, finishedAt: game.finishedAt!, players: streamResult(game).players });
  }
  async function publish(input: unknown, hostToken = ticket.token) {
    try {
      const user = await owner(hostToken);
      const { owner: id, result } = await service.result(input as Parameters<typeof service.result>[0], user, streamNow + 1000);
      return await persistStreamResult(env, id, result, user.ticketIssuedAt, streamNow + 1000);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: error instanceof ImageGameError ? error.status : 503 });
    }
  }
  return { ...db, env, call, request, completed, publish };
}
describe("single-document stream publication", () => {
  it('creates PvP only with Pro and private transport, without handing its creator any future clues or tokens', async () => {
    const f = await fixture(), initialized: ParallelInitialization[] = [];
    f.env.STREAM_COORDINATORS = { getByName: () => ({ initialize: async input => { initialized.push(input); }, fetch: async () => new Response() }) };
    expect((await f.call('/sessions', { protocol: 2, mode: 'pvp', transport: 'parallel', rounds: 3 }, null)).status).toBe(401);
    expect((await f.call('/sessions', { protocol: 2, mode: 'pvp', transport: 'twitch', rounds: 3 })).status).toBe(410);
    expect((await f.call('/sessions', { protocol: 2, transport: 'parallel', streaming: 'false' })).status).toBe(400);
    expect(initialized).toHaveLength(0);
    const response = await f.call('/sessions', { protocol: 2, mode: 'pvp', transport: 'parallel', rounds: 3 });
    expect(response.status).toBe(201);
    const result = await response.json() as StreamSession;
    expect(result.mode).toBe('pvp'); expect(result.streaming).toBe(false); expect(result.token).toBe(''); expect(result.rounds).toEqual([]);
    expect(initialized).toHaveLength(1); expect(initialized[0].reveals).toHaveLength(3);
    expect(initialized[0].session.rounds).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(initialized[0].session.rounds[0].clue.frames![0].image);
    expect((await f.call('/sessions', { protocol: 2, transport: 'parallel', rounds: 3 })).status).toBe(201);
    expect(initialized[1].session.streaming).toBe(true);
  });
  it('rejects retired Twitch game creation, reveals and client result uploads without database work', async () => {
    const f = await fixture();
    expect((await f.call('/sessions', { transport: 'twitch', rounds: 10 })).status).toBe(410);
    expect((await f.call('/reveal', { token: 'retired' })).status).toBe(410);
    expect((await f.call('/results', { token: 'retired', players: [] })).status).toBe(410);
    expect(f.calls()).toBe(0);
  });
  it.each(['/advance', '/pulse', '/pause', '/quit', '/rooms/wuote'])('retires %s before any auth, source or database work', async path => {
    const f = await fixture();
    expect((await f.call(path, path.startsWith('/rooms/') ? undefined : {}, null)).status).toBe(404);
    expect(f.calls()).toBe(0);
  });
  it('requires the current game protocol and private coordinator', async () => {
    const f = await fixture();
    expect((await f.call('/sessions', {})).status).toBe(410);
    expect((await f.call('/sessions', { protocol: 2, transport: 'parallel' })).status).toBe(503);
    expect(f.calls()).toBe(0);
  });

  it("declines over-cap publication before storage without truncating the submitted players", async () => {
    const f = await fixture(),
      input = await f.completed();
    input.players = Array.from(
      { length: STREAM_MAX_PLAYERS + 1 },
      () => input.players[0],
    );
    const response = await f.publish( input);
    expect(response.status).toBe(413);
    expect(((await response.json()) as any).error).toMatch(/complete result/);
    expect(f.calls()).toBe(0);
    expect(input.players).toHaveLength(STREAM_MAX_PLAYERS + 1);
  });
  it("persists one result row across repeat internal publication", async () => {
    const f = await fixture(),
      input = await f.completed();
    expect(f.calls()).toBe(0);
    const published = await f.publish( input);
    expect(published.status).toBe(201);
    const data = (await published.json()) as { id: string };
    expect((await f.publish( input)).status).toBe(200);
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
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(((await response.json()) as any).players).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
      writes,
    );
    input.players[0].rounds[0] = [0, 0];
    input.players[0].score -= 5000;
    expect((await f.publish( input)).status).toBe(409);
  });
  it('lists only published games for one channel, with indexed pagination and no read-side writes', async () => {
    const f = await fixture(), input = await f.completed();
    const publication = await (await f.publish( input)).json() as any;
    const stored = f.sqlite.prepare('SELECT * FROM stream_results WHERE id=?').get(publication.id) as any;
    const original = await (await f.call('/results/' + publication.id, undefined, null)).json() as any;
    const insert = f.sqlite.prepare('INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,host_id,host_verified_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 24; i++) {
      const id = crypto.randomUUID(), result = { ...original, id };
      if (i === 23) result.host = { ...result.host, id: '200', login: 'another_streamer' };
      const json = JSON.stringify(result);
      insert.run(id, stored.owner, stored.day, stored.created_at + (i % 3), new TextEncoder().encode(json).byteLength, stored.digest, json, result.host.id, stored.host_verified_at);
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
    const plan = f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM stream_results WHERE host_id=? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 21").all(original.host.id, Number.MAX_SAFE_INTEGER, 'z');
    expect(JSON.stringify(plan)).toContain('stream_results_host_history');
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
    const result = await f.publish( input);
    expect(result.status).toBe(201);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS games FROM stream_results').get()).toEqual({ games: 251 });
    const sum = f.sqlite.prepare('SELECT SUM(bytes+?) AS used_bytes, COUNT(*) AS games FROM stream_results').get(STREAM_RESULT_OVERHEAD_BYTES);
    expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage WHERE id=1').get()).toEqual(sum);
    const before = f.sqlite.prepare('SELECT total_changes() AS n').get();
    expect((await f.publish( input)).status).toBe(200);
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
    const result = await f.publish( input);
    expect(result.status).toBe(507);
    expect(((await result.json()) as any).error).toMatch(/download/i);
    expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
      writes,
    );
  });
  it('acknowledges an already-published result even when all storage budget is used', async () => {
    const f = await fixture(), input = await f.completed();
    expect((await f.publish( input)).status).toBe(201);
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1').run(STREAM_STORAGE_BUDGET_BYTES);
    const before = f.sqlite.prepare('SELECT total_changes() AS n').get();
    expect((await f.publish( input)).status).toBe(200);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
  it('admits only one concurrent publication when the remaining byte budget fits one', async () => {
    const f = await fixture(), first = await f.completed(), second = await f.completed();
    // A real one-player result takes much less than this; two result overhead
    // allowances alone exceed it. Both requests see the same owner/day.
    f.sqlite.prepare('UPDATE stream_result_storage SET used_bytes=? WHERE id=1')
      .run(STREAM_STORAGE_BUDGET_BYTES - 7000);
    const responses = await Promise.all([f.publish( first), f.publish( second)]);
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
    const result = await f.publish( input);
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
      expect((await f.publish( invalid)).status).toBe(400);
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
      expect((await f.publish( input)).status).toBe(400);
    }
    expect(f.calls()).toBe(0);
  });
});


it('rejects excessive anonymous demo calls before reading puzzle assets or D1', async () => {
  const f = await fixture();
  let assets = 0;
  f.env.SOLO_ENABLED = 'true'; f.env.ASSETS.fetch = async () => { assets++; return new Response(''); };
  f.env.PUBLIC_GAME_RATE_LIMIT = { limit: async () => ({ success: false }) };
  const response = await handle(new Request('https://api.test/api/games/start', {
    method: 'POST', headers: { Origin: 'https://dynamic-map.noitamap.com' },
  }), f.env, streamNow);
  expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
  expect(assets).toBe(0); expect(f.calls()).toBe(0);
});


it('uses the current verified host name and stable ID after a rename, without transferring history to a recycled name', async () => {
  const f = await fixture(), input = await f.completed();
  const renamed = await signGameTicket(streamHost.sub, 'Renamed', streamSecret, { ...streamHost, twitchLogin: 'renamed' }, streamNow + 1000);
  expect((await f.publish( input, renamed.token)).status).toBe(201);
  const id = (await (await f.call('/history/renamed', undefined, null)).json() as any).games[0].id;
  const result = await (await f.call('/results/' + id, undefined, null)).json() as any;
  expect(result.host).toEqual({ id: streamHost.twitchUserId, name: 'Renamed', login: 'renamed' });
  expect((await (await f.call('/history/streamer', undefined, null)).json() as any).games).toEqual([]);
  const recycled = await signGameTicket('account:other', 'New streamer', streamSecret, { twitchUserId: '200', twitchLogin: 'streamer' }, streamNow + 1000);
  const otherGame = await f.completed(recycled.token);
  expect((await f.publish( otherGame, recycled.token)).status).toBe(201);
  const oldName = await (await f.call('/history/streamer', undefined, null)).json() as any;
  expect(oldName.games).toHaveLength(1); expect(oldName.games[0].id).not.toBe(id);
  const laterLabel = await signGameTicket(streamHost.sub, 'Renamed again', streamSecret, { ...streamHost, twitchLogin: 'renamedagain' }, streamNow + 1000);
  expect((await f.publish( input, laterLabel.token)).status).toBe(200);
});
it.each(['name\nforged log', 'abc\u202edef', '<script>user</script>', 'user\u200dname', ' ', '\u061c\u061c007'])('sanitizes display label %j without dropping anyone’s scores', async name => {
  const f = await fixture(), input = await f.completed(); input.players.push({ ...structuredClone(input.players[0]), id: '999', login: 'omicron', name });
  const response = await f.publish( input);
  expect(response.status).toBe(201);
  const { id } = await response.json();
  const result = await (await f.call('/results/' + id)).json();
  expect(result.players).toHaveLength(input.players.length);
  const player = result.players.find((p: any) => p.id === input.players[1].id);
  expect(player.name).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}<>]/u);
  expect(player.name.length).toBeGreaterThan(0);
  expect(player.score).toBe(input.players[1].score);
});
it('allows owner/admin removal without Pro, blocks other users and prevents re-publication', async () => {
  const f = await fixture(), input = await f.completed();
  const result = await (await f.publish( input)).json() as { id: string };
  const path = '/results/' + result.id + '/delete';
  expect((await f.call(path, {}, null)).status).toBe(401);
  const stranger = await signResultManagementTicket('account:stranger', 'Stranger', streamSecret, { twitchUserId: '200', twitchLogin: 'other' }, streamNow);
  expect((await f.call(path, {}, stranger.token)).status).toBe(404);
  const owner = await signResultManagementTicket(streamHost.sub, streamHost.name, streamSecret, streamHost, streamNow);
  expect((await f.call('/sessions', { protocol: 2, transport: 'twitch' }, owner.token)).status).toBe(401);
  expect((await f.call(path, {}, owner.token)).status).toBe(204);
  expect((await f.call(path, {}, owner.token)).status).toBe(204);
  expect((await f.call('/results/' + result.id, undefined, null)).status).toBe(404);
  expect((await f.publish( input)).status).toBe(410);
  expect(f.sqlite.prepare('SELECT used_bytes,games FROM stream_result_storage').get()).toEqual({ used_bytes: 0, games: 0 });
  const next = await f.completed(), nextId = (await (await f.publish( next)).json() as any).id;
  const admin = await signResultManagementTicket('account:admin', 'WUOTE', streamSecret, { twitchUserId: '564553302', twitchLogin: 'renamed_admin' }, streamNow);
  expect((await f.call('/results/' + nextId + '/delete', {}, admin.token)).status).toBe(204);
});
