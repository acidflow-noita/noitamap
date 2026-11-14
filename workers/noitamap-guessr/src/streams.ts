import { ImageGameError } from "../../../src/guessr/image-game-server";
import { preparedSource } from "./prepared-source";
import {
  StreamService,
  type StreamHostIdentity,
  type StreamRoundSource,
} from "../../../src/guessr/stream-server";
import {
  STREAM_MAX_DOCUMENT_BYTES,
  STREAM_DEFAULT_ROUNDS, validStreamRoundCount,
  type StreamPublishWireInput,
} from "../../../src/guessr/stream-types";
import { verifyGameTicket, verifyResultManagementTicket } from "./tickets";
import type { Env } from "./index";
import { storedResultResponse, type StoredResultBody } from './result-storage';
import { persistStreamResult } from './result-publication';
export { STREAM_DAILY_PUBLISH_CAP, STREAM_HOST_DAILY_CAP } from './result-publication';

const idPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new ImageGameError(415, "Send JSON.");
  if (Number(request.headers.get("Content-Length")) > STREAM_MAX_DOCUMENT_BYTES)
    throw new ImageGameError(413, "Result is too large; download it instead.");
  const reader = request.body?.getReader();
  if (!reader) throw new ImageGameError(400, "Missing request.");
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > STREAM_MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new ImageGameError(
        413,
        "Result is too large; download it instead.",
      );
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw new ImageGameError(400, "Invalid JSON.");
  }
}
async function hostIdentity(
  request: Request,
  env: Env,
  now: number,
): Promise<StreamHostIdentity> {
  const authorization = request.headers.get("Authorization") ?? "";
  const user = authorization.startsWith("Bearer ")
    ? await verifyGameTicket(
        authorization.slice(7),
        env.GAME_TICKET_PUBLIC_KEY || "",
        now,
      )
    : null;
  if (!user)
    throw new ImageGameError(401, "Sign in with Pro to host a stream game.");
  if (!user.twitchUserId || !user.twitchLogin)
    throw new ImageGameError(
      403,
      "Connect your Twitch channel before hosting.",
    );
  return {
    sub: user.sub,
    name: user.name,
    twitchUserId: user.twitchUserId,
    twitchLogin: user.twitchLogin,
    hostProVerifiedUntil: user.exp * 1000,
    ticketIssuedAt: user.iat * 1000,
  };
}

/** This branch deliberately never calls the legacy admit() request counters.
 * Twitch carries round updates; publication writes one final D1 document.
 * Reads are indexed, immutable and write-free, still subject to Workers/D1 Free
 * quotas. Application caps cannot turn Worker reads into unlimited static reads. */
