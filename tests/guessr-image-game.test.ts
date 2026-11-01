import { describe, expect, it } from "vitest";
import {
  ImageGameService,
  framesForPoint,
  type PrivateImageGame,
  type PrivateImageSet,
  type ImageGameStore,
} from "../src/guessr/image-game-server";
import { cameraRect, intersection, planView } from "../src/guessr/clue-camera";
import type { AreaDefinition } from "../src/guessr/area-rules";

function fixture() {
  const width = 2048,
    height = 1024,
    tileSize = 512,
    overlap = 2,
    maxLevel = 11;
  const images: PrivateImageSet["images"] = {},
    grid: Record<string, string> = {};
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) {
      const id = (y * 4 + x + 1).toString(16).padStart(32, "0");
      grid[`${x},${y}`] = id;
      images[id] = {
        width: 512 + (x ? 2 : 0) + (x < 3 ? 2 : 0),
        height: 514,
        content: "full",
      };
    }
  const index: PrivateImageSet = {
    schemaVersion: 1,
    version: "fixture-private-images",
    capture: {
      sha256: "private-source-sha",
      originX: -17920,
      originY: 0,
      width,
      height,
      tileSize,
      overlap,
      maxLevel,
    },
    levels: { [maxLevel]: { images: grid } },
    images,
  };
  const area: AreaDefinition = {
    id: "private-biome-id",
    label: "Private biome name",
    originY: 0,
    runs: [
      [0, 0, 4],
      [1, 0, 4],
    ],
    cells: 8,
    bounds: { x: -17920, y: 0, width, height },
    difficultyTier: "normal",
    scoring: { area: 1000, position: 4000, maximum: 5000 },
  };
  const games = new Map<string, PrivateImageGame>();
  const store: ImageGameStore = {
    async get(id) {
      return structuredClone(games.get(id) ?? null);
    },
    async put(game) {
      games.set(game.id, structuredClone(game));
    },
  };
  let step = 0;
  const service = new ImageGameService(
    index,
    [area],
    store,
    "/images",
    "/reference/",
    () => ((step++ * 191 + 97) % 997) / 997,
  );
  return { index, area, games, store, service };
}

