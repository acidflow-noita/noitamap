/** Public round protocol. Hidden target coordinates and the global image index
 * have no representation in an active clue. Answers appear only in results. */
import type { Bounds, Pack, Point } from "./rules";
import type { ClueSource } from "./clue-camera";
import { gameApiOrigin } from './api-origin';

export interface ImageGameConfig {
  version: string;
  bounds: Bounds;
  overview: string;
  map: NonNullable<Pack["map"]>;
}
export interface ImageRoundResult {
  ordinal: number;
  answer: Point;
  name: string;
  areaId: string;
  guess: Point | null;
  score: number;
  areaScore: number;
  positionScore: number;
  areaMatch: boolean;
  distance: number | null;
  maximum: number;
  difficultyTier: "easy" | "normal" | "hard";
}
export interface ImageGameState {
  id: string;
  version: string;
  round: number;
  totalRounds: number;
  stage: "guess" | "reveal" | "complete";
  current: { id: string; clue: ClueSource } | null;
  results: ImageRoundResult[];
}

const CONTINUATION_KEY = "noitamap-guessr-continuations-v1";
const TOKEN_LIMIT = 60_000;
const CACHE_LIMIT = 1_000_000;
const CACHE_GAMES = 30;
const CACHE_LIFETIME = 30 * 86400000;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const sessionPath = new RegExp(
  `^/sessions/(${uuid})(?:/(guess|next|reviews/[0-2]))?$`,
);
const tokenPattern = /^s1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;

interface Continuation {
  id: string;
  source: string;
  token: string;
  at: number;
  pending?: { path: string; body: string };
}

// Memory fallback keeps the current tab playable when browser storage is full.
let continuations: Continuation[] | undefined;
const inFlight = new Map<string, Promise<unknown>>();

function readContinuations(): Continuation[] {
  if (continuations) return continuations;
  continuations = [];
  try {
    const raw = localStorage.getItem(CONTINUATION_KEY);
    if (!raw || raw.length > CACHE_LIMIT) return continuations;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return continuations;
    const now = Date.now();
    continuations = parsed
      .filter((entry): entry is Continuation => {
        if (!entry || typeof entry !== "object") return false;
        const value = entry as Continuation;
        if (
          typeof value.id !== "string" ||
          !new RegExp(`^${uuid}$`).test(value.id) ||
          typeof value.source !== "string" ||
          value.source.length > 1024 ||
          typeof value.token !== "string" ||
          value.token.length > TOKEN_LIMIT ||
          !tokenPattern.test(value.token) ||
          !Number.isSafeInteger(value.at) ||
          value.at > now + 60000 ||
          value.at < now - CACHE_LIFETIME
        )
          return false;
        if (!value.pending) return true;
        const pending = value.pending;
        return (
          typeof pending.path === "string" &&
          [
            `/sessions/${value.id}/guess`,
            `/sessions/${value.id}/next`,
          ].includes(pending.path) &&
          typeof pending.body === "string" &&
          pending.body.length <= 2048
        );
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, CACHE_GAMES);
  } catch {
    /* Storage is optional for the current tab. */
  }
  return continuations;
}

function remember(value: Continuation): void {
  continuations = [
    value,
    ...readContinuations().filter(
      (entry) => entry.id !== value.id || entry.source !== value.source,
    ),
  ].slice(0, CACHE_GAMES);
  let serialized = JSON.stringify(continuations);
  while (serialized.length > CACHE_LIMIT && continuations.length > 1) {
    continuations.pop();
    serialized = JSON.stringify(continuations);
  }
  try {
    localStorage.setItem(CONTINUATION_KEY, serialized);
  } catch {
    /* Retain the bounded memory cache if storage is unavailable. */
  }
}

function localDevelopment(): boolean {
  return (
    import.meta.env.DEV ||
    (typeof location !== "undefined" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
  );
}

function gameBase(local: boolean): string {
  const explicit = import.meta.env.VITE_GUESSR_ROUND_API_URL;
  if (explicit) {
    if (explicit.startsWith("/") && !explicit.startsWith("//"))
      return explicit.replace(/\/$/, "");
    const url = new URL(explicit);
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return url.href.replace(/\/$/, "");
    throw new Error("The demo API address is invalid.");
  }
  if (local) return "/guessr-api";
  const origin = gameApiOrigin();
  if (origin) {
    const url = new URL(origin);
    if (url.protocol === "https:") return url.origin + "/api/games";
  }
  throw new Error("Demo games are not available on this site yet.");
}

async function requestGame(
  base: string,
  path: string,
  body: string | undefined,
  entry?: Continuation,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (entry) headers["X-Guessr-State"] = entry.token;
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const raw: unknown = await response.json().catch(() => null);
  const data = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
  if (!response.ok || !data || typeof data !== "object") {
    // A rejected mutation did not advance the continuation. Network failures,
    // timeouts and server failures retain the exact request for safe recovery.
    if (
      entry?.pending &&
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 429].includes(response.status)
    )
      remember({ ...entry, pending: undefined });
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : "Could not load this round. Please retry.",
    );
  }
  const continuation: unknown = data.continuation;
  if (continuation !== undefined) {
    const expectedId = sessionPath.exec(path)?.[1];
    const id: unknown = expectedId ?? data.id;
    if (
      typeof id !== "string" ||
      !new RegExp(`^${uuid}$`).test(id) ||
      (expectedId && data.id !== undefined && data.id !== expectedId) ||
      typeof continuation !== "string" ||
      continuation.length > TOKEN_LIMIT ||
      !tokenPattern.test(continuation)
    )
      throw new Error(
        "The demo returned invalid saved progress. Please retry.",
      );
    remember({ id, source: base, token: continuation, at: Date.now() });
    // The view receives the same public protocol as the local file-backed API.
    const { continuation: _continuation, ...state } = data;
    return state;
  }
  if (entry)
    throw new Error("The demo did not return saved progress. Please retry.");
  return data;
}

