import { CapacityError, capacityResponse, gameRequests, reserveFinish, cancelFinish, DAY_MS } from './capacity';
import { privateReviewReasons } from './private-review';
import { ImageGameError } from "../../../src/guessr/image-game-server";
import { preparedSource } from "./prepared-source";
import {
  StreamService,
  type StreamHostIdentity,
  type StreamRoundSource,
} from "../../../src/guessr/stream-server";
import {
  STREAM_DEFAULT_ROUNDS, STREAM_ROUND_ERROR, validStreamRoundCount,
} from "../../../src/guessr/stream-types";
import { verifyGameTicket, verifyResultManagementTicket } from "./tickets";
import type { Env } from "./index";
import { archivedClueReplay, publicStoredResultResponse, readStoredResult, type StoredResultBody } from './result-storage';
import { GAME_PROTOCOL, GAME_RELOAD_MESSAGE } from '../../../src/guessr/game-protocol';
import { storedHistorySummary } from './history-summary';
import { generatedStreamSource } from './generated-stream-source';
import { admitStreamGame, cancelStreamAdmission, StreamAdmissionError } from './stream-admission';

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
  if (Number(request.headers.get("Content-Length")) > 8192)
    throw new ImageGameError(413, "Invalid game settings.");
  const reader = request.body?.getReader();
  if (!reader) throw new ImageGameError(400, "Missing request.");
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new ImageGameError(
        413,
        "Invalid game settings.",
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

/** Game sockets coordinate play. Results are immutable D1 documents with
 * indexed, write-free public reads. */
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
    const replayMatch = /^\/api\/streams\/results\/([a-f0-9-]{36})\/rounds\/(10|[1-9])\/replays\/(\d{1,30})$/.exec(path);
    if (replayMatch && request.method === 'GET') {
      const [, game, index, player] = replayMatch, round = Number(index);
      if (!idPattern.test(game)) throw new ImageGameError(404, 'Replay unavailable');
      let replay = await archivedClueReplay(env.DB, game, round, player);
      if (replay === undefined && env.STREAM_COORDINATORS && await env.DB.prepare("SELECT id FROM stream_results WHERE id=? AND json_extract(result_json,'$.clueReplays')=1")
        .bind(game).first()) replay = await env.STREAM_COORDINATORS.getByName(game).publishedClueReplay?.(round, player) ?? null;
      if (!replay) throw new ImageGameError(404, 'Replay unavailable');
      return Response.json(replay, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }
    const reviewMatch = /^\/api\/streams\/results\/([a-f0-9-]{36})\/review$/.exec(path);
    if (reviewMatch) {
      if (!idPattern.test(reviewMatch[1])) throw new ImageGameError(404, 'Result not found.');
      if (request.method !== 'POST') throw new ImageGameError(405, 'Method not allowed.');
      const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
      const manager = await verifyResultManagementTicket(bearer, env.GAME_TICKET_PUBLIC_KEY ?? '', now);
      if (!manager) throw new ImageGameError(401, 'Sign in to view these results.');
      const stored = await env.DB.prepare(`SELECT result_json,result_gzip FROM stream_results
        WHERE id=? AND (owner=? OR host_id=?)`).bind(reviewMatch[1], manager.sub, manager.twitchUserId ?? null).first<StoredResultBody>();
      if (!stored) throw new ImageGameError(404, 'Result not found.');
      const result = await readStoredResult(stored);
      return json({ reasons: privateReviewReasons(result, request.headers.get('Accept-Language') ?? 'en') });
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
      const query = env.DB.prepare(`WITH candidates AS MATERIALIZED (SELECT id, created_at,
        json_extract(result_json, '$.finishedAt') AS finishedAt,
        COALESCE(json_extract(result_json, '$.playerCount'), json_array_length(result_json, '$.players')) AS players,
        json_extract(result_json, '$.host.name') AS hostName, result_json AS metadata, h.summary_json AS historySummary,
        CASE WHEN json_extract(result_json,'$.storage')='gzip-json-v1' AND json_type(result_json,'$.summary') IS NULL AND h.result_id IS NULL
          THEN result_gzip END AS oldPayload
        FROM stream_results LEFT JOIN stream_result_history h ON h.result_id=stream_results.id
        WHERE host_id=(SELECT twitch_id FROM stream_channels WHERE login=?)
        ${match ? 'AND (created_at, id) < (?, ?)' : ''}
        ORDER BY created_at DESC, id DESC LIMIT 21)
        SELECT * FROM (SELECT *, COUNT(*) OVER() AS available,
          ROW_NUMBER() OVER(ORDER BY created_at DESC,id DESC) AS ordinal,
          SUM(length(CAST(metadata AS BLOB))+COALESCE(length(CAST(historySummary AS BLOB)),0)+COALESCE(length(oldPayload),0))
            OVER(ORDER BY created_at DESC,id DESC) AS payloadBytes,
          SUM(CASE WHEN oldPayload IS NULL THEN 0 ELSE 1 END) OVER(ORDER BY created_at DESC,id DESC) AS missingCount FROM candidates)
        WHERE ordinal=1 OR (payloadBytes<=2097152 AND missingCount<=1) ORDER BY created_at DESC,id DESC`);
      const { results } = await query.bind(historyMatch[1], ...(match ? [Number(match[1]), match[2]] : []))
        .all<{ id: string; created_at: number; finishedAt: number; players: number; hostName: string; metadata: string; historySummary: string | null;
          available: number; ordinal: number; payloadBytes: number; missingCount: number; oldPayload: unknown }>();
      const rows = results.slice(0, 20), last = rows.at(-1);
      const games = await Promise.all(rows.map(async ({ created_at, metadata, historySummary, available, ordinal, payloadBytes, missingCount, oldPayload, ...result }) => ({
        ...result, summary: await storedHistorySummary(env.DB, result.id, { result_json: metadata, result_gzip: oldPayload }, historySummary),
      })));
      return new Response(JSON.stringify({ games,
        ...(last && (results.length > 20 || rows.length < (results[0]?.available ?? 0)) ? { next: `${last.created_at}_${last.id}` } : {}) }), {
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
      return await publicStoredResultResponse(stored, request, env.DB);
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
    if (!path.endsWith('/sessions')) throw new ImageGameError(410, 'This game transport has been retired.');
    if (data.protocol !== GAME_PROTOCOL) throw new ImageGameError(410, GAME_RELOAD_MESSAGE);
    if (path.endsWith('/sessions')) {
      if (data.transport !== 'parallel') throw new ImageGameError(410, 'This game transport has been retired.');
      const rounds = data.rounds === undefined ? STREAM_DEFAULT_ROUNDS : data.rounds;
      if (!validStreamRoundCount(rounds)) throw new ImageGameError(400, STREAM_ROUND_ERROR);
      const mode = data.mode === undefined ? 'stream' : data.mode;
      if (mode !== 'stream' && mode !== 'pvp' || mode === 'pvp' && data.transport !== 'parallel') throw new ImageGameError(400, 'Invalid game settings.');
      if (data.streaming !== undefined && typeof data.streaming !== 'boolean') throw new ImageGameError(400, 'Invalid game settings.');
      if (!env.STREAM_COORDINATORS) throw new ImageGameError(503, 'Durable game connections are unavailable.');
      const seconds = data.seconds === undefined ? 90 : data.seconds;
      if (typeof seconds !== 'number' || !(seconds === 0 || Number.isInteger(seconds) && seconds >= 15 && seconds <= 600)) throw new ImageGameError(400, 'Invalid round duration.');
      if (mode === 'pvp' && seconds === 0) throw new ImageGameError(400, 'Choose a round duration between 15 and 600 seconds.');
      if (env.PUBLIC_GAME_RATE_LIMIT && !(await env.PUBLIC_GAME_RATE_LIMIT.limit({ key: 'stream-create:' + user.sub })).success) throw new ImageGameError(429, 'Too many games.');
      const id = await admitStreamGame(env.DB, user.twitchUserId, now);
      try {
        await reserveFinish(env,id,'',gameRequests(mode,rounds),now+DAY_MS,now);
        const selected = source ? { source } : mode === 'pvp' ? { source: preparedSource(env) } : await generatedStreamSource(env, now);
        const service = new StreamService(selected.source, env.STREAM_SIGNING_SECRET || '');
        const session = { ...await service.start(user, now, data.transport, rounds, { mode, streaming: data.streaming as boolean | undefined, id }), live: true as const };
        if ('dataset' in selected) { session.dataset = selected.dataset; session.imageRoot = selected.imageRoot; }
        await env.STREAM_COORDINATORS.getByName(session.id).initialize({ owner: user.sub, session,
          reveals: await service.coordinatorReveals(session.token, user, now), seconds });
        return json({ ...session, token: '', rounds: mode === 'pvp' ? [] : session.rounds.map(round => ({ ...round, token: '', clue: { frames: [] } })) }, 201);
      } catch (error) {
        await cancelFinish(env,id,'').catch(() => {});
        await cancelStreamAdmission(env.DB, id, user.twitchUserId).catch(() => {});
        throw error;
      }
    }
    throw new ImageGameError(410, 'This game transport has been retired.');
  } catch (error) {
    if (error instanceof CapacityError) return capacityResponse(error,now);
    if (error instanceof StreamAdmissionError) {
      const limited = json({ error: error.message, quota: error.scope, resetAt: error.resetAt }, 429);
      limited.headers.set('X-Guessr-Daily-Quota', error.scope);
      limited.headers.set('X-Guessr-Reset-At', String(error.resetAt));
      limited.headers.set('Retry-After', String(Math.max(1, Math.ceil((error.resetAt - now) / 1000))));
      return limited;
    }
    return json(
      {
        error:
          error instanceof ImageGameError
            ? error.message
            : new URL(request.url).pathname.endsWith('/sessions') ? 'The game service is unavailable.'
            : "Publishing is unavailable. Your local game is safe; download the result or retry later.",
      },
      error instanceof ImageGameError ? error.status : 503,
    );
  }
}
