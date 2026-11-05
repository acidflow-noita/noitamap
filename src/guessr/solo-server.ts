/** Free demo continuation protocol. Private rounds remain authenticated and
 * encrypted in the browser; no session operation reads or writes a database.
 * Replaying an older continuation can branch a demo. These unranked results
 * are deliberately not protected by a paid replay-tracking service. */
import { scoreAreaGuess, type AreaDefinition } from "./area-rules";
import type { PreparedFrame } from "./clue-camera";
import type {
  ImageGameConfig,
  ImageGameState,
  ImageRoundResult,
} from "./image-game";
import { ImageGameError } from "./image-game-server";
import { within, type Bounds, type Point } from "./rules";

export interface SoloRoundSource {
  config(): ImageGameConfig | Promise<ImageGameConfig>;
  sampleRounds(
    count: number,
  ): Promise<
    { area: AreaDefinition; answer: Point; frames: PreparedFrame[] }[]
  >;
}

export interface SoloGameState extends ImageGameState {
  continuation: string;
}

interface SoloRound {
  id: string;
  area: AreaDefinition;
  answer: Point;
  frames: PreparedFrame[];
  submission?: { guess: Point | null; maximum: number };
}

interface Envelope {
  schemaVersion: 1;
  id: string;
  version: string;
  createdAt: number;
  expiresAt: number;
  bounds: Bounds;
  round: number;
  stage: ImageGameState["stage"];
  rounds: SoloRound[];
}

export const SOLO_TOKEN_LIMIT = 60_000;
export const SOLO_SESSION_LIFETIME = 30 * 86400000;
const MAX_PLAINTEXT_BYTES = 44_960;
const REQUEST_BYTES = 2048;
const idPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const domain = "noitamap-guessr:solo-session:v1";

function invalidToken(): never {
  throw new ImageGameError(400, "This saved demo is invalid or was changed.");
}

function encode(value: Uint8Array): string {
  let text = "";
  for (let i = 0; i < value.length; i += 8192)
    text += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidToken();
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  if (encode(bytes) !== value) invalidToken();
  return bytes;
}