export async function streamRoute(
  request: Request,
  env: Env,
  now: number,
  source?: StreamRoundSource,
): Promise<Response> {
  try {
    if (env.STREAM_ENABLED !== "true")
      throw new ImageGameError(
        503,
        "Stream hosting is not available on this site yet. The guess picker and downloaded results remain available.",
      );
    const path = new URL(request.url).pathname;
    const socketMatch = /^\/api\/streams\/live\/([a-f0-9-]{36})\/socket$/.exec(path);
    if (socketMatch) {
      if (!idPattern.test(socketMatch[1]) || !env.STREAM_COORDINATORS) throw new ImageGameError(404, 'Game not found.');
      const origin = request.headers.get('Origin');
      if (!origin || !(env.ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).includes(origin)) throw new ImageGameError(403, 'Origin not allowed.');
      if (env.PUBLIC_GAME_RATE_LIMIT && !(await env.PUBLIC_GAME_RATE_LIMIT.limit({ key: 'stream-socket:' + (request.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
        throw new ImageGameError(429, 'Too many connections. Please try again shortly.');
      return await env.STREAM_COORDINATORS.getByName(socketMatch[1]).fetch(request);
    }
    const deleteMatch = /^\/api\/streams\/results\/([a-f0-9-]{36})\/delete$/.exec(path);
    if (deleteMatch) {
      if (!idPattern.test(deleteMatch[1])) throw new ImageGameError(404, 'Result not found.');
      if (request.method !== 'POST') throw new ImageGameError(405, 'Method not allowed.');
      const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
      const manager = await verifyResultManagementTicket(bearer, env.GAME_TICKET_PUBLIC_KEY || '', now);
      if (!manager) throw new ImageGameError(401, 'Sign in to manage your results.');
      if (env.PUBLIC_GAME_RATE_LIMIT && !(await env.PUBLIC_GAME_RATE_LIMIT.limit({ key: 'remove:' + manager.sub })).success) {
        const response = json({ error: 'Too many requests. Please try again later.' }, 429);
        response.headers.set('Retry-After', '60'); return response;
      }
      const id = deleteMatch[1];
      const record = await env.DB.prepare('SELECT owner,host_id FROM stream_results WHERE id=? UNION ALL SELECT owner,host_id FROM stream_result_removals WHERE id=? LIMIT 1')
        .bind(id, id).first<{ owner: string; host_id: string }>();
      if (!record || record.owner !== manager.sub && record.host_id !== manager.twitchUserId && manager.twitchUserId !== '564553302')
        throw new ImageGameError(404, 'Result not found.');
      await env.DB.batch([
        env.DB.prepare('INSERT INTO stream_result_removals(id,owner,host_id,deleted_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id, record.owner, record.host_id, now),
        env.DB.prepare('DELETE FROM stream_results WHERE id=?').bind(id),
      ]);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    const historyMatch = /^\/api\/streams\/history\/([a-z0-9_]{1,25})$/.exec(path);
    if (historyMatch && request.method === 'GET') {
      const cursor = new URL(request.url).searchParams.get('before');
      const match = cursor?.match(/^(\d{1,16})_([a-f0-9-]{36})$/);
      if (cursor && (!match || !Number.isSafeInteger(Number(match[1])) || !idPattern.test(match[2])))
        throw new ImageGameError(400, 'Invalid history page.');
      const query = env.DB.prepare(`SELECT id, created_at,
        json_extract(result_json, '$.finishedAt') AS finishedAt,
        COALESCE(json_extract(result_json, '$.playerCount'), json_array_length(result_json, '$.players')) AS players,
        json_extract(result_json, '$.host.name') AS hostName
        FROM stream_results WHERE host_id=(SELECT twitch_id FROM stream_channels WHERE login=?)
        ${match ? 'AND (created_at, id) < (?, ?)' : ''}
        ORDER BY created_at DESC, id DESC LIMIT 21`);
      const { results } = await query.bind(historyMatch[1], ...(match ? [Number(match[1]), match[2]] : []))
        .all<{ id: string; created_at: number; finishedAt: number; players: number; hostName: string }>();
      const rows = results.slice(0, 20), last = rows.at(-1);
      return new Response(JSON.stringify({ games: rows.map(({ created_at, ...result }) => result),
        ...(results.length > 20 && last ? { next: `${last.created_at}_${last.id}` } : {}) }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
      });
    }
    const resultMatch = /^\/api\/streams\/results\/([^/]+)$/.exec(path);
    if (resultMatch && request.method === "GET") {
      if (!idPattern.test(resultMatch[1]))
        throw new ImageGameError(404, "Result not found.");
      const stored = await env.DB.prepare(
        // SELECT * keeps legacy reads working before the additive migration.
        "SELECT * FROM stream_results WHERE id=?",
      )
        .bind(resultMatch[1])
        .first<StoredResultBody>();
      if (!stored)
        throw new ImageGameError(
          404,
          "Result not found. Ask the host for the downloaded result.",
        );
      return storedResultResponse(stored, request);
    }
    if (
      ![
        "/api/streams/sessions",
        "/api/streams/time",
        "/api/streams/reveal",
        "/api/streams/results",
      ].includes(path)
    )
      throw new ImageGameError(404, "Game route not found.");
    if (request.method !== "POST")
      throw new ImageGameError(405, "Method not allowed.");
    const user = await hostIdentity(request, env, now);
    if (path.endsWith("/time")) return json({ now });
    const data = await boundedBody(request);
    const service = new StreamService(source ?? preparedSource(env), env.STREAM_SIGNING_SECRET || '');
    if (path.endsWith('/sessions')) {
      if (data.transport !== 'twitch' && data.transport !== 'parallel') throw new ImageGameError(400, 'Use Twitch game transport.');
      const rounds = data.rounds === undefined ? STREAM_DEFAULT_ROUNDS : data.rounds;
      if (!validStreamRoundCount(rounds)) throw new ImageGameError(400, 'Choose 3, 5 or 10 rounds.');
      const mode = data.mode === undefined ? 'stream' : data.mode;
      if (mode !== 'stream' && mode !== 'pvp' || mode === 'pvp' && data.transport !== 'parallel') throw new ImageGameError(400, 'Invalid game settings.');
      if (data.streaming !== undefined && typeof data.streaming !== 'boolean') throw new ImageGameError(400, 'Invalid game settings.');
      const session = { ...await service.start(user, now, data.transport, rounds, { mode, streaming: data.streaming as boolean | undefined }), live: true as const };
      if (data.transport === 'parallel') {
        if (!env.STREAM_COORDINATORS) throw new ImageGameError(503, 'Durable game connections are unavailable.');
        const seconds = data.seconds === undefined ? 90 : data.seconds;
        if (typeof seconds !== 'number' || !(seconds === 0 || Number.isInteger(seconds) && seconds >= 15 && seconds <= 600)) throw new ImageGameError(400, 'Invalid round duration.');
        if (mode === 'pvp' && seconds === 0) throw new ImageGameError(400, 'Choose a round duration between 15 and 600 seconds.');
        if (env.PUBLIC_GAME_RATE_LIMIT && !(await env.PUBLIC_GAME_RATE_LIMIT.limit({ key: 'stream-create:' + user.sub })).success) throw new ImageGameError(429, 'Too many games.');
        await env.STREAM_COORDINATORS.getByName(session.id).initialize({ owner: user.sub, session,
          reveals: await service.coordinatorReveals(session.token, user, now), seconds });
      }
      return json(data.transport === 'parallel' ? { ...session, token: '', rounds: mode === 'pvp' ? [] : session.rounds.map(round => ({ ...round, token: '' })) } : session, 201);
    }
    if (path.endsWith('/reveal')) {
      const { reveal, transport } = await service.revealForRoom(data.token, user, now);
      if (transport !== 'twitch') throw new ImageGameError(410, 'This game transport has been retired.');
      return json(reveal);
    }
    const { owner, result, transport } = await service.result(data as unknown as StreamPublishWireInput, user, now);
    if (transport !== 'twitch') throw new ImageGameError(410, 'This game transport has been retired.');
    return await persistStreamResult(env, owner, result, user.ticketIssuedAt ?? now, now);
  } catch (error) {
    return json(
      {
        error:
          error instanceof ImageGameError
            ? error.message
            : "Publishing is unavailable. Your local game is safe; download the result or retry later.",
      },
      error instanceof ImageGameError ? error.status : 503,
    );
  }
}
