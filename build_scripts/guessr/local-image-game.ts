/** Local development adapter. Public images are served separately; private
 * catalog and session files never pass through a static asset route. */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ImageGameError,
  ImageGameService,
  framesForPoint,
  type PrivateImageGame,
  type PrivateImageSet,
} from "../../src/guessr/image-game-server.ts";
import type { AreaDefinition } from "../../src/guessr/area-rules.ts";
import { StreamService } from "../../src/guessr/stream-server.ts";
import {
  STREAM_MAX_DOCUMENT_BYTES,
  type StreamPublishWireInput,
  type StreamPublishedResult,
} from "../../src/guessr/stream-types.ts";
import { LocalLiveRooms } from './local-live-room.ts';
import { liveRoomGame } from '../../src/guessr/live-room-game.ts';
import { liveRoomErrorMessage, liveRoomErrorStatus } from '../../src/guessr/live-room-core.ts';
import { prepareStreamRoundOutcome } from '../../src/guessr/stream-outcome.ts';

export async function loadLocalImageGame(
  root: string,
): Promise<ImageGameService> {
  const directory = resolve(root, "task/guessr/private/image-games");
  const [index, inventory] = (await Promise.all([
    readFile(resolve(root, "task/guessr/private/image-set.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(
      resolve(root, "task/guessr/area-inventory/inventory.json"),
      "utf8",
    ).then(JSON.parse),
  ])) as [
    PrivateImageSet,
    { capture: { sha256: string }; puzzleAreas: AreaDefinition[] },
  ];
  if (inventory.capture.sha256 !== index.capture.sha256)
    throw new Error(
      "The area masks and prepared images must use the same captured map.",
    );
  await mkdir(directory, { recursive: true });
  return new ImageGameService(index, inventory.puzzleAreas, {
    async get(id) {
      try {
        return JSON.parse(
          await readFile(resolve(directory, id + ".json"), "utf8"),
        );
      } catch (error: any) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(game: PrivateImageGame) {
      const target = resolve(directory, game.id + ".json"),
        temp = target + "." + crypto.randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(game), { flag: "wx" });
      await rename(temp, target);
    },
  });
}

export function localImageGameMiddleware(root: string, rooms = new LocalLiveRooms(root)) {
  let ready: Promise<ImageGameService> | undefined;
  const pending = new Map<string, Promise<unknown>>();
  const get = () =>
    (ready ??= loadLocalImageGame(root).catch((error) => {
      ready = undefined;
      throw error;
    }));
  const streamDirectory = resolve(root, "task/guessr/private/stream-games");
  const simulatedHost = {
    sub: "account:local-streamer",
    twitchUserId: "900000000",
    twitchLogin: "local_streamer",
    name: "Local streamer",
  };
  let streamReady: Promise<StreamService> | undefined;
  const streams = () =>
    (streamReady ??= (async () => {
      await mkdir(streamDirectory, { recursive: true });
      const keyPath = resolve(streamDirectory, "secret.key");
      let secret: string;
      try {
        secret = await readFile(keyPath, "utf8");
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        secret = crypto.randomUUID() + crypto.randomUUID();
        try {
          await writeFile(keyPath, secret, { flag: "wx", mode: 0o600 });
        } catch (error: any) {
          if (error.code !== "EEXIST") throw error;
          secret = await readFile(keyPath, "utf8");
        }
      }
      return new StreamService(
        {
          async config() {
            return (await get()).config();
          },
          async sampleRounds(count) {
            const service = await get();
            return service.selectRounds(count).map((round) => ({
              area: service.roundArea(round),
              answer: round.answer,
              frames: framesForPoint(
                service.index,
                round.answer,
                service.imageRoot,
              ),
            }));
          },
        },
        secret,
      );
    })().catch((error) => {
      streamReady = undefined;
      throw error;
    }));
  return async (req: any, res: any) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    try {
      if (!["GET", "POST"].includes(req.method))
        return send(405, { error: "Method not allowed." });
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        return send(403, { error: "Use the game on this origin." });
      const path = new URL(req.url, "http://local").pathname;
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        let text = "",
          size = 0;
        const decoder = new TextDecoder();
        for await (const chunk of req) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += bytes.byteLength;
          if (
            size >
            (path.startsWith("/stream/") ? STREAM_MAX_DOCUMENT_BYTES : 4096)
          )
            throw new ImageGameError(413, "Request too large.");
          text += decoder.decode(bytes, { stream: true });
        }
        text += decoder.decode();
        try {
          body = JSON.parse(text);
        } catch {
          throw new ImageGameError(400, "Invalid JSON.");
        }
        if (!body || Array.isArray(body) || typeof body !== "object")
          throw new ImageGameError(400, "Invalid request.");
      }
      if (path.startsWith("/stream/")) {
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(
            new URL("http://" + req.headers.host).hostname,
          )
        )
          throw new ImageGameError(
            403,
            "The simulated stream host is available only on localhost.",
          );
        if (path === "/stream/time" && req.method === "POST")
          return send(200, { now: Date.now() });
        if (body.localChannel !== undefined && (typeof body.localChannel !== 'string' || !/^[a-z0-9_]{1,25}$/.test(body.localChannel)))
          throw new ImageGameError(400, 'Invalid local Twitch channel.');
        const localHost = body.localChannel ? {
          ...simulatedHost, sub: 'account:local-twitch-' + body.localChannel,
          twitchLogin: body.localChannel as string, name: body.localChannel + ' (test host)',
        } : simulatedHost;
        const service = await streams();
        const room = rooms.getByName(localHost.twitchLogin);
        if (path === "/stream/sessions" && req.method === "POST") {
          const session = await service.start(localHost, Date.now(), body.transport === 'twitch' ? 'twitch' : undefined,
            typeof body.rounds === 'number' ? body.rounds : undefined);
          if (session.transport !== 'twitch') await room.start(localHost.sub, liveRoomGame(session, (await get()).imageRoot));
          return send(201, { ...session, live: true, ...(body.localChannel ? { localChat: true } : {}) });
        }
        if (path === "/stream/reveal" && req.method === "POST") {
          const { gameId, reveal, config, transport } = await service.revealForRoom(body.token, localHost);
          if (transport === 'twitch') return send(200, reveal);
          const outcome = prepareStreamRoundOutcome(reveal, body.submissions, config.bounds);
          await room.reveal(localHost.sub, gameId, reveal.roundId, outcome);
          return send(200, reveal);
        }
        if (["/stream/advance", "/stream/pulse", "/stream/pause", "/stream/quit"].includes(path) && req.method === "POST") {
          if (typeof body.gameId !== 'string') throw new ImageGameError(400, 'Invalid game.');
          if (path === '/stream/pulse') return send(200, await room.pulse(localHost.sub, body.gameId));
          if (path === '/stream/quit') return send(200, await room.quit(localHost.sub, body.gameId));
          if (path === '/stream/pause') {
            if (typeof body.paused !== 'boolean') throw new ImageGameError(400, 'Invalid pause.');
            return send(200, await room.pause(localHost.sub, body.gameId, body.paused));
          }
          if (typeof body.roundId !== 'string') throw new ImageGameError(400, 'Invalid round.');
          return send(200, await room.advance(localHost.sub, body.gameId, body.roundId));
        }
        const historyPath = path.match(/^\/stream\/history\/([a-z0-9_]{1,25})$/);
        if (historyPath && req.method === 'GET') {
          const files = (await readdir(streamDirectory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file));
          const games = (await Promise.all(files.map(async file => JSON.parse(await readFile(resolve(streamDirectory, file), 'utf8')) as StreamPublishedResult)))
            .filter(result => result.host.login === historyPath[1]).sort((a, b) => b.finishedAt - a.finishedAt)
            .map(result => ({ id: result.id, finishedAt: result.finishedAt, players: result.players.length, hostName: result.host.name }));
          return send(200, { games });
        }
        const resultPath = path.match(/^\/stream\/results\/([a-f0-9-]{36})$/);
        if (resultPath && req.method === "GET") {
          try {
            return send(
              200,
              JSON.parse(
                await readFile(
                  resolve(streamDirectory, resultPath[1] + ".json"),
                  "utf8",
                ),
              ),
            );
          } catch (error: any) {
            if (error.code === "ENOENT")
              throw new ImageGameError(404, "Result not found.");
            throw error;
          }
        }
        if (path === "/stream/results" && req.method === "POST") {
          const { result, transport } = await service.result(
            body as unknown as StreamPublishWireInput,
            localHost,
          );
          const document = JSON.stringify(result);
          if (Buffer.byteLength(document) > STREAM_MAX_DOCUMENT_BYTES)
            throw new ImageGameError(
              413,
              "Result too large to publish. Download it instead.",
            );
          const file = resolve(streamDirectory, result.id + ".json");
          try {
            await writeFile(file, document, { flag: "wx" });
          } catch (error: any) {
            if (error.code !== "EEXIST") throw error;
            if ((await readFile(file, "utf8")) !== document)
              throw new ImageGameError(
                409,
                "This game already has an immutable published result.",
              );
          }
          if (transport !== 'twitch') await room.publish(localHost.sub, result.id, result).catch(() => {});
          return send(200, { id: result.id, published: true });
        }
        return send(404, { error: "Stream route not found." });
      }
      const service = await get();
      if (path === "/config" && req.method === "GET")
        return send(200, service.config());
      if (path === "/sessions" && req.method === "POST")
        return send(201, await service.start());
      const review = path.match(
        /^\/sessions\/([a-f0-9-]{36})\/reviews\/([0-2])$/,
      );
      if (review && req.method === "GET")
        return send(200, await service.review(review[1], Number(review[2])));
      const match = path.match(
        /^\/sessions\/([a-f0-9-]{36})(?:\/(guess|next))?$/,
      );
      if (!match) return send(404, { error: "Game route not found." });
      const [, id, action] = match;
      const previous = pending.get(id) ?? Promise.resolve();
      const work = previous
        .catch(() => {})
        .then(async () => {
          if (!action && req.method === "GET")
            return service.publicState(await service.load(id));
          if (action === "next" && req.method === "POST")
            return service.next(id);
          if (action === "guess" && req.method === "POST") {
            if (
              typeof body.roundId !== "string" ||
              !Object.hasOwn(body, "guess")
            )
              throw new ImageGameError(400, "Invalid guess.");
            return service.guess(
              id,
              body.roundId,
              body.guess as any,
              body.maximum as number,
            );
          }
          throw new ImageGameError(405, "Method not allowed.");
        });
      pending.set(id, work);
      try {
        send(200, await work);
      } finally {
        if (pending.get(id) === work) pending.delete(id);
      }
    } catch (error) {
      if (error instanceof ImageGameError)
        send(error.status, { error: error.message });
      else if (liveRoomErrorStatus(error))
        send(liveRoomErrorStatus(error)!, { error: liveRoomErrorMessage(error) });
      else {
        console.error("[Guessr] Local round service:", error);
        send(503, {
          error:
            "Prepared game data is unavailable. Run the whole-map image export and area inventory preparation.",
        });
      }
    }
  };
}