function point(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const p = value as Point;
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function validBounds(value: Bounds): boolean {
  return (
    point(value) &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    Number.isFinite(value.height) &&
    value.height > 0 &&
    Number.isFinite(value.x + value.width) &&
    Number.isFinite(value.y + value.height)
  );
}

function allowance(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 5000;
}

function samePoint(a: Point | null, b: Point | null): boolean {
  return a === null || b === null ? a === b : a.x === b.x && a.y === b.y;
}

function result(round: SoloRound, ordinal: number): ImageRoundResult {
  const { guess, maximum } = round.submission!;
  const scored = scoreAreaGuess(round.area, round.answer, guess, maximum);
  return {
    ordinal,
    answer: round.answer,
    name: round.area.label,
    areaId: round.area.id,
    guess,
    score: scored.score,
    areaScore: scored.areaScore,
    positionScore: scored.positionScore,
    areaMatch: scored.areaMatch,
    difficultyTier: scored.difficultyTier,
    distance: scored.distance,
    maximum,
  };
}

export class SoloGameService {
  private readonly key: Promise<CryptoKey>;

  constructor(
    readonly source: SoloRoundSource,
    secret: string,
  ) {
    if (secret.length < 32 || secret.length > 4096)
      throw new ImageGameError(503, "Demo games are not configured.");
    this.key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode("noitamap-guessr"),
            info: encoder.encode(domain),
          },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
  }

  private async seal(game: Envelope, starting = false): Promise<string> {
    const plaintext = encoder.encode(JSON.stringify(game));
    // Reserve space at creation for all three submitted coordinates/allowances.
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES - (starting ? 1024 : 0))
      throw new ImageGameError(
        503,
        "This demo is too large to save. Start a new game.",
      );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
        additionalData: encoder.encode(`${domain}:${game.id}`),
      },
      await this.key,
      plaintext,
    );
    const token = `s1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
    if (token.length > SOLO_TOKEN_LIMIT)
      throw new ImageGameError(
        503,
        "This demo is too large to save. Start a new game.",
      );
    return token;
  }

  private validate(game: Envelope, id: string, now: number): void {
    if (
      !game ||
      game.schemaVersion !== 1 ||
      game.id !== id ||
      typeof game.version !== "string" ||
      !game.version ||
      !Number.isSafeInteger(game.createdAt) ||
      !Number.isSafeInteger(game.expiresAt) ||
      game.createdAt > now + 60000 ||
      game.expiresAt !== game.createdAt + SOLO_SESSION_LIFETIME ||
      !validBounds(game.bounds) ||
      !Number.isInteger(game.round) ||
      game.round < 0 ||
      game.round > 2 ||
      !["guess", "reveal", "complete"].includes(game.stage) ||
      (game.stage === "complete" && game.round !== 2) ||
      !Array.isArray(game.rounds) ||
      game.rounds.length !== 3
    )
      invalidToken();
    if (game.expiresAt <= now)
      throw new ImageGameError(
        410,
        "This saved demo has expired. Start a new game.",
      );
    const submitted = game.round + (game.stage === "guess" ? 0 : 1);
    const roundIds = new Set<string>();
    for (const [ordinal, round] of game.rounds.entries()) {
      if (
        !round ||
        !idPattern.test(round.id) ||
        roundIds.has(round.id) ||
        !point(round.answer) ||
        !within(round.answer, game.bounds) ||
        !round.area ||
        typeof round.area.id !== "string" ||
        typeof round.area.label !== "string" ||
        !Array.isArray(round.frames) ||
        !round.frames.length ||
        round.frames.length > 32 ||
        round.frames.some(
          (frame) =>
            !frame ||
            typeof frame.image !== "string" ||
            !frame.image ||
            frame.image.length > 1024 ||
            ![frame.x, frame.y, frame.width, frame.height].every(
              Number.isSafeInteger,
            ) ||
            frame.width <= 0 ||
            frame.height <= 0,
        ) ||
        ordinal < submitted !== !!round.submission
      )
        invalidToken();
      roundIds.add(round.id);
      if (
        round.submission &&
        (!allowance(round.submission.maximum) ||
          (round.submission.guess !== null &&
            (!point(round.submission.guess) ||
              !within(round.submission.guess, game.bounds))))
      )
        invalidToken();
      try {
        scoreAreaGuess(round.area, round.answer, null);
      } catch {
        invalidToken();
      }
    }
  }

  private async open(
    id: string,
    token: unknown,
    now: number,
  ): Promise<Envelope> {
    if (!idPattern.test(id)) throw new ImageGameError(404, "Game not found.");
    if (typeof token !== "string" || token.length > SOLO_TOKEN_LIMIT)
      invalidToken();
    let game: Envelope;
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "s1") invalidToken();
      const iv = decode(parts[1]);
      if (iv.byteLength !== 12) invalidToken();
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: 128,
          additionalData: encoder.encode(`${domain}:${id}`),
        },
        await this.key,
        decode(parts[2]),
      );
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) invalidToken();
      game = JSON.parse(decoder.decode(plaintext)) as Envelope;
    } catch {
      invalidToken();
    }
    this.validate(game, id, now);
    if ((await this.source.config()).version !== game.version)
      throw new ImageGameError(
        410,
        "This game is no longer available. Start a new game.",
      );
    return game;
  }

  private publicState(game: Envelope, continuation: string): SoloGameState {
    const current = game.rounds[game.round];
    return {
      id: game.id,
      version: game.version,
      round: game.round,
      totalRounds: 3,
      stage: game.stage,
      current:
        game.stage === "complete"
          ? null
          : {
              id: current.id,
              difficultyTier: current.area.difficultyTier ?? undefined,
              clue: { frames: current.frames },
            },
      results: game.rounds.flatMap((round, ordinal) =>
        round.submission ? [result(round, ordinal)] : [],
      ),
      continuation,
    };
  }

  async start(now = Date.now()): Promise<SoloGameState> {
    const config = await this.source.config();
    const selected = await this.source.sampleRounds(3);
    const game: Envelope = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      version: config.version,
      createdAt: now,
      expiresAt: now + SOLO_SESSION_LIFETIME,
      bounds: { ...config.bounds },
      round: 0,
      stage: "guess",
      rounds: selected.map(({ area, answer, frames }) => ({
        id: crypto.randomUUID(),
        area,
        answer: { x: answer.x, y: answer.y },
        frames: frames.map(({ image, x, y, width, height }) => ({
          image,
          x,
          y,
          width,
          height,
        })),
      })),
    };
    this.validate(game, game.id, now);
    return this.publicState(game, await this.seal(game, true));
  }

  async load(
    id: string,
    token: string,
    now = Date.now(),
  ): Promise<SoloGameState> {
    return this.publicState(await this.open(id, token, now), token);
  }

  async guess(
    id: string,
    token: string,
    roundId: unknown,
    guess: unknown,
    maximum: unknown,
    now = Date.now(),
  ): Promise<SoloGameState> {
    const game = await this.open(id, token, now);
    const round = game.rounds[game.round];
    if (game.stage === "complete" || round.id !== roundId)
      throw new ImageGameError(409, "This round has already ended.");
    if (guess !== null && (!point(guess) || !within(guess, game.bounds)))
      throw new ImageGameError(400, "Place a pin inside the map.");
    if (!allowance(maximum))
      throw new ImageGameError(400, "Invalid score allowance.");
    const pin = guess === null ? null : { x: guess.x, y: guess.y };
    if (round.submission) {
      if (
        !samePoint(round.submission.guess, pin) ||
        round.submission.maximum !== maximum
      )
        throw new ImageGameError(
          409,
          "Your submitted guess cannot be changed.",
        );
      return this.publicState(game, token);
    }
    round.submission = { guess: pin, maximum };
    game.stage = "reveal";
    return this.publicState(game, await this.seal(game));
  }

  async next(
    id: string,
    token: string,
    now = Date.now(),
  ): Promise<SoloGameState> {
    const game = await this.open(id, token, now);
    if (game.stage !== "reveal")
      throw new ImageGameError(409, "Submit the current round first.");
    if (game.round === 2) game.stage = "complete";
    else {
      game.round++;
      game.stage = "guess";
    }
    return this.publicState(game, await this.seal(game));
  }

  async review(id: string, token: string, ordinal: number, now = Date.now()) {
    const game = await this.open(id, token, now);
    const round = Number.isInteger(ordinal) ? game.rounds[ordinal] : undefined;
    if (!round?.submission)
      throw new ImageGameError(404, "Submit this round before reviewing it.");
    return {
      id: game.id,
      result: result(round, ordinal),
      clue: { frames: round.frames },
      continuation: token,
    };
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function requestBody(
  request: Request,
  allowed: string[],
): Promise<Record<string, unknown>> {
  if (
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    throw new ImageGameError(415, "Send JSON.");
  if (Number(request.headers.get("Content-Length")) > REQUEST_BYTES)
    throw new ImageGameError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ImageGameError(400, "Missing request.");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > REQUEST_BYTES) {
      await reader.cancel();
      throw new ImageGameError(413, "Request is too large.");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
  } catch {
    throw new ImageGameError(400, "Invalid JSON.");
  }
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ImageGameError(400, "Unexpected request field.");
  return value;
}

/** Origin policy and optional deployment enablement belong to the Worker. */
export async function soloGameRoute(
  request: Request,
  service: SoloGameService,
  now = Date.now(),
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/games" && !path.startsWith("/api/games/")) return null;
  try {
    if (path === "/api/games/config") {
      if (request.method !== "GET")
        throw new ImageGameError(405, "Method not allowed.");
      return json(await service.source.config());
    }
    if (path === "/api/games/sessions") {
      if (request.method !== "POST")
        throw new ImageGameError(405, "Method not allowed.");
      await requestBody(request, []);
      return json(await service.start(now), 201);
    }
    const match =
      /^\/api\/games\/sessions\/([^/]+)(?:\/(guess|next|reviews\/\d+))?$/.exec(
        path,
      );
    if (!match || !idPattern.test(match[1]))
      throw new ImageGameError(404, "Game route not found.");
    const [, id, action] = match;
    const expectedMethod =
      action === "guess" || action === "next" ? "POST" : "GET";
    if (request.method !== expectedMethod)
      throw new ImageGameError(405, "Method not allowed.");
    const token = request.headers.get("X-Guessr-State") || "";
    if (token.length > SOLO_TOKEN_LIMIT)
      throw new ImageGameError(413, "Saved demo is too large.");
    if (action === "guess") {
      const body = await requestBody(request, ["roundId", "guess", "maximum"]);
      return json(
        await service.guess(
          id,
          token,
          body.roundId,
          body.guess,
          body.maximum,
          now,
        ),
      );
    }
    if (action === "next") {
      await requestBody(request, []);
      return json(await service.next(id, token, now));
    }
    if (action?.startsWith("reviews/"))
      return json(
        await service.review(id, token, Number(action.slice(8)), now),
      );
    return json(await service.load(id, token, now));
  } catch (error) {
    return json(
      {
        error:
          error instanceof ImageGameError
            ? error.message
            : "Demo is temporarily unavailable. Please retry.",
      },
      error instanceof ImageGameError ? error.status : 503,
    );
  }
}
