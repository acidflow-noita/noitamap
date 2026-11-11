import { ImageGameError } from "../../../src/guessr/image-game-server";
import { preparedSource } from "./prepared-source";
import {
  StreamService,
  type StreamHostIdentity,
  type StreamRoundSource,
} from "../../../src/guessr/stream-server";
import {
  STREAM_MAX_DOCUMENT_BYTES,
  type StreamPublishWireInput,
} from "../../../src/guessr/stream-types";
import { verifyGameTicket, verifyResultManagementTicket } from "./tickets";
import type { Env } from "./index";
import { encodeStoredResult, storedResultResponse, STREAM_STORAGE_BUDGET_BYTES, STREAM_RESULT_OVERHEAD_BYTES, type StoredResultBody } from './result-storage';

export const STREAM_DAILY_PUBLISH_CAP = 100;
export const STREAM_HOST_DAILY_CAP = 20;
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
interface StoredResult {
  owner: string;
  digest: string;
  result_json: string;
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
      if (data.transport !== 'twitch') throw new ImageGameError(400, 'Use Twitch game transport.');
      return json({ ...await service.start(user, now, 'twitch'), live: true }, 201);
    }
    if (path.endsWith('/reveal')) {
      const { reveal, transport } = await service.revealForRoom(data.token, user, now);
      if (transport !== 'twitch') throw new ImageGameError(410, 'This game transport has been retired.');
      return json(reveal);
    }
    const { owner, result, transport } = await service.result(data as unknown as StreamPublishWireInput, user, now);
    if (transport !== 'twitch') throw new ImageGameError(410, 'This game transport has been retired.');
    const serialized = JSON.stringify(result),
      bytes = new TextEncoder().encode(serialized);
    // Host names/logins may change between an upload and its retry. Identity
    // and reported scores determine idempotency; mutable host labels do not.
    const canonical = new TextEncoder().encode(JSON.stringify({ ...result, host: { id: result.host.id },
      players: result.players.map(p => p.id === result.host.id ? { ...p, name: '', login: '' } : p) }));
    if (await env.DB.prepare('SELECT id FROM stream_result_removals WHERE id=?').bind(result.id).first())
      throw new ImageGameError(410, 'This published result was removed.');
    if (bytes.byteLength > STREAM_MAX_DOCUMENT_BYTES)
      throw new ImageGameError(
        413,
        "Result is too large to publish. Download the complete result instead.",
      );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    const existing = await env.DB.prepare(
      "SELECT owner,digest FROM stream_results WHERE id=?",
    )
      .bind(result.id)
      .first<StoredResult>();
    if (existing) {
      if (existing.owner !== owner || existing.digest !== digest)
        throw new ImageGameError(
          409,
          "This game already has an immutable published result.",
        );
      return json({ id: result.id, published: true });
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const encoded = await encodeStoredResult(result, serialized, bytes);
    const inserted = await env.DB.prepare(
      "INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json,result_gzip,host_id,host_verified_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM stream_result_removals WHERE id=?) AND (SELECT used_bytes FROM stream_result_storage WHERE id=1)+? <= ? AND (SELECT COUNT(*) FROM stream_results WHERE day=?) < ? AND (SELECT COUNT(*) FROM stream_results WHERE owner=? AND day=?) < ? ON CONFLICT(id) DO NOTHING RETURNING id",
    )
      .bind(
        result.id,
        owner,
        day,
        now,
        encoded.bytes,
        digest,
        encoded.json,
        encoded.gzip,
        result.host.id,
        user.ticketIssuedAt ?? now,
        result.id,
        encoded.bytes + STREAM_RESULT_OVERHEAD_BYTES,
        STREAM_STORAGE_BUDGET_BYTES,
        day,
        STREAM_DAILY_PUBLISH_CAP,
        owner,
        day,
        STREAM_HOST_DAILY_CAP,
      )
      .first();
    if (!inserted) {
      if (await env.DB.prepare('SELECT id FROM stream_result_removals WHERE id=?').bind(result.id).first())
        throw new ImageGameError(410, 'This published result was removed.');
      const concurrent = await env.DB.prepare(
        "SELECT owner,digest FROM stream_results WHERE id=?",
      )
        .bind(result.id)
        .first<StoredResult>();
      if (concurrent?.owner === owner && concurrent.digest === digest) {
          return json({ id: result.id, published: true });
      }
      if (concurrent)
        throw new ImageGameError(
          409,
          "This game already has an immutable published result.",
        );
      const storage = await env.DB.prepare('SELECT used_bytes FROM stream_result_storage WHERE id=1').first<{ used_bytes: number }>();
      if (!storage) throw new Error('Result storage accounting is unavailable.');
      if (storage.used_bytes + encoded.bytes + STREAM_RESULT_OVERHEAD_BYTES <= STREAM_STORAGE_BUDGET_BYTES) {
        const response = json({ error: 'Today’s result publishing limit has been reached. Please try again later.' }, 429);
        response.headers.set('Retry-After', String(Math.max(1, Math.ceil((Date.parse(day) + 86400000 - now) / 1000))));
        return response;
      }
      throw new ImageGameError(
        507,
        'Result storage is full. Download your result to keep a copy.',
      );
    }
    return json({ id: result.id, published: true }, 201);
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
