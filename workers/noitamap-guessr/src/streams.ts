import { ImageGameError } from "../../../src/guessr/image-game-server";
import { createPreparedRoundSource } from "../../../src/guessr/prepared-rounds";
import {
  StreamService,
  type StreamHostIdentity,
  type StreamRoundSource,
} from "../../../src/guessr/stream-server";
import {
  STREAM_MAX_DOCUMENT_BYTES,
  type StreamPublishWireInput,
} from "../../../src/guessr/stream-types";
import { verifyGameTicket } from "./tickets";
import type { Env } from "./index";
import { liveRoomGame } from "../../../src/guessr/live-room-game";
import { liveRoomErrorStatus, liveRoomErrorMessage } from "../../../src/guessr/live-room-core";
import { prepareStreamRoundOutcome } from "../../../src/guessr/stream-outcome";

export const STREAM_STORED_GAME_CAP = 200;
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
        env.GAME_SIGNING_SECRET || "",
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
  };
}
interface StoredResult {
  owner: string;
  digest: string;
  result_json: string;
}
/** This branch deliberately never calls the legacy admit() request counters.
 * Room transitions use the per-channel object; publication writes ONE D1 document.
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
    const roomMatch = /^\/api\/streams\/rooms\/([a-z0-9_]{1,25})$/.exec(path);
    if (roomMatch && request.method === "GET") {
      const origin = request.headers.get("Origin");
      if (!origin || !env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).includes(origin))
        throw new ImageGameError(403, "Use the game on an allowed origin.");
      if (!env.LIVE_ROOMS) throw new ImageGameError(503, "Live rooms are not configured.");
      const url = new URL(request.url);
      url.searchParams.set("channel", roomMatch[1]);
      return await env.LIVE_ROOMS.getByName(roomMatch[1]).fetch(new Request(url, request));
    }
    const resultMatch = /^\/api\/streams\/results\/([^/]+)$/.exec(path);
    if (resultMatch && request.method === "GET") {
      if (!idPattern.test(resultMatch[1]))
        throw new ImageGameError(404, "Result not found.");
      const stored = await env.DB.prepare(
        "SELECT result_json FROM stream_results WHERE id=?",
      )
        .bind(resultMatch[1])
        .first<{ result_json: string }>();
      if (!stored)
        throw new ImageGameError(
          404,
          "Result not found. Ask the host for the downloaded result.",
        );
      return new Response(stored.result_json, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (
      ![
        "/api/streams/sessions",
        "/api/streams/time",
        "/api/streams/reveal",
        "/api/streams/results",
        "/api/streams/advance",
        "/api/streams/pulse",
        "/api/streams/pause",
        "/api/streams/quit",
      ].includes(path)
    )
      throw new ImageGameError(404, "Game route not found.");
    if (request.method !== "POST")
      throw new ImageGameError(405, "Method not allowed.");
    const user = await hostIdentity(request, env, now);
    if (path.endsWith("/time")) return json({ now });
    const data = await boundedBody(request);
    // Existing open tabs may finish their older games. New Twitch sessions do
    // not construct an object, open a socket, pulse or write round state.
    const room = () => {
      if (!env.LIVE_ROOMS) throw new ImageGameError(503, "Live rooms are not configured.");
      return env.LIVE_ROOMS.getByName(user.twitchLogin);
    };
    if (["/advance", "/pulse", "/pause", "/quit"].some(action => path.endsWith(action))) {
      if (typeof data.gameId !== "string" || !idPattern.test(data.gameId))
        throw new ImageGameError(400, "Invalid game.");
      if (path.endsWith("/pulse")) return json(await room().pulse(user.sub, data.gameId, user.hostProVerifiedUntil));
      if (path.endsWith("/quit")) return json(await room().quit(user.sub, data.gameId));
      if (path.endsWith("/pause")) {
        if (typeof data.paused !== "boolean") throw new ImageGameError(400, "Invalid pause.");
        return json(await room().pause(user.sub, data.gameId, data.paused));
      }
      if (typeof data.roundId !== "string" || !idPattern.test(data.roundId))
        throw new ImageGameError(400, "Invalid round.");
      return json(await room().advance(user.sub, data.gameId, data.roundId));
    }
    const service = new StreamService(
      source ??
        createPreparedRoundSource(
          (path) =>
            env.ASSETS.fetch(new Request("https://private.invalid" + path)),
          env.STREAM_IMAGE_ROOT || "https://guessr-tiles.sage-data.xyz/images",
          env.STREAM_REFERENCE_ROOT ||
            "https://guessr-map.sage-data.xyz/map_files/",
        ),
      env.STREAM_SIGNING_SECRET || "",
    );
    if (path.endsWith("/sessions")) {
      const session = await service.start(user, now, data.transport === 'twitch' ? 'twitch' : undefined);
      if (session.transport !== 'twitch') await room().start(user.sub, liveRoomGame(session, env.STREAM_IMAGE_ROOT || "https://guessr-tiles.sage-data.xyz/images"));
      return json({ ...session, live: true }, 201);
    }
    if (path.endsWith("/reveal")) {
      const { gameId, reveal, config, transport } = await service.revealForRoom(data.token, user, now);
      if (transport === 'twitch') return json(reveal);
      const outcome = prepareStreamRoundOutcome(reveal, data.submissions, config.bounds);
      // Close durably before returning an answer, even if the HTTP response is lost.
      await room().reveal(user.sub, gameId, reveal.roundId, outcome);
      return json(reveal);
    }
    const { owner, result, transport } = await service.result(
      data as unknown as StreamPublishWireInput,
      user,
      now,
    );
    const serialized = JSON.stringify(result),
      bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength > STREAM_MAX_DOCUMENT_BYTES)
      throw new ImageGameError(
        413,
        "Result is too large to publish. Download the complete result instead.",
      );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    const notifyRoom = async () => {
      if (transport === 'twitch') return;
      try { await room().publish(user.sub, result.id, result); }
      catch (error) {
        // Older immutable results remain publishable while a newer game is live.
        if (liveRoomErrorStatus(error) !== 409 || liveRoomErrorMessage(error) !== "This game is no longer active.")
          throw error;
      }
    };
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
      await notifyRoom();
      return json({ id: result.id, published: true });
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const inserted = await env.DB.prepare(
      "INSERT INTO stream_results(id,owner,day,created_at,bytes,digest,result_json) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM stream_results) < ? AND (SELECT COUNT(*) FROM stream_results WHERE day=?) < ? AND (SELECT COUNT(*) FROM stream_results WHERE owner=? AND day=?) < ? ON CONFLICT(id) DO NOTHING RETURNING id",
    )
      .bind(
        result.id,
        owner,
        day,
        now,
        bytes.byteLength,
        digest,
        serialized,
        STREAM_STORED_GAME_CAP,
        day,
        STREAM_DAILY_PUBLISH_CAP,
        owner,
        day,
        STREAM_HOST_DAILY_CAP,
      )
      .first();
    if (!inserted) {
      const concurrent = await env.DB.prepare(
        "SELECT owner,digest FROM stream_results WHERE id=?",
      )
        .bind(result.id)
        .first<StoredResult>();
      if (concurrent?.owner === owner && concurrent.digest === digest) {
        await notifyRoom();
        return json({ id: result.id, published: true });
      }
      if (concurrent)
        throw new ImageGameError(
          409,
          "This game already has an immutable published result.",
        );
      throw new ImageGameError(
        429,
        "Free result storage has reached its limit. Your result is saved locally; download it to share.",
      );
    }
    // A newer game can already be running; the immutable older result still stands.
    await notifyRoom();
    return json({ id: result.id, published: true }, 201);
  } catch (error) {
    return json(
      {
        error:
          error instanceof ImageGameError
            ? error.message
            : liveRoomErrorStatus(error) ? liveRoomErrorMessage(error)
            : "Publishing is unavailable. Your local game is safe; download the result or retry later.",
      },
      error instanceof ImageGameError ? error.status : liveRoomErrorStatus(error) ?? 503,
    );
  }
}
