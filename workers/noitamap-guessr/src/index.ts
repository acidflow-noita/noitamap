import {
  scoreGuess,
  within,
  type Bounds,
  type Point,
} from "../../../src/guessr/rules";
import { verifyGameTicket, type GameIdentity } from "./tickets";
import { streamRoute } from "./streams";
import type { LiveRoomNamespace } from "../../../src/guessr/live-room-types";
import { createPreparedRoundSource } from "../../../src/guessr/prepared-rounds";
import {
  SoloGameService,
  soloGameRoute,
} from "../../../src/guessr/solo-server";
import { publishDaily } from './daily-publish';
import { scoreAreaGuess } from '../../../src/guessr/area-rules';
import { DAILY_ROUNDS } from '../../../src/guessr/daily-pack';

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export interface Env {
  DB: Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  GAME_SIGNING_SECRET: string;
  ALLOWED_ORIGINS: string;
  GAME_ENABLED?: string;
  SOLO_ENABLED?: string;
  DAILY_REQUEST_BUDGET?: string;
  STREAM_ENABLED?: string;
  STREAM_SIGNING_SECRET?: string;
  STREAM_IMAGE_ROOT?: string;
  STREAM_REFERENCE_ROOT?: string;
  DAILY_PUBLISH_SECRET?: string;
  DAILY_ASSET_HOSTS?: string;
  LIVE_ROOMS?: LiveRoomNamespace;
}
interface Challenge {
  id: string;
  day: string;
  title: string;
  opens_at: number;
  closes_at: number;
  reveal_at: number;
  bounds_json: string;
  round_seconds: number;
  image_config_json?: string | null;
  dataset_version?: string | null;
}
interface Attempt {
  id: string;
  user_id: string;
  challenge_id: string;
  display_name: string;
  next_round: number;
  score: number;
  elapsed_ms: number;
  round_started_at: number;
  started_at: number;
  completed_at: number | null;
}
interface Question {
  ordinal: number;
  asset_key: string;
  x: number;
  y: number;
  name: string;
  biome: string;
  seed: number;
  area_json?: string | null;
  clue_json?: string | null;
}
interface Guess {
  ordinal: number;
  request_id: string;
  request_hash: string;
  x: number | null;
  y: number | null;
  score: number;
  distance: number | null;
  elapsed_ms: number;
  maximum?: number;
  area_score?: number | null;
  position_score?: number | null;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const boardCaches = new WeakMap<
  Database,
  Map<string, { at: number; value: unknown }>
>();
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    fail(415, "Send JSON.");
  if (Number(request.headers.get("Content-Length")) > 2048)
    fail(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Missing request.");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 2048) {
      await reader.cancel();
      fail(413, "Request is too large.");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (!data || Array.isArray(data) || typeof data !== "object") throw Error();
    return data;
  } catch {
    return fail(400, "Invalid JSON.");
  }
}
function only(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    fail(400, "Unexpected request field.");
}
async function identity(
  request: Request,
  env: Env,
  now: number,
): Promise<GameIdentity> {
  const header = request.headers.get("Authorization") || "";
  const user = header.startsWith("Bearer ")
    ? await verifyGameTicket(
        header.slice(7),
        env.GAME_SIGNING_SECRET || "",
        now,
      )
    : null;
  if (!user) fail(401, "Sign in with an active Pro membership.");
  return user;
}
async function admit(env: Env, user: GameIdentity, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10),
    minute = Math.floor(now / 60000);
  const budget = Math.min(
    40000,
    Math.max(100, Number(env.DAILY_REQUEST_BUDGET) || 10000),
  );
  for (const [key, max, expires] of [
    [`u:${user.sub}:m:${minute}`, 30, now + 120000],
    [`u:${user.sub}:d:${day}`, 200, now + 172800000],
    [`all:${day}`, budget, now + 172800000],
  ] as const) {
    const row = await env.DB.prepare(
      // Once the shared budget is exhausted, even new accounts cannot create
      // more counter rows. The conditional insert/update is atomic in D1.
      "INSERT INTO usage_limits(key,count,expires_at) SELECT ?,1,? WHERE COALESCE((SELECT count FROM usage_limits WHERE key=?),0) < ? ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count",
    )
      .bind(key, expires, `all:${day}`, budget, max)
      .first();
    if (!row) {
      const total = await env.DB.prepare(
        "SELECT count FROM usage_limits WHERE key=?",
      )
        .bind(`all:${day}`)
        .first<{ count: number }>();
      fail(
        429,
        (total?.count ?? 0) >= budget
          ? "Ranked play is resting for today. Practice is still available."
          : "Too many requests. Please try again later.",
      );
    }
  }
}
async function challenge(env: Env, id: string): Promise<Challenge> {
  const value = await env.DB.prepare(
    "SELECT * FROM challenges WHERE id=? AND enabled=1",
  )
    .bind(id)
    .first<Challenge>();
  return value ?? fail(404, "Challenge not found.");
}
async function attempt(
  env: Env,
  id: string,
  user: GameIdentity,
): Promise<Attempt> {
  const value = await env.DB.prepare(
    "SELECT * FROM attempts WHERE id=? AND user_id=?",
  )
    .bind(id, user.sub)
    .first<Attempt>();
  return value ?? fail(404, "Attempt not found.");
}
async function state(env: Env, a: Attempt, c: Challenge, now: number) {
  const finished = a.next_round === DAILY_ROUNDS;
  const revealed = true;
  const guesses = (
    await env.DB.prepare(
      "SELECT ordinal,x,y,score,distance,elapsed_ms,maximum,area_score,position_score FROM guesses WHERE attempt_id=? ORDER BY ordinal",
    )
      .bind(a.id)
      .all<Guess>()
  ).results;
  let results: unknown[] | undefined;
  if (revealed) {
    const questions = (
      await env.DB.prepare(
        "SELECT ordinal,x,y,name,biome,seed,area_json,clue_json FROM questions WHERE challenge_id=? AND ordinal<? ORDER BY ordinal",
      )
        .bind(c.id, a.next_round)
        .all<Question>()
    ).results;
    results = questions.map((q) => ({
      ordinal: q.ordinal,
      answer: { x: q.x, y: q.y },
      name: q.name,
      biome: q.biome,
      seed: q.seed,
      image: `/api/attempts/${a.id}/image/${q.ordinal}`,
      ...(q.clue_json ? { clue: JSON.parse(q.clue_json), difficultyTier: JSON.parse(q.area_json!).difficultyTier } : {}),
      guess: guesses.find((g) => g.ordinal === q.ordinal) ?? null,
    }));
  }
  const current = !finished && c.image_config_json
    ? await env.DB.prepare('SELECT clue_json FROM questions WHERE challenge_id=? AND ordinal=?').bind(c.id, a.next_round).first<{ clue_json: string }>() : null;
  if (!finished && c.image_config_json && !current?.clue_json) fail(503, 'Daily clue data is unavailable. Your attempt is saved.');
  return {
    id: a.id,
    challengeId: c.id,
    day: c.day,
    title: c.title,
    totalRounds: DAILY_ROUNDS,
    round: a.next_round,
    status: finished ? "complete" : "active",
    revealed,
    revealAt: c.reveal_at,
    closesAt: c.closes_at,
    serverNow: now,
    bounds: JSON.parse(c.bounds_json) as Bounds,
    deadline: null,
    image: !finished && !c.image_config_json ? `/api/attempts/${a.id}/image/${a.next_round}` : null,
    ...(c.image_config_json ? { config: JSON.parse(c.image_config_json), clue: current?.clue_json ? JSON.parse(current.clue_json) : null } : {}),
    // Solo results are available immediately. Daily rotation is not a timer.
    submitted: guesses.map((g) => g.ordinal),
    ...(revealed ? { score: a.score, elapsedMs: a.elapsed_ms, results } : {}),
  };
}
async function route(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === '/api/admin/daily') return publishDaily(request, env, now);
  if (path.startsWith("/api/streams/")) return streamRoute(request, env, now);
  if (path.startsWith("/api/games/")) {
    if (
      env.SOLO_ENABLED !== "true" ||
      (env.GAME_SIGNING_SECRET || "").length < 32
    )
      return json(
        { error: "Demo rounds are not available on this site yet." },
        503,
      );
    const source = createPreparedRoundSource(
      (path) => env.ASSETS.fetch(new Request("https://private.invalid" + path)),
      env.STREAM_IMAGE_ROOT || "https://guessr-tiles.sage-data.xyz/images",
      env.STREAM_REFERENCE_ROOT ||
        "https://guessr-map.sage-data.xyz/map_files/",
    );
    return (
      (await soloGameRoute(
        request,
        new SoloGameService(source, env.GAME_SIGNING_SECRET),
        now,
      )) ?? json({ error: "Game route not found." }, 404)
    );
  }
  if (path === "/health" && request.method === "GET")
    return json({
      service: "noitamap-guessr",
      enabled: env.GAME_ENABLED === "true",
    });
  if (!path.startsWith("/api/")) return json({ error: "Not found." }, 404);
  if (env.GAME_ENABLED !== "true")
    fail(503, "Ranked games are not available yet. Practice is ready to play.");
  if (!["GET", "POST"].includes(request.method))
    fail(405, "Method not allowed.");
  const user = await identity(request, env, now);
  await admit(env, user, now);
  if (path === "/api/daily" && request.method === "GET") {
    const day =
      url.searchParams.get("day") || new Date(now).toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day + "T00:00:00Z")) ||
      new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day
    )
      fail(400, "Invalid daily date.");
    const current = await env.DB.prepare(
      "SELECT id,day,title,opens_at,closes_at,reveal_at,round_seconds FROM challenges WHERE enabled=1 AND day=? AND opens_at<=?",
    )
      .bind(day, now)
      .first<Challenge>();
    if (!current) return json({ challenge: null });
    const existing = await env.DB.prepare(
      "SELECT id FROM attempts WHERE user_id=? AND challenge_id=?",
    )
      .bind(user.sub, current.id)
      .first<{ id: string }>();
    return json({
      challenge: {
        id: current.id,
        day: current.day,
        title: current.title,
        closesAt: current.closes_at,
        revealAt: current.reveal_at,
        roundSeconds: current.round_seconds,
        totalRounds: DAILY_ROUNDS,
      },
      attemptId: existing?.id ?? null,
    });
  }
  if (path === "/api/attempts" && request.method === "POST") {
    const data = await body(request);
    only(data, ["challengeId"]);
    if (
      typeof data.challengeId !== "string" ||
      !idPattern.test(data.challengeId)
    )
      fail(400, "Invalid challenge.");
    const c = await challenge(env, data.challengeId);
    const existing = await env.DB.prepare(
      "SELECT * FROM attempts WHERE user_id=? AND challenge_id=?",
    )
      .bind(user.sub, c.id)
      .first<Attempt>();
    if (existing) return json(await state(env, existing, c, now));
    if (now < c.opens_at) fail(409, "This challenge is closed.");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM questions WHERE challenge_id=?",
    )
      .bind(c.id)
      .first<{ n: number }>();
    if (count?.n !== DAILY_ROUNDS) fail(503, "This challenge is not ready.");
    await env.DB.prepare(
      "INSERT INTO attempts(id,user_id,challenge_id,display_name,started_at,round_started_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,challenge_id) DO NOTHING",
    )
      .bind(crypto.randomUUID(), user.sub, c.id, user.name, now, now)
      .run();
    const a = await env.DB.prepare(
      "SELECT * FROM attempts WHERE user_id=? AND challenge_id=?",
    )
      .bind(user.sub, c.id)
      .first<Attempt>();
    return json(await state(env, a!, c, now));
  }
  const match = path.match(
    /^\/api\/attempts\/([\w-]{1,100})(?:\/(guess|quit|image)(?:\/([0-9]))?)?$/,
  );
  if (match) {
    const a = await attempt(env, match[1], user),
      c = await challenge(env, a.challenge_id);
    if (!match[2] && request.method === "GET")
      return json(await state(env, a, c, now));
    if (
      match[2] === "quit" &&
      match[3] === undefined &&
      request.method === "POST"
    ) {
      only(await body(request), []);
      // Completing the same row keeps earned points and the daily attempt lock.
      // The guess trigger rejects any submission that races after this update.
      await env.DB.prepare(
        "UPDATE attempts SET next_round=?,completed_at=? WHERE id=? AND user_id=? AND next_round<? AND completed_at IS NULL",
      )
        .bind(DAILY_ROUNDS, now, a.id, user.sub, DAILY_ROUNDS)
        .run();
      return json(await state(env, await attempt(env, a.id, user), c, now));
    }
    if (
      match[2] === "image" &&
      match[3] !== undefined &&
      request.method === "GET"
    ) {
      const ordinal = Number(match[3]);
      if (ordinal >= DAILY_ROUNDS) fail(404, 'Image unavailable.');
      if (ordinal > a.next_round) fail(403, "This round is not available.");
      const q = await env.DB.prepare(
        "SELECT asset_key FROM questions WHERE challenge_id=? AND ordinal=?",
      )
        .bind(c.id, ordinal)
        .first<Question>();
      if (!q || !/^[a-f0-9]{32,64}\.webp$/.test(q.asset_key))
        fail(404, "Image unavailable.");
      const response = await env.ASSETS.fetch(
        new Request("https://assets.invalid/" + q.asset_key),
      );
      if (!response.ok) fail(503, "Image unavailable. Your attempt is saved.");
      return new Response(response.body, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (match[2] === "guess" && request.method === "POST") {
      const data = await body(request);
      only(data, ["round", "guess", "requestId", "maximum"]);
      const maximum = data.maximum === undefined ? 5000 : data.maximum;
      if (!Number.isInteger(maximum) || Number(maximum) < 0 || Number(maximum) > 5000) fail(400, 'Invalid assistance allowance.');
      if (
        !Number.isInteger(data.round) ||
        Number(data.round) < 0 ||
        Number(data.round) >= DAILY_ROUNDS ||
        typeof data.requestId !== "string" ||
        !/^[\w-]{16,80}$/.test(data.requestId)
      )
        fail(400, "Invalid round submission.");
      const bounds = JSON.parse(c.bounds_json) as Bounds;
      if (data.guess !== null && !within(data.guess, bounds))
        fail(400, "Pin must be inside the map.");
      const guess = data.guess as Point | null;
      const hash = JSON.stringify([
        data.round,
        guess?.x ?? null,
        guess?.y ?? null,
        ...(data.maximum === undefined ? [] : [maximum]),
      ]);
      const previous = await env.DB.prepare(
        "SELECT * FROM guesses WHERE attempt_id=? AND ordinal=?",
      )
        .bind(a.id, data.round)
        .first<Guess>();
      if (previous) {
        if (
          previous.request_id !== data.requestId ||
          previous.request_hash !== hash
        )
          fail(409, "That round was already submitted.");
        return json(await state(env, a, c, now));
      }
      if (a.next_round !== data.round) fail(409, "This round is closed.");
      const q = await env.DB.prepare(
        "SELECT * FROM questions WHERE challenge_id=? AND ordinal=?",
      )
        .bind(c.id, data.round)
        .first<Question>();
      if (!q) fail(503, "Question unavailable.");
      const elapsed = 0;
      const accepted = guess;
      const areaResult = q.area_json ? scoreAreaGuess(JSON.parse(q.area_json), { x: q.x, y: q.y }, accepted, Number(maximum)) : null;
      const result = areaResult ?? scoreGuess(accepted, q);
      try {
        await env.DB.prepare(
          "INSERT INTO guesses(attempt_id,ordinal,request_id,request_hash,x,y,score,distance,elapsed_ms,accepted_at,maximum,area_score,position_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            a.id,
            data.round,
            data.requestId,
            hash,
            accepted?.x ?? null,
            accepted?.y ?? null,
            result.score,
            result.distance,
            elapsed,
            now,
            maximum,
            areaResult?.areaScore ?? null,
            areaResult?.positionScore ?? null,
          )
          .run();
      } catch {
        const won = await env.DB.prepare(
          "SELECT request_id,request_hash FROM guesses WHERE attempt_id=? AND ordinal=?",
        )
          .bind(a.id, data.round)
          .first<Guess>();
        if (
          !won ||
          won.request_id !== data.requestId ||
          won.request_hash !== hash
        )
          fail(409, "That round was already submitted. Refresh your attempt.");
      }
      return json(await state(env, await attempt(env, a.id, user), c, now));
    }
    fail(405, "Method not allowed.");
  }
  if (path === "/api/history" && request.method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT a.id,c.day,c.title,c.reveal_at,a.next_round,a.completed_at,a.score,a.elapsed_ms FROM attempts a JOIN challenges c ON c.id=a.challenge_id WHERE a.user_id=? ORDER BY a.started_at DESC LIMIT 20",
      )
        .bind(user.sub)
        .all<Record<string, unknown>>()
    ).results;
    return json({
      attempts: rows.map((r) => ({
        id: r.id,
        day: r.day,
        title: r.title,
        complete: r.completed_at !== null,
        totalRounds: DAILY_ROUNDS,
        revealAt: r.reveal_at,
        ...(r.completed_at !== null || now >= Number(r.reveal_at)
          ? { score: r.score, elapsedMs: r.elapsed_ms }
          : {}),
      })),
    });
  }
  if (path === "/api/leaderboard" && request.method === "GET") {
    const period = url.searchParams.get("period") || "daily";
    if (!["daily", "weekly"].includes(period))
      fail(400, "Invalid leaderboard period.");
    const day =
      url.searchParams.get("day") ||
      new Date(now - 86400000).toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day + "T00:00:00Z")) ||
      new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day
    )
      fail(400, "Invalid day.");
    const c = await env.DB.prepare(
      "SELECT * FROM challenges WHERE day=? AND enabled=1",
    )
      .bind(day)
      .first<Challenge>();
    if (!c || now < c.reveal_at)
      return json({ period, day, rows: [], pending: !!c });
    let cache = boardCaches.get(env.DB);
    if (!cache) {
      cache = new Map();
      boardCaches.set(env.DB, cache);
    }
    const cacheKey = `${period}:${day}`,
      cached = cache.get(cacheKey);
    if (cached && now - cached.at < 60000) return json(cached.value);
    const sql =
      period === "daily"
        ? "SELECT display_name AS name,score,elapsed_ms AS elapsedMs,1 AS games FROM attempts WHERE challenge_id=? AND completed_at IS NOT NULL ORDER BY score DESC,elapsed_ms,completed_at LIMIT 100"
        : "SELECT MAX(a.display_name) AS name,SUM(a.score) AS score,SUM(a.elapsed_ms) AS elapsedMs,COUNT(*) AS games FROM attempts a JOIN challenges c ON c.id=a.challenge_id WHERE c.day>=? AND c.day<=? AND c.reveal_at<=? AND a.completed_at IS NOT NULL GROUP BY a.user_id ORDER BY score DESC,elapsedMs LIMIT 100";
    const start = new Date(Date.parse(day + "T00:00:00Z") - 6 * 86400000)
      .toISOString()
      .slice(0, 10);
    const stmt = env.DB.prepare(sql);
    const rows = (
      await (
        period === "daily" ? stmt.bind(c.id) : stmt.bind(start, day, now)
      ).all()
    ).results;
    const value = { period, day, rows, pending: false };
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: now, value });
    return json(value);
  }
  return json({ error: "Not found." }, 404);
}

export async function handle(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origin && !allowed.includes(origin))
    return json({ error: "Origin not allowed." }, 403);
  let response: Response;
  if (request.method === "OPTIONS")
    response = new Response(null, { status: 204 });
  else
    try {
      response = await route(request, env, now);
    } catch (e) {
      response = json(
        {
          error:
            e instanceof HttpError
              ? e.message
              : "The game could not save this request. Please retry.",
        },
        e instanceof HttpError ? e.status : 503,
      );
    }
  // Preserve the upgraded socket; constructing an ordinary Response loses it.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Vary", "Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Guessr-State",
    );
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Max-Age", "86400");
  }
  if (response.status === 429) headers.set("Retry-After", "60");
  return new Response(response.body, { status: response.status, headers });
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  async scheduled(_event: unknown, env: Env) {
    await env.DB.prepare("DELETE FROM usage_limits WHERE expires_at<?")
      .bind(Date.now())
      .run();
  },
};
