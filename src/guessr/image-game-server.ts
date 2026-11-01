/** Server-only image selection and scoring. No image decoder, cropper, encoder
 * or filesystem dependency: all round images already exist in the dataset. */
import { scoreAreaGuess, type AreaDefinition } from "./area-rules.ts";
import { cameraRect, type PreparedFrame } from "./clue-camera.ts";
import { within, type Bounds, type Point } from "./rules.ts";
import {
  prepareAreaStarts,
  type ImageContent,
  type StartSampler,
} from "./starting-view.ts";
import type {
  ImageGameConfig,
  ImageGameState,
  ImageRoundResult,
} from "./image-game.ts";

export interface PrivateImageSet {
  schemaVersion: number;
  version: string;
  capture: {
    sha256: string;
    originX: number;
    originY: number;
    width: number;
    height: number;
    tileSize: number;
    overlap: number;
    maxLevel: number;
  };
  levels: Record<string, { images: Record<string, string> }>;
  images: Record<
    string,
    { width: number; height: number; content?: ImageContent }
  >;
}
export interface PrivateRound {
  id: string;
  areaId: string;
  answer: Point;
  result?: ImageRoundResult;
}
export interface PrivateImageGame {
  id: string;
  version: string;
  round: number;
  stage: ImageGameState["stage"];
  rounds: PrivateRound[];
}
export interface ImageGameStore {
  get(id: string): Promise<PrivateImageGame | null>;
  put(game: PrivateImageGame): Promise<void>;
}
export class ImageGameError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Export only the nearby native pieces with origins relative to this target.
 * Even at a tile seam, the requested target is never snapped to the grid. */
export function framesForPoint(
  index: PrivateImageSet,
  target: Point,
  imageRoot: string,
): PreparedFrame[] {
  const c = index.capture,
    view = cameraRect({ dx: 0, dy: 0, level: 6 });
  const left = target.x + view.x - c.originX,
    top = target.y + view.y - c.originY;
  if (
    left < 0 ||
    top < 0 ||
    left + view.width > c.width ||
    top + view.height > c.height
  )
    throw new Error("Starting view is outside the prepared map.");
  const frames: PreparedFrame[] = [];
  for (
    let y = Math.floor(top / c.tileSize);
    y <= Math.floor((top + view.height - 1) / c.tileSize);
    y++
  ) {
    for (
      let x = Math.floor(left / c.tileSize);
      x <= Math.floor((left + view.width - 1) / c.tileSize);
      x++
    ) {
      const id = index.levels[c.maxLevel].images[`${x},${y}`],
        image = index.images[id];
      if (!/^[a-f0-9]{32,64}$/.test(id || "") || !image)
        throw new Error("Prepared image coverage is incomplete.");
      frames.push({
        image: imageRoot.replace(/\/$/, "") + "/" + id + ".webp",
        x: c.originX + x * c.tileSize - (x ? c.overlap : 0) - target.x,
        y: c.originY + y * c.tileSize - (y ? c.overlap : 0) - target.y,
        width: image.width,
        height: image.height,
      });
    }
  }
  return frames;
}

