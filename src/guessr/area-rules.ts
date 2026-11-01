/** Pure rules for private, source-cell area definitions. No image or runtime IO. */
import type { Bounds, Point } from "./rules.ts";

export type AreaDifficulty = "easy" | "normal" | "hard";
export type AreaRun = readonly [row: number, start: number, end: number];
export interface AreaScoring {
  area: number;
  position: number;
  maximum: number;
}
export interface SnowDifficultyRule {
  kind: "initial-view-snow";
  withSnow: "normal";
  withoutSnow: "hard";
  unknown: "requires-review";
  frozenForRound: true;
}
export interface AreaDefinition {
  id: string;
  label: string;
  /** Inventory entries awaiting a footprint or classification stay representable. */
  originY?: number | null;
  runs?: readonly AreaRun[] | null;
  bounds?: Bounds | null;
  cells?: number | null;
  difficultyTier?: AreaDifficulty | null;
  scoring?: AreaScoring | null;
  difficultyRule?: SnowDifficultyRule | null;
}
export interface AreaGuessResult {
  score: number;
  distance: number | null;
  areaScore: number;
  positionScore: number;
  areaMatch: boolean;
  perfect: boolean;
  maximum: number;
  difficultyTier: AreaDifficulty;
}

const CELL_SIZE = 512;
const ORIGIN_X = -17920;
const BASE_MAXIMUM = 5000;
const PERFECT_RADIUS = 64;
const POSITION_DECAY = 3000;

type ReadyArea = AreaDefinition & {
  originY: number;
  runs: readonly AreaRun[];
  bounds: Bounds;
  cells: number;
  difficultyTier: AreaDifficulty;
  scoring: AreaScoring;
};

function validPoint(point: Point): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validBounds(bounds: Bounds): boolean {
  return (
    !!bounds &&
    validPoint(bounds) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0 &&
    Number.isFinite(bounds.x + bounds.width) &&
    Number.isFinite(bounds.y + bounds.height)
  );
}

function assertReadyArea(area: AreaDefinition): asserts area is ReadyArea {
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`Area ${area.id}: ${reason}`);
  };
  if (!area.runs?.length)
    fail("source-cell runs are missing; footprint requires review");
  if (area.difficultyRule) {
    const rule = area.difficultyRule;
    if (
      rule.kind !== "initial-view-snow" ||
      rule.withSnow !== "normal" ||
      rule.withoutSnow !== "hard" ||
      rule.unknown !== "requires-review" ||
      rule.frozenForRound !== true
    )
      fail("unsupported difficulty rule");
    if (!area.difficultyTier || !area.scoring)
      fail("initial-view snow classification is unresolved; requires review");
    if (area.difficultyTier !== "normal" && area.difficultyTier !== "hard")
      fail("initial-view snow classification must be normal or hard");
  }
  if (
    !area.difficultyTier ||
    !["easy", "normal", "hard"].includes(area.difficultyTier)
  )
    fail("difficulty tier is missing or invalid");
  const scoring = area.scoring;
  if (!scoring) fail("scoring is missing; requires review");
  if (
    !Number.isSafeInteger(scoring.area) ||
    scoring.area < 0 ||
    !Number.isSafeInteger(scoring.position) ||
    scoring.position < 0 ||
    scoring.maximum !== BASE_MAXIMUM ||
    scoring.area + scoring.position !== BASE_MAXIMUM
  )
    fail("scoring budgets must be nonnegative integers totaling 5000");
  if (!Number.isSafeInteger(area.originY))
    fail("source-cell originY is missing or invalid");
  if (
    !area.bounds ||
    !validBounds(area.bounds) ||
    !area.bounds.width ||
    !area.bounds.height
  )
    fail("area bounds are missing or invalid");

  let count = 0;
  let previousRow = -Infinity;
  let previousEnd = -Infinity;
  for (const run of area.runs!) {
    if (run.length !== 3 || !run.every(Number.isSafeInteger))
      fail("source-cell runs must contain integer row, start and end values");
    const [row, start, end] = run;
    if (
      end <= start ||
      row < previousRow ||
      (row === previousRow && start < previousEnd)
    )
      fail("source-cell runs must be sorted, nonempty and nonoverlapping");
    const x = ORIGIN_X + start * CELL_SIZE;
    const right = ORIGIN_X + end * CELL_SIZE;
    const y = area.originY! + row * CELL_SIZE;
    const bottom = y + CELL_SIZE;
    if (![x, right, y, bottom].every(Number.isSafeInteger))
      fail("source-cell coordinates exceed the safe integer range");
    const bounds = area.bounds!;
    if (
      x < bounds.x ||
      right > bounds.x + bounds.width ||
      y < bounds.y ||
      bottom > bounds.y + bounds.height
    )
      fail("source-cell runs extend outside the declared area bounds");
    count += end - start;
    previousRow = row;
    previousEnd = end;
  }
  if (!Number.isSafeInteger(count) || count !== area.cells)
    fail("cell count does not match the source-cell runs");
}

function containsPoint(area: ReadyArea, point: Point): boolean {
  if (!validPoint(point)) return false;
  const row = Math.floor((point.y - area.originY) / CELL_SIZE);
  const column = Math.floor((point.x - ORIGIN_X) / CELL_SIZE);
  return area.runs.some(
    ([y, start, end]) => y === row && start <= column && column < end,
  );
}

/** Cell edges are half-open: the right/bottom edge belongs to the next cell. */
export function containsArea(area: AreaDefinition, point: Point): boolean {
  assertReadyArea(area);
  return containsPoint(area, point);
}

/**
 * Uniform over eligible integer world-pixel positions, not over run records.
 * Clipping a cell reduces its sampling weight. Bounds are half-open, and holes
 * remain excluded. This samples source ownership; capture suitability is separate.
 */