async function sessionRequest(
  base: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const match = sessionPath.exec(path);
  const id = match?.[1];
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  let entry = id
    ? readContinuations().find(
        (value) => value.id === id && value.source === base,
      )
    : undefined;
  if (entry?.pending) {
    const pending = entry.pending;
    const recovered = await requestGame(
      base,
      pending.path,
      pending.body,
      entry,
    );
    // The app already reloads after an interrupted mutation. Its recovery GET
    // can use this result directly without an additional Worker invocation.
    if (
      (path === `/sessions/${id}` && body === undefined) ||
      (path === pending.path && serialized === pending.body)
    )
      return recovered;
    entry = readContinuations().find(
      (value) => value.id === id && value.source === base,
    );
  }
  if (
    entry &&
    serialized !== undefined &&
    (match?.[2] === "guess" || match?.[2] === "next")
  ) {
    if (serialized.length > 2048)
      throw new Error("The demo request is too large.");
    entry = { ...entry, pending: { path, body: serialized }, at: Date.now() };
    remember(entry);
  }
  return requestGame(base, path, serialized, entry);
}

export async function imageGameRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  if (path !== "/config" && path !== "/sessions" && !sessionPath.test(path))
    throw new Error("Invalid demo route.");
  const local = localDevelopment();
  // Viewers and saved result pages need only this public static configuration.
  if (path === "/config" && body === undefined && !local)
    return (await requestGame("", "/guessr/config.json", undefined)) as T;
  const base = gameBase(local);
  const id = sessionPath.exec(path)?.[1];
  if (!id) return (await sessionRequest(base, path, body)) as T;
  const key = `${base}:${id}`;
  const request = (inFlight.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => sessionRequest(base, path, body));
  inFlight.set(key, request);
  try {
    return (await request) as T;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}