describe("reusable-image rounds", () => {
  it("refuses all-black starts and skips empty areas without making black puzzles", async () => {
    const { index, area, store } = fixture();
    for (const image of Object.values(index.images)) image.content = "empty";
    const blank = new ImageGameService(index, [area], store);
    await expect(blank.start()).rejects.toThrow(
      "No starting views contain terrain",
    );
    // One terrain pixel in the lower half. The upper area's centres cannot see it.
    index.images[index.levels[11].images["2,1"]].content = [[2, 70, 1, 1]];
    const upper: AreaDefinition = {
      ...area,
      id: "empty-area",
      runs: [[0, 0, 4]],
      cells: 4,
    };
    const service = new ImageGameService(
      index,
      [upper, area],
      store,
      "/images",
      "/reference",
      () => 0,
    );
    const state = await service.start(),
      game = await service.load(state.id);
    expect(game.rounds.every((r) => r.areaId === area.id)).toBe(true);
    expect(state.totalRounds).toBe(3);
  });

  it("repairs only unanswered black starts when loading an older saved game", async () => {
    const { index, area, games, store, service } = fixture();
    const state = await service.start();
    await service.guess(state.id, state.current!.id, null, 5000);
    const saved = games.get(state.id)!;
    for (const round of saved.rounds.slice(1))
      round.answer = { x: -16900, y: 400 };
    const previous = structuredClone(saved);
    for (const image of Object.values(index.images)) image.content = "empty";
    index.images[index.levels[11].images["2,1"]].content = [[2, 70, 1, 1]];
    const updated = new ImageGameService(index, [area], store);
    const repaired = await updated.load(state.id);
    expect(repaired.rounds[0]).toEqual(previous.rounds[0]);
    for (const n of [1, 2]) {
      expect(repaired.rounds[n].id).not.toBe(previous.rounds[n].id);
      expect(repaired.rounds[n].answer).not.toEqual(previous.rounds[n].answer);
    }
    expect(await updated.load(state.id)).toEqual(repaired);
  });

  it("selects fresh points while exposing only relative frames before a guess", async () => {
    const { service, games, index } = fixture();
    const first = await service.start(),
      second = await service.start();
    expect(first.totalRounds).toBe(3);
    expect(first.results).toEqual([]);
    expect(first.current?.clue.frames?.length).toBeGreaterThan(1);
    const text = JSON.stringify(first);
    for (const forbidden of [
      "private-biome-id",
      "Private biome name",
      "private-source-sha",
      '"answer"',
      '"areaId"',
      '"seed"',
      "map_files",
      "0,0",
      '"levels"',
    ])
      expect(text).not.toContain(forbidden);
    for (const frame of first.current!.clue.frames!) {
      expect(frame.image).toMatch(/^\/images\/[a-f0-9]{32}\.webp$/);
      expect(Math.abs(frame.x)).toBeLessThan(2048);
      expect(Math.abs(frame.y)).toBeLessThan(1024);
    }
    expect(games.get(first.id)!.rounds[0].answer).not.toEqual(
      games.get(second.id)!.rounds[0].answer,
    );
    expect(Object.keys(index.images)).toHaveLength(8); // Starting games never grows the image set.
    expect(service.publicState(await service.load(first.id))).toEqual(first);
  });

  it("reveals only submitted answers and makes retries idempotent", async () => {
    const { service, games } = fixture(),
      start = await service.start();
    const target = games.get(start.id)!.rounds[0].answer;
    await expect(service.review(start.id, 0)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.next(start.id)).rejects.toMatchObject({ status: 409 });
    const reveal = await service.guess(
      start.id,
      start.current!.id,
      target,
      5000,
    );
    expect(reveal.results).toHaveLength(1);
    expect(reveal.results[0]).toMatchObject({
      answer: target,
      score: 5000,
      areaScore: 1000,
      positionScore: 4000,
    });
    expect(
      await service.guess(start.id, start.current!.id, target, 5000),
    ).toEqual(reveal);
    await expect(
      service.guess(
        start.id,
        start.current!.id,
        { x: target.x + 1, y: target.y },
        5000,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const next = await service.next(start.id);
    expect(next.stage).toBe("guess");
    expect(next.round).toBe(1);
    expect(next.results).toHaveLength(1);
    expect(next.current!.id).not.toBe(start.current!.id);
    expect(await service.review(start.id, 0)).toMatchObject({
      result: reveal.results[0],
    });
    await expect(service.review(start.id, 1)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.guess(start.id, start.current!.id, target, 5000),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("finishes exactly three rounds and retains revealed reviews across reloads", async () => {
    const { service } = fixture();
    let state = await service.start();
    for (let n = 0; n < 3; n++) {
      state = await service.guess(state.id, state.current!.id, null, 5000);
      state = await service.next(state.id);
    }
    expect(state.stage).toBe("complete");
    expect(state.current).toBeNull();
    expect(state.results).toHaveLength(3);
    expect(state.results.every((r) => r.score === 0)).toBe(true);
    expect(service.publicState(await service.load(state.id))).toEqual(state);
    expect(
      (await service.review(state.id, 2)).clue.frames.length,
    ).toBeGreaterThan(0);
    await expect(service.next(state.id)).rejects.toMatchObject({ status: 409 });
  });

  it("reassembles exact native pixels across seams at every clue size and travel boundary", () => {
    const { index } = fixture(),
      target = { x: -16910, y: 503 };
    const source = { frames: framesForPoint(index, target, "/images") };
    // Independent synthetic source pixels encode absolute position; simulate
    // drawImage using only the published frame positions and opaque IDs.
    const color = (x: number, y: number) => (x * 31 + y * 17 + x * y) % 256;
    for (let level = 0; level <= 6; level++)
      for (const direction of [-1, 0, 1]) {
        const width = 27 * 2 ** level,
          height = 12 * 2 ** level;
        const rect = cameraRect({
          level,
          dx: direction * Math.floor((1728 - width) / 2),
          dy: direction * Math.floor((768 - height) / 2),
        });
        const plan = planView(source, rect),
          actual = new Uint8Array(rect.width * rect.height);
        for (const frame of plan) {
          const id = frame.image.split("/").at(-1)!.slice(0, -5);
          const coord = Object.entries(index.levels[11].images)
            .find(([, value]) => value === id)![0]
            .split(",")
            .map(Number);
          const left = coord[0] * 512 - (coord[0] ? 2 : 0),
            top = coord[1] * 512 - (coord[1] ? 2 : 0);
          const cut = intersection(frame, rect)!;
          for (let y = cut.y; y < cut.y + cut.height; y++)
            for (let x = cut.x; x < cut.x + cut.width; x++)
              actual[(y - rect.y) * rect.width + x - rect.x] = color(
                left + x - frame.x,
                top + y - frame.y,
              );
        }
        const expected = Uint8Array.from(
          { length: rect.width * rect.height },
          (_, i) =>
            color(
              target.x + 17920 + rect.x + (i % rect.width),
              target.y + rect.y + Math.floor(i / rect.width),
            ),
        );
        expect(
          Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer)),
        ).toBe(true);
      }
  });

  it("rejects broken coverage, invalid pins and unclassified areas", async () => {
    const { service, index, area } = fixture(),
      state = await service.start();
    await expect(
      service.guess(state.id, state.current!.id, { x: 1e20, y: 1 }, 5000),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.guess(state.id, state.current!.id, null, 6000),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.load("../../private/image-set")).rejects.toMatchObject(
      { status: 404 },
    );
    const store = { get: async () => null, put: async () => {} };
    expect(
      () => new ImageGameService(index, [{ ...area, scoring: null }], store),
    ).toThrow("No reviewed");
    delete index.levels[11].images["1,0"];
    expect(() =>
      framesForPoint(index, { x: -16910, y: 503 }, "/images"),
    ).toThrow("incomplete");
  });
});
