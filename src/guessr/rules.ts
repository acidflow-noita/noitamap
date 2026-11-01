/** Pure game rules shared with the scoring Worker. No browser or map imports. */
import { supportedCamera } from "./clue-camera.ts";
export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Difficulty = "explorer" | "normal" | "expert";
export type PracticeMode = "demo" | "classic" | "daily" | "survival";
export interface Settings {
  mode: PracticeMode;
  difficulty: Difficulty;
  theme: string;
  seconds: number;
}
export interface Place extends Point {
  id: string;
  name: string;
  biome: string;
  theme: string;
  image: string;
  fact?: string;
  hard?: boolean;
  views?: Record<string, { image: string; width: number; height: number }>;
}
export interface Pack {
  version: string;
  seed: number;
  bounds: Bounds;
  overview: string;
  map?: {
    width: number;
    height: number;
    tileSize: number;
    overlap: number;
    maxLevel: number;
    tiles: string;
  };
  places: Place[];
  demo?: string[];
  /** Spacing of prepared source images, not the distance moved by the camera. */
  travelStep?: number;
}
export const ROUND_COUNT = 10;
export const MAX_SCORE = 5000;
export const ZOOM_CAPS = [5000, 4600, 4100, 3500, 2800, 2000, 1000] as const;
export const TRAVEL_COST = 100;
export interface ClueProgress {
  level: number;
  widest: number;
  dx: number; // Native-pixel offset from the starting point.
  dy: number;
  visited: string[];
  travelSpent: number;
}
export const newClueProgress = (): ClueProgress => ({
  level: 0,
  widest: 0,
  dx: 0,
  dy: 0,
  visited: ["0,0"],
  travelSpent: 0,
});
export function maximumScore(clue: ClueProgress): number {
  return Math.max(0, ZOOM_CAPS[clue.widest] - clue.travelSpent);
}
export function changeClue(
  place: import("./clue-camera.ts").ClueSource,
  clue: ClueProgress,
  dx: number,
  dy: number,
  level: number,
): boolean {
  if (
    (!place.views && !place.frames) ||
    !supportedCamera(place, { dx, dy, level })
  )
    return false;
  const zoomChanged = level !== clue.level;
  clue.dx = dx;
  clue.dy = dy;
  clue.level = level;
  clue.widest = Math.max(clue.widest, level);
  const key = `${dx},${dy}`;
  if (!clue.visited.includes(key) && maximumScore(clue) > 0) {
    if (!zoomChanged) clue.travelSpent += TRAVEL_COST;
    clue.visited.push(key);
  }
  return true;
}
export const DEFAULT_SETTINGS: Settings = {
  mode: "classic",
  difficulty: "normal",
  theme: "all",
  seconds: 0,
};
export const DIFFICULTIES = {
  explorer: {
    label: "Explorer",
    crop: 1,
    description: "A wider view to learn the world.",
  },
  normal: {
    label: "Adventurer",
    crop: 0.67,
    description: "Recognise the terrain and find your bearings.",
  },
  expert: {
    label: "Expert",
    crop: 0.36,
    description: "A small window. Every pixel is a clue.",
  },
} as const;

export function within(point: unknown, bounds: Bounds): point is Point {
  if (!point || typeof point !== "object") return false;
  const { x, y } = point as Point;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= bounds.x &&
    y >= bounds.y &&
    x <= bounds.x + bounds.width &&
    y <= bounds.y + bounds.height
  );
}

/** 64 world pixels is the perfect-score tolerance on the overview. */
export function scoreGuess(
  guess: Point | null,
  answer: Point,
  hinted = false,
  cap = MAX_SCORE,
) {
  if (!guess) return { distance: null, score: 0, perfect: false };
  const distance = Math.hypot(guess.x - answer.x, guess.y - answer.y);
  const perfect = distance <= 64;
  const raw = perfect
    ? MAX_SCORE
    : Math.round(MAX_SCORE * Math.exp(-(distance - 64) / 3000));
  return {
    distance,
    score: Math.round(
      (raw / MAX_SCORE) * Math.min(hinted ? 3500 : MAX_SCORE, cap),
    ),
    perfect: perfect && !hinted,
  };
}

export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function shuffled<T>(items: readonly T[], seed: string): T[] {
  let state = hashSeed(seed) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
export function validSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const s = value as Settings;
  return (
    ["demo", "classic", "daily", "survival"].includes(s.mode) &&
    Object.hasOwn(DIFFICULTIES, s.difficulty) &&
    ["all", "surface", "caverns", "secrets"].includes(s.theme) &&
    [0, 30, 60, 120].includes(s.seconds)
  );
}

export function pickPlaces(
  pack: Pack,
  settings: Settings,
  seed: string,
): Place[] {
  if (settings.mode === "demo")
    return pack.demo
      ? pack.demo
          .map((id) => pack.places.find((p) => p.id === id)!)
          .filter(Boolean)
          .slice(0, 3)
      : pack.places.slice(0, 3);
  const pool = pack.places.filter(
    (p) => settings.theme === "all" || p.theme === settings.theme,
  );
  return shuffled(pool, `${pack.version}:${seed}`).slice(
    0,
    settings.mode === "survival" ? 20 : ROUND_COUNT,
  );
}

export function distanceText(distance: number | null): string {
  if (distance === null) return "Skipped";
  if (distance <= 64) return "Right on the spot";
  const chunks = distance / 512;
  return `${chunks < 10 ? chunks.toFixed(1) : Math.round(chunks)} chunks away`;
}

export function pointFromFraction(
  fx: number,
  fy: number,
  bounds: Bounds,
): Point {
  return {
    x: Math.round(bounds.x + Math.max(0, Math.min(1, fx)) * bounds.width),
    y: Math.round(bounds.y + Math.max(0, Math.min(1, fy)) * bounds.height),
  };
}
