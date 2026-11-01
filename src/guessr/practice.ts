import {
  type Pack,
  type Place,
  type Point,
  type Settings,
  pickPlaces,
  scoreGuess,
  validSettings,
  within,
  newClueProgress,
  maximumScore,
  type ClueProgress,
} from "./rules";
import { supportedCamera } from "./clue-camera";

export interface GuessResult {
  placeId: string;
  guess: Point | null;
  score: number;
  distance: number | null;
  hinted: boolean;
  elapsedMs: number;
  maximum: number;
}
export interface PracticeSession {
  version: 1;
  pack: string;
  seed: string;
  settings: Settings;
  order: string[];
  results: GuessResult[];
  roundStarted: number;
  pausedAt: number | null;
  guess: Point | null;
  hinted: boolean;
  stage: "guess" | "reveal" | "complete";
  createdAt: number;
  id: string;
  clue: ClueProgress;
}
export const SESSION_KEY = "noitamap-guessr-practice-v1";
export const HISTORY_KEY = "noitamap-guessr-history-v1";
export function newSession(
  pack: Pack,
  settings: Settings,
  seed: string,
  now = Date.now(),
): PracticeSession {
  const order = pickPlaces(pack, settings, seed).map((p) => p.id);
  if (!order.length) throw new Error("This collection has no locations.");
  return {
    version: 1,
    pack: pack.version,
    seed,
    settings: { ...settings, seconds: 0 },
    order,
    results: [],
    roundStarted: now,
    pausedAt: null,
    guess: null,
    hinted: false,
    stage: "guess",
    createdAt: now,
    id: crypto.randomUUID(),
    clue: newClueProgress(),
  };
}
export function currentPlace(session: PracticeSession, pack: Pack): Place {
  const index =
    session.stage === "guess"
      ? session.results.length
      : Math.max(0, session.results.length - 1);
  const place = pack.places.find((p) => p.id === session.order[index]);
  if (!place) throw new Error("This saved round is no longer available.");
  return place;
}
export function submitPractice(
  session: PracticeSession,
  pack: Pack,
  skip = false,
  now = Date.now(),
): GuessResult {
  if (session.stage !== "guess" || session.pausedAt !== null)
    throw new Error("Round is not accepting guesses.");
  const place = currentPlace(session, pack);
  const guess = skip ? null : session.guess;
  if (!skip && !within(guess, pack.bounds))
    throw new Error("Place a pin on the map first.");
  const maximum = maximumScore(session.clue);
  const scored = scoreGuess(guess, place, session.hinted, maximum);
  const result = {
    placeId: place.id,
    guess,
    score: scored.score,
    distance: scored.distance,
    hinted: session.hinted,
    elapsedMs: Math.max(0, (session.pausedAt ?? now) - session.roundStarted),
    maximum,
  };
  session.results.push(result);
  session.stage = "reveal";
  return result;
}
export function livesLeft(session: PracticeSession): number {
  return Math.max(
    0,
    3 -
      session.results.filter((r) => r.distance === null || r.distance > 1536)
        .length,
  );
}
export function nextRound(session: PracticeSession, now = Date.now()): void {
  if (session.stage !== "reveal") return;
  if (
    session.results.length === session.order.length ||
    (session.settings.mode === "survival" && livesLeft(session) === 0)
  ) {
    session.stage = "complete";
    return;
  }
  session.stage = "guess";
  session.roundStarted = now;
  session.guess = null;
  session.hinted = false;
  session.pausedAt = null;
  session.clue = newClueProgress();
}
export function pausePractice(
  session: PracticeSession,
  pause: boolean,
  now = Date.now(),
): void {
  if (session.stage !== "guess") return;
  if (pause && session.pausedAt === null) session.pausedAt = now;
  else if (!pause && session.pausedAt !== null) {
    session.roundStarted += Math.max(0, now - session.pausedAt);
    session.pausedAt = null;
  }
}
export function restorePractice(
  raw: string | null,
  pack: Pack,
): PracticeSession | null {
  if (!raw || raw.length > 40000) return null;
  try {
    const s: PracticeSession = JSON.parse(raw);
    if (
      s?.version !== 1 ||
      s.pack !== pack.version ||
      !validSettings(s.settings) ||
      typeof s.seed !== "string" ||
      s.seed.length > 80 ||
      typeof s.id !== "string" ||
      !["guess", "reveal", "complete"].includes(s.stage) ||
      !Array.isArray(s.order) ||
      !Array.isArray(s.results) ||
      s.results.length > s.order.length ||
      !Number.isFinite(s.roundStarted) ||
      !Number.isFinite(s.createdAt) ||
      !(s.pausedAt === null || Number.isFinite(s.pausedAt)) ||
      !(s.guess === null || within(s.guess, pack.bounds)) ||
      typeof s.hinted !== "boolean"
    )
      return null;
    const c = s.clue;
    if (
      !c ||
      ![c.level, c.widest, c.dx, c.dy].every(Number.isInteger) ||
      c.level < 0 ||
      c.level > 6 ||
      c.widest < c.level ||
      c.widest > 6 ||
      !supportedCamera(currentPlace(s, pack), c) ||
      !Number.isInteger(c.travelSpent) ||
      c.travelSpent < 0 ||
      c.travelSpent > 5000 ||
      !Array.isArray(c.visited) ||
      c.visited.length > 512 ||
      !c.visited.includes("0,0") ||
      (!c.visited.includes(`${c.dx},${c.dy}`) && maximumScore(c) > 0) ||
      new Set(c.visited).size !== c.visited.length ||
      c.visited.some((v) => {
        if (typeof v !== "string" || !/^-?\d+,-?\d+$/.test(v)) return true;
        const [dx, dy] = v.split(",").map(Number);
        return !supportedCamera(currentPlace(s, pack), { dx, dy, level: 0 });
      })
    )
      return null;
    const expected = pickPlaces(pack, s.settings, s.seed).map((p) => p.id);
    if (JSON.stringify(s.order) !== JSON.stringify(expected)) return null;
    if (s.stage === "guess" && s.results.length >= s.order.length) return null;
    if (s.stage !== "guess" && !s.results.length) return null;
    for (const [i, result] of s.results.entries()) {
      const place = pack.places.find((p) => p.id === s.order[i])!;
      if (
        result.placeId !== place.id ||
        !(result.guess === null || within(result.guess, pack.bounds)) ||
        !Number.isFinite(result.elapsedMs) ||
        result.elapsedMs < 0 ||
        typeof result.hinted !== "boolean"
      )
        return null;
      if (
        !Number.isInteger(result.maximum) ||
        result.maximum < 0 ||
        result.maximum > 5000
      )
        return null;
      const check = scoreGuess(
        result.guess,
        place,
        result.hinted,
        result.maximum,
      );
      if (result.score !== check.score || result.distance !== check.distance)
        return null;
    }
    s.settings.seconds = 0;
    return s;
  } catch {
    return null;
  }
}
export interface HistoryEntry {
  id: string;
  at: number;
  score: number;
  rounds: number;
  mode: string;
  difficulty: string;
  seed: string;
}
export function readHistory(storage: Pick<Storage, "getItem">): HistoryEntry[] {
  try {
    const value = JSON.parse(storage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value)
      ? value
          .filter(
            (v) =>
              typeof v.id === "string" &&
              Number.isFinite(v.score) &&
              v.score >= 0 &&
              v.score <= 100000 &&
              Number.isFinite(v.at) &&
              v.rounds > 0 &&
              v.rounds <= 20,
          )
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
export function saveHistory(
  session: PracticeSession,
  storage: Pick<Storage, "getItem" | "setItem">,
): void {
  if (session.stage !== "complete") return;
  const entries = readHistory(storage).filter((e) => e.id !== session.id);
  entries.unshift({
    id: session.id,
    at: session.createdAt,
    score: session.results.reduce((s, r) => s + r.score, 0),
    rounds: session.results.length,
    mode: session.settings.mode,
    difficulty: session.settings.difficulty,
    seed: session.seed,
  });
  storage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 30)));
}