export class ImageGameService {
  readonly areas: AreaDefinition[];
  readonly bounds: Bounds;
  private starts = new Map<string, StartSampler>();
  constructor(
    readonly index: PrivateImageSet,
    areas: AreaDefinition[],
    readonly store: ImageGameStore,
    readonly imageRoot = "/guessr-images/images",
    readonly referenceRoot = "/guessr-assets/captured/map_files/",
    readonly random = () =>
      crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296,
  ) {
    const c = index.capture;
    this.bounds = {
      x: c.originX,
      y: c.originY,
      width: c.width,
      height: c.height,
    };
    // This local review build uses curated source-union masks. Unresolved snow
    // classification and point-only rooms are deliberately not silently guessed.
    this.areas = areas.filter(
      (a) =>
        a.runs?.length && a.scoring && a.difficultyTier && !a.difficultyRule,
    );
    if (!this.areas.length)
      throw new Error("No reviewed area masks are available.");
  }
  config(): ImageGameConfig {
    const c = this.index.capture;
    return {
      version: this.index.version,
      bounds: this.bounds,
      overview: "",
      map: {
        width: c.width,
        height: c.height,
        tileSize: c.tileSize,
        overlap: c.overlap,
        maxLevel: c.maxLevel,
        tiles: this.referenceRoot,
      },
    };
  }
  private areaStarts(area: AreaDefinition): StartSampler {
    let starts = this.starts.get(area.id);
    if (!starts) {
      starts = prepareAreaStarts(this.index, area);
      this.starts.set(area.id, starts);
    }
    return starts;
  }
  private createRound(area: AreaDefinition): PrivateRound | null {
    const starts = this.areaStarts(area);
    if (!starts.pixels) return null;
    const answer = starts.sample(this.random);
    framesForPoint(this.index, answer, this.imageRoot);
    return { id: crypto.randomUUID(), areaId: area.id, answer };
  }
  selectRounds(count: number): PrivateRound[] {
    const selection = [...this.areas],
      rounds: PrivateRound[] = [];
    while (rounds.length < count) {
      if (!selection.length) {
        selection.push(
          ...this.areas.filter((area) => this.areaStarts(area).pixels > 0),
        );
        if (!selection.length)
          throw new Error(
            "No starting views contain terrain in the reviewed areas.",
          );
      }
      const area = selection.splice(
        Math.floor(this.random() * selection.length),
        1,
      )[0];
      const round = this.createRound(area);
      if (round) rounds.push(round);
    }
    return rounds;
  }
  async start(): Promise<ImageGameState> {
    const rounds = this.selectRounds(3);
    const game: PrivateImageGame = {
      id: crypto.randomUUID(),
      version: this.index.version,
      round: 0,
      stage: "guess",
      rounds,
    };
    await this.store.put(game);
    return this.publicState(game);
  }
  publicState(game: PrivateImageGame): ImageGameState {
    const current = game.rounds[game.round];
    return {
      id: game.id,
      version: game.version,
      round: game.round,
      totalRounds: game.rounds.length,
      stage: game.stage,
      current:
        game.stage === "complete"
          ? null
          : {
              id: current.id,
              clue: {
                frames: framesForPoint(
                  this.index,
                  current.answer,
                  this.imageRoot,
                ),
              },
            },
      results: game.rounds.flatMap((r) => (r.result ? [r.result] : [])),
    };
  }
  async load(id: string): Promise<PrivateImageGame> {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new ImageGameError(404, "Game not found.");
    const game = await this.store.get(id);
    if (!game || game.version !== this.index.version)
      throw new ImageGameError(
        404,
        "This game is no longer available. Start a new game.",
      );
    // Old saved games may contain black starts. Repair only unanswered rounds;
    // a new round ID resets the browser's old camera and assistance allowance.
    let repaired = false;
    for (let i = 0; i < game.rounds.length; i++) {
      const round = game.rounds[i];
      if (round.result) continue;
      const area = this.areas.find((a) => a.id === round.areaId);
      if (area && this.areaStarts(area).contains(round.answer)) continue;
      game.rounds[i] =
        (area && this.createRound(area)) || this.selectRounds(1)[0];
      repaired = true;
    }
    if (repaired) await this.store.put(game);
    return game;
  }
  async guess(
    id: string,
    roundId: string,
    guess: Point | null,
    maximum: number,
  ): Promise<ImageGameState> {
    const game = await this.load(id),
      round = game.rounds[game.round];
    if (game.stage === "complete" || round.id !== roundId)
      throw new ImageGameError(409, "This round has already ended.");
    if (guess !== null && !within(guess, this.bounds))
      throw new ImageGameError(400, "Place a pin inside the map.");
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 5000)
      throw new ImageGameError(400, "Invalid score allowance.");
    if (round.result) {
      if (
        JSON.stringify(round.result.guess) !== JSON.stringify(guess) ||
        round.result.maximum !== maximum
      )
        throw new ImageGameError(
          409,
          "Your submitted guess cannot be changed.",
        );
      return this.publicState(game);
    }
    const area = this.areas.find((a) => a.id === round.areaId);
    if (!area)
      throw new ImageGameError(
        409,
        "This area definition has changed. Start a new game.",
      );
    const scored = scoreAreaGuess(area, round.answer, guess, maximum);
    round.result = {
      ordinal: game.round,
      answer: round.answer,
      name: area.label,
      areaId: area.id,
      guess,
      score: scored.score,
      areaScore: scored.areaScore,
      positionScore: scored.positionScore,
      areaMatch: scored.areaMatch,
      difficultyTier: scored.difficultyTier,
      distance: scored.distance,
      maximum,
    };
    game.stage = "reveal";
    await this.store.put(game);
    return this.publicState(game);
  }
  async next(id: string): Promise<ImageGameState> {
    const game = await this.load(id);
    if (game.stage !== "reveal")
      throw new ImageGameError(409, "Submit the current round first.");
    if (game.round + 1 === game.rounds.length) game.stage = "complete";
    else {
      game.round++;
      game.stage = "guess";
    }
    await this.store.put(game);
    return this.publicState(game);
  }
  async review(id: string, ordinal: number) {
    const game = await this.load(id),
      round = game.rounds[ordinal];
    if (!round?.result)
      throw new ImageGameError(404, "Submit this round before reviewing it.");
    return {
      result: round.result,
      clue: {
        frames: framesForPoint(this.index, round.answer, this.imageRoot),
      },
    };
  }
}
