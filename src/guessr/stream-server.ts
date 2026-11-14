/** Server-only stateless protocol. The AES-GCM key and private round source
 * never enter a browser bundle; no session or round call writes to a database. */
import type { AreaDefinition } from "./area-rules.ts";
import type { PreparedFrame } from "./clue-camera.ts";
import type { ImageGameConfig } from "./image-game.ts";
import { ImageGameError } from "./image-game-server.ts";
import { within, type Point } from "./rules.ts";
import { rankStreamPlayers } from "./stream-ranking.ts";
import { streamPlayerName } from './stream-display-name.ts';
import { defaultStreaming, type MultiplayerMode } from './match-settings.ts';
import {
  STREAM_MAX_PLAYERS,
  STREAM_DEFAULT_ROUNDS, validStreamRoundCount,
  type StreamPlayer,
  type StreamPublishWireInput,
  type StreamReveal,
  type StreamSession,
  type StreamPublishedResult,
} from "./stream-types.ts";

export interface StreamRoundSource {
  config(): ImageGameConfig | Promise<ImageGameConfig>;
  sampleRounds(
    count: number,
  ): Promise<
    { area: AreaDefinition; answer: Point; frames: PreparedFrame[] }[]
  >;
}
export interface StreamHostIdentity {
  sub: string;
  twitchUserId: string;
  twitchLogin: string;
  name: string;
  /** Set only after verification of the host's Pro game JWT. Epoch milliseconds. */
  hostProVerifiedUntil?: number;
  ticketIssuedAt?: number;
}
interface Envelope {
  mode?: MultiplayerMode;
  streaming?: boolean;
  transport?: 'twitch' | 'parallel';
  kind: "session" | "round";
  owner: string;
  id: string;
  version: string;
  createdAt: number;
  expiresAt: number;
  host: StreamPlayer;
  config: ImageGameConfig;
  reveals: StreamReveal[];
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const aad = encoder.encode("noitamap-guessr-stream-v1");
function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export class StreamService {
  private key: Promise<CryptoKey>;
  constructor(
    private source: StreamRoundSource,
    secret: string,
  ) {
    if (secret.length < 32)
      throw new ImageGameError(503, "Stream rounds are not configured.");
    this.key = crypto.subtle
      .digest("SHA-256", encoder.encode("stream:" + secret))
      .then((bytes) =>
        crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      );
  }
  private async seal(value: Envelope): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        await this.key,
        encoder.encode(JSON.stringify(value)),
      ),
    );
    return encode(iv) + "." + encode(bytes);
  }
  private async open(
    token: unknown,
    user: StreamHostIdentity,
    kind: Envelope["kind"],
    now: number,
  ): Promise<Envelope> {
    if (typeof token !== "string" || token.length > 150000)
      throw new ImageGameError(400, "Invalid stream token.");
    let value: Envelope;
    try {
      const parts = token.split(".");
      if (parts.length !== 2 || !parts.every((p) => /^[\w-]+$/.test(p)))
        throw Error();
      const bytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(parts[0]).buffer as ArrayBuffer,
          additionalData: aad,
        },
        await this.key,
        decode(parts[1]).buffer as ArrayBuffer,
      );
      value = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new ImageGameError(
        400,
        "This stream token is invalid or was changed.",
      );
    }
    if (
      value.kind !== kind ||
      value.owner !== user.sub ||
      value.host.id !== user.twitchUserId
    )
      throw new ImageGameError(403, "Sign in as the host of this game.");
    if (value.expiresAt <= now)
      throw new ImageGameError(
        410,
        "This saved stream session has expired. Completed results can still be downloaded.",
      );
    return value;
  }
  async start(
    user: StreamHostIdentity,
    now = Date.now(),
    transport?: 'twitch' | 'parallel',
    roundCount = STREAM_DEFAULT_ROUNDS,
    settings: { mode?: MultiplayerMode; streaming?: boolean } = {},
  ): Promise<StreamSession> {
    if (!validStreamRoundCount(roundCount)) throw new ImageGameError(400, 'Choose 3, 5 or 10 rounds.');
    if (settings.mode !== undefined && settings.mode !== 'stream' && settings.mode !== 'pvp'
      || settings.streaming !== undefined && typeof settings.streaming !== 'boolean') throw new ImageGameError(400, 'Invalid game settings.');
    const mode = settings.mode ?? 'stream', streaming = settings.streaming ?? defaultStreaming(mode);
    const started = performance.now();
    const config = await this.source.config(),
      selected = await this.source.sampleRounds(roundCount);
    const id = crypto.randomUUID(),
      expiresAt = now + (mode === 'pvp' ? 30 * 60000 : 30 * 86400000);
    const host = {
      id: user.twitchUserId,
      login: user.twitchLogin,
      name: streamPlayerName(user.name, user.twitchLogin),
    };
    const reveals = selected.map((r) => ({
      roundId: crypto.randomUUID(),
      answer: r.answer,
      area: r.area,
    }));
    const envelope: Envelope = {
      mode, streaming,
      ...(transport ? { transport } : {}),
      kind: "session",
      owner: user.sub,
      id,
      version: config.version,
      createdAt: now,
      expiresAt,
      host,
      config,
      reveals,
    };
    const rounds = await Promise.all(
      selected.map(async (r, index) => ({
        id: reveals[index].roundId,
        clue: { frames: r.frames },
        difficultyTier: r.area.difficultyTier ?? undefined,
        token: await this.seal({
          ...envelope,
          kind: "round",
          reveals: [reveals[index]],
        }),
      })),
    );
    return {
      mode, streaming,
      ...(transport ? { transport } : {}),
      id,
      version: config.version,
      createdAt: now,
      expiresAt,
      host,
      ...(user.hostProVerifiedUntil === undefined ? {} : { hostProVerifiedUntil: user.hostProVerifiedUntil }),
      config,
      rounds,
      token: await this.seal(envelope),
      serverNow: now + Math.max(0, Math.round(performance.now() - started)),
    };
  }
  /** Internal coordinator initialization, never a browser response. */
  async coordinatorReveals(token: string, user: StreamHostIdentity, now = Date.now()): Promise<StreamReveal[]> {
    return (await this.open(token, user, 'session', now)).reveals;
  }
  async reveal(
    token: unknown,
    user: StreamHostIdentity,
    now = Date.now(),
  ): Promise<StreamReveal> {
    return (await this.revealForRoom(token, user, now)).reveal;
  }
  async revealForRoom(token: unknown, user: StreamHostIdentity, now = Date.now()) {
    const envelope = await this.open(token, user, "round", now);
    return { gameId: envelope.id, reveal: envelope.reveals[0], config: envelope.config, transport: envelope.transport };
  }
  async result(
    input: StreamPublishWireInput,
    user: StreamHostIdentity,
    now = Date.now(),
  ) {
    const envelope = await this.open(input.token, user, "session", now);
    if (
      !Number.isSafeInteger(input.finishedAt) ||
      input.finishedAt < envelope.createdAt ||
      input.finishedAt > now + 60000
    )
      throw new ImageGameError(400, "Invalid completion time.");
    if (
      !Array.isArray(input.players) ||
      !input.players.length ||
      input.players.length > STREAM_MAX_PLAYERS
    )
      throw new ImageGameError(
        413,
        `Cloud publication supports up to ${STREAM_MAX_PLAYERS.toLocaleString()} players. Download the complete result instead.`,
      );
    const ids = new Set<string>();
    const players = input.players.map((player) => {
      if (
        !player ||
        typeof player.id !== "string" ||
        !/^\d{1,30}$/.test(player.id) ||
        ids.has(player.id) ||
        typeof player.name !== "string" ||
        player.name.length > 512 ||
        typeof player.login !== "string" ||
        !/^[a-z0-9_]{1,25}$/.test(player.login) ||
        !Array.isArray(player.rounds) ||
        player.rounds.length !== envelope.reveals.length
      )
        throw new ImageGameError(400, "Invalid result participant.");
      ids.add(player.id);
      const rounds = player.rounds.map((round, index): [number, number] => {
        const budget = envelope.reveals[index].area.scoring!;
        if (
          !Array.isArray(round) ||
          round.length !== 2 ||
          !Number.isInteger(round[0]) ||
          !Number.isInteger(round[1]) ||
          round[0] < 0 ||
          round[0] > budget.area ||
          round[1] < 0 ||
          round[1] > budget.position ||
          round[0] + round[1] > 5000
        )
          throw new ImageGameError(
            400,
            "Invalid round score or component total.",
          );
        return [round[0], round[1]];
      });
      const score = rounds.reduce((sum, round) => sum + round[0] + round[1], 0);
      if (!Number.isInteger(player.score) || player.score !== score)
        throw new ImageGameError(400, "Invalid player total.");
      return {
        id: player.id,
        login: player.login,
        name: streamPlayerName(player.name, player.login),
        ...(typeof player.color === 'string' && /^#[a-f0-9]{6}$/i.test(player.color) ? { color: player.color.toUpperCase() } : {}),
        rounds,
        score,
      };
    });
    if (!ids.has(envelope.host.id))
      throw new ImageGameError(
        400,
        "The streamer must be included in the results.",
      );
    const host = players.find((player) => player.id === envelope.host.id)!;
    const currentHost = { id: envelope.host.id, login: user.twitchLogin,
      name: streamPlayerName(user.name, user.twitchLogin) };
    host.name = currentHost.name;
    host.login = currentHost.login;
    let positions: StreamPublishedResult['positions'];
    // Review coordinates are optional. Malformed review data must not discard
    // otherwise valid scores, and only known players/in-bounds points survive.
    if (input.positions && typeof input.positions === 'object' && !Array.isArray(input.positions)) {
      const safe: NonNullable<StreamPublishedResult['positions']> = {};
      for (const id of ids) {
        const points = input.positions[id];
        if (Array.isArray(points) && points.length === envelope.reveals.length && points.every(point => point === null
          || Array.isArray(point) && point.length === 2 && within({ x: point[0], y: point[1] }, envelope.config.bounds))) safe[id] = points;
      }
      if (Object.keys(safe).length) positions = safe;
    }
    // Chat delivery and assistance are intentionally host-reported. The browser
    // uses the shared exact scorer; this bounded endpoint validates the summary
    // and identity without rerunning thousands of geometry tests on Workers Free.
    const result: StreamPublishedResult = {
      format: "compact-scores-v1",
      schema: 1,
      id: envelope.id,
      version: envelope.version,
      createdAt: envelope.createdAt,
      finishedAt: input.finishedAt,
      host: currentHost,
      config: envelope.config,
      ...(positions ? { positions } : {}),
      rounds: envelope.reveals.map((round) => ({
        id: round.roundId,
        answer: round.answer,
        name: round.area.label,
        difficultyTier: round.area.difficultyTier!,
      })),
      players: rankStreamPlayers(players),
    };
    return { owner: envelope.owner, result, transport: envelope.transport };
  }
}