export function sampleAreaPoint(
  area: AreaDefinition,
  random: () => number,
  allowedBounds?: Bounds,
): Point {
  assertReadyArea(area);
  const clip = allowedBounds ?? area.bounds;
  if (!validBounds(clip))
    throw new Error("Allowed sampling bounds are invalid");
  const rectangles: (Bounds & { pixels: number })[] = [];
  let total = 0;
  for (const [row, start, end] of area.runs) {
    const x = Math.ceil(Math.max(ORIGIN_X + start * CELL_SIZE, clip.x));
    const y = Math.ceil(Math.max(area.originY + row * CELL_SIZE, clip.y));
    const right = Math.ceil(
      Math.min(ORIGIN_X + end * CELL_SIZE, clip.x + clip.width),
    );
    const bottom = Math.ceil(
      Math.min(area.originY + (row + 1) * CELL_SIZE, clip.y + clip.height),
    );
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) continue;
    const pixels = width * height;
    rectangles.push({ x, y, width, height, pixels });
    total += pixels;
  }
  if (!Number.isSafeInteger(total))
    throw new Error("Sampling mask exceeds the safe integer range");
  if (!total)
    throw new Error(
      `Area ${area.id}: no eligible native-pixel positions within allowed bounds`,
    );
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error("Random source must return a finite number in [0, 1)");
  let index = Math.min(total - 1, Math.floor(value * total));
  for (const rectangle of rectangles) {
    if (index < rectangle.pixels) {
      return {
        x: rectangle.x + (index % rectangle.width),
        y: rectangle.y + Math.floor(index / rectangle.width),
      };
    }
    index -= rectangle.pixels;
  }
  throw new Error("Sampling mask has inconsistent pixel counts");
}

/** Resolve only from evidence about the original view, then freeze on the round. */
export function resolveSnowDifficulty(
  hasSnowPixels: boolean | undefined,
): "normal" | "hard" {
  if (typeof hasSnowPixels !== "boolean")
    throw new Error(
      "Initial-view snow pixels are unknown; classification requires review",
    );
  return hasSnowPixels ? "normal" : "hard";
}

/** Membership and proximity are independent; proximity still counts across an edge. */
export function scoreAreaGuess(
  area: AreaDefinition,
  target: Point,
  guess: Point | null,
  maximum = BASE_MAXIMUM,
): AreaGuessResult {
  assertReadyArea(area);
  if (!containsPoint(area, target))
    throw new Error(`Area ${area.id}: target is outside the source-cell mask`);
  return scoreReadyGuess(area, target, guess, maximum, (point) =>
    containsPoint(area, point),
  );
}

/** Validate each revealed round once and index its row intervals for scoring a
 * whole chat. Holes and half-open edges retain exactly the single-guess rules. */
export function prepareAreaScorer(
  area: AreaDefinition,
  target: Point,
): (guess: Point | null, maximum?: number) => AreaGuessResult {
  assertReadyArea(area);
  const rows = new Map<number, [number, number][]>();
  for (const [row, start, end] of area.runs) {
    const intervals = rows.get(row) ?? [];
    intervals.push([start, end]);
    rows.set(row, intervals);
  }
  const originY = area.originY;
  const contains = (point: Point): boolean => {
    if (!validPoint(point)) return false;
    const intervals = rows.get(Math.floor((point.y - originY) / CELL_SIZE));
    if (!intervals) return false;
    const column = Math.floor((point.x - ORIGIN_X) / CELL_SIZE);
    let low = 0,
      high = intervals.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1,
        [start, end] = intervals[middle];
      if (column < start) high = middle - 1;
      else if (column >= end) low = middle + 1;
      else return true;
    }
    return false;
  };
  if (!contains(target))
    throw new Error(`Area ${area.id}: target is outside the source-cell mask`);
  const fixedTarget = { ...target },
    fixedRules = {
      difficultyTier: area.difficultyTier,
      scoring: { ...area.scoring },
    };
  return (guess, maximum = BASE_MAXIMUM) =>
    scoreReadyGuess(fixedRules, fixedTarget, guess, maximum, contains);
}

function scoreReadyGuess(
  area: Pick<ReadyArea, "difficultyTier" | "scoring">,
  target: Point,
  guess: Point | null,
  maximum: number,
  contains: (point: Point) => boolean,
): AreaGuessResult {
  if (!Number.isFinite(maximum))
    throw new Error("Maximum score must be finite");
  const cap = Math.floor(Math.max(0, Math.min(BASE_MAXIMUM, maximum)));
  if (guess === null)
    return {
      score: 0,
      distance: null,
      areaScore: 0,
      positionScore: 0,
      areaMatch: false,
      perfect: false,
      maximum: cap,
      difficultyTier: area.difficultyTier,
    };
  if (!validPoint(guess)) throw new Error("Guess coordinates must be finite");
  const distance = Math.hypot(guess.x - target.x, guess.y - target.y);
  const areaMatch = contains(guess);
  const multiplier = cap / BASE_MAXIMUM;
  const areaPoints = (areaMatch ? area.scoring.area : 0) * multiplier;
  const positionPoints =
    area.scoring.position *
    Math.exp(-Math.max(0, distance - PERFECT_RADIUS) / POSITION_DECAY) *
    multiplier;
  // Round the total once so component rounding cannot exceed an assistance cap.
  const score = Math.min(cap, Math.round(areaPoints + positionPoints));
  const areaScore = Math.min(score, Math.round(areaPoints));
  return {
    score,
    distance,
    areaScore,
    positionScore: score - areaScore,
    areaMatch,
    perfect: areaMatch && distance <= PERFECT_RADIUS,
    maximum: cap,
    difficultyTier: area.difficultyTier,
  };
}
