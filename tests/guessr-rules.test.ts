import { describe, it, expect } from "vitest";
import { clampCamera } from "../src/guessr/clue-camera";
import {
  DEFAULT_SETTINGS,
  scoreGuess,
  pickPlaces,
  within,
  pointFromFraction,
  changeClue,
  maximumScore,
  newClueProgress,
  type Pack,
} from "../src/guessr/rules";
import {
  newSession,
  submitPractice,
  nextRound,
  restorePractice,
  pausePractice,
  livesLeft,
  saveHistory,
  HISTORY_KEY,
} from "../src/guessr/practice";
const pack: Pack = {
  version: "test-v1",
  seed: 42,
  bounds: { x: -10000, y: -5000, width: 20000, height: 20000 },
  overview: "/overview.webp",
  places: Array.from({ length: 24 }, (_, i) => ({
    id: "p" + i,
    name: "Place " + i,
    x: i * 200,
    y: i * 300,
    theme: i % 2 ? "surface" : "caverns",
    biome: "Biome",
    image: "/x.webp",
    fact: "A fact.",
  })),
};
describe("NoitaGuessr rules", () => {
  const placeWithViews = {
    ...pack.places[0],
    views: Object.fromEntries(
      Array.from({ length: 7 }, (_, level) =>
        [-1, 0, 1].map((dx) => [
          `${dx},0,${level}`,
          {
            image: `/clue-${dx}-${level}.webp`,
            width: 27 * 2 ** level,
            height: 12 * 2 ** level,
          },
        ]),
      ).flat(),
    ),
  };
  it("charges the widest view once, charges new travel, and keeps the original answer", () => {
    const clue = newClueProgress();
    expect(maximumScore(clue)).toBe(5000);
    expect(changeClue(placeWithViews, clue, 0, 0, 3)).toBe(true);
    expect(maximumScore(clue)).toBe(3500);
    changeClue(placeWithViews, clue, 1, 0, 3);
    expect(maximumScore(clue)).toBe(3400);
    changeClue(placeWithViews, clue, 0, 0, 0);
    changeClue(placeWithViews, clue, 1, 0, 1);
    expect(maximumScore(clue)).toBe(3400);
    expect(
      scoreGuess(placeWithViews, placeWithViews, false, maximumScore(clue))
        .score,
    ).toBe(3400);
    const before = structuredClone(clue);
    expect(changeClue(placeWithViews, clue, 852, 0, 0)).toBe(false);
    expect(clue).toEqual(before);
  });
  it("persists charged views through refresh and resets them for the next round", () => {
    const withViews = {
      ...pack,
      places: [placeWithViews, ...pack.places.slice(1)],
      demo: ["p0", "p1", "p2"],
    };
    const s = newSession(
      withViews,
      { ...DEFAULT_SETTINGS, mode: "demo" },
      "demo",
    );
    changeClue(placeWithViews, s.clue, 0, 0, 2);
    changeClue(placeWithViews, s.clue, 19, 0, 2);
    changeClue(placeWithViews, s.clue, 19, 0, 0);
    const restored = restorePractice(JSON.stringify(s), withViews)!;
    expect(restored.clue).toEqual(s.clue);
    expect(restored.clue.dx).toBe(19);
    expect(maximumScore(restored.clue)).toBe(4000);
    restored.guess = placeWithViews;
    expect(submitPractice(restored, withViews)).toMatchObject({
      score: 4000,
      maximum: 4000,
      distance: 0,
    });
    expect(restorePractice(JSON.stringify(restored), withViews)).toEqual(
      restored,
    );
    nextRound(restored);
    expect(restored.clue).toEqual(newClueProgress());
  });
  it("can still save and move after travel uses the remaining points", () => {
    const withViews = {
      ...pack,
      places: [placeWithViews, ...pack.places.slice(1)],
      demo: ["p0", "p1", "p2"],
    };
    const s = newSession(
      withViews,
      { ...DEFAULT_SETTINGS, mode: "demo" },
      "demo",
    );
    for (let dx = 1; dx <= 100; dx++)
      expect(changeClue(placeWithViews, s.clue, dx, 0, 0)).toBe(true);
    expect(maximumScore(s.clue)).toBe(0);
    expect(s.clue.visited).toHaveLength(51);
    expect(restorePractice(JSON.stringify(s), withViews)).toEqual(s);
  });
  it("does not charge travel for the recentering needed when zooming out near an edge", () => {
    const clue = newClueProgress();
    changeClue(placeWithViews, clue, 750, 350, 0);
    expect(clue.travelSpent).toBe(100);
    const zoom = clampCamera(placeWithViews, { ...clue, level: 5 });
    expect(zoom).toEqual({ dx: 432, dy: 192, level: 5 });
    changeClue(placeWithViews, clue, zoom.dx, zoom.dy, zoom.level);
    expect(clue.travelSpent).toBe(100);
    expect(maximumScore(clue)).toBe(1900);
  });
  it("scores by distance with a finite perfect tolerance and hint cap", () => {
    expect(scoreGuess({ x: 50, y: 0 }, { x: 0, y: 0 })).toMatchObject({
      score: 5000,
      perfect: true,
    });
    expect(scoreGuess({ x: 50, y: 0 }, { x: 0, y: 0 }, true).score).toBe(3500);
    expect(scoreGuess({ x: 1000, y: 0 }, { x: 0, y: 0 }).score).toBeGreaterThan(
      scoreGuess({ x: 4000, y: 0 }, { x: 0, y: 0 }).score,
    );
    expect(scoreGuess(null, { x: 0, y: 0 })).toMatchObject({
      score: 0,
      distance: null,
    });
  });
  it("selects a deterministic unique round set without changing the pool", () => {
    const before = JSON.stringify(pack),
      settings = { ...DEFAULT_SETTINGS };
    const a = pickPlaces(pack, settings, "friend");
    expect(a).toHaveLength(10);
    expect(new Set(a.map((p) => p.id)).size).toBe(10);
    expect(a).toEqual(pickPlaces(pack, settings, "friend"));
    expect(a).not.toEqual(pickPlaces(pack, settings, "other"));
    expect(
      pickPlaces(pack, { ...settings, theme: "surface" }, "friend").every(
        (p) => p.theme === "surface",
      ),
    ).toBe(true);
    expect(JSON.stringify(pack)).toBe(before);
  });
  it("keeps the demo to the same three locations regardless of seed", () => {
    const a = pickPlaces(pack, { ...DEFAULT_SETTINGS, mode: "demo" }, "first");
    expect(a).toHaveLength(3);
    expect(a).toEqual(
      pickPlaces(pack, { ...DEFAULT_SETTINGS, mode: "demo" }, "another"),
    );
  });
  it("rejects invalid coordinates and clamps board conversions", () => {
    expect(within({ x: NaN, y: 3 }, pack.bounds)).toBe(false);
    expect(within({ x: 999999, y: 3 }, pack.bounds)).toBe(false);
    expect(pointFromFraction(-1, 2, pack.bounds)).toEqual({
      x: -10000,
      y: 15000,
    });
  });
  it("resumes a validated game and does not advance twice", () => {
    const s = newSession(pack, DEFAULT_SETTINGS, "test", 1000);
    const place = pack.places.find((p) => p.id === s.order[0])!;
    s.guess = { x: place.x, y: place.y };
    submitPractice(s, pack, false, 1200);
    expect(() => submitPractice(s, pack, false, 1300)).toThrow();
    expect(restorePractice(JSON.stringify(s), pack)).toEqual(s);
    nextRound(s, 1400);
    expect(s.results).toHaveLength(1);
    expect(s.stage).toBe("guess");
    nextRound(s, 1500);
    expect(s.roundStarted).toBe(1400);
    const forged = JSON.parse(JSON.stringify(s));
    forged.results[0].score = 100000;
    expect(restorePractice(JSON.stringify(forged), pack)).toBeNull();
  });
  it("does not expire old timed sessions or paused games", () => {
    const s = newSession(
      pack,
      { ...DEFAULT_SETTINGS, seconds: 30 },
      "test",
      1000,
    );
    expect(s.settings.seconds).toBe(0);
    pausePractice(s, true, 5000);
    expect(() => submitPractice(s, pack, false, 100000)).toThrow();
    pausePractice(s, false, 100000);
    const p = pack.places.find((p) => p.id === s.order[0])!;
    s.guess = { x: p.x, y: p.y };
    expect(submitPractice(s, pack, false, 86400000 * 3).score).toBe(5000);
  });
  it("ends survival after three misses and records each finished run once", () => {
    const s = newSession(
      pack,
      { ...DEFAULT_SETTINGS, mode: "survival" },
      "test",
      1000,
    );
    for (let i = 0; i < 3; i++) {
      submitPractice(s, pack, true, 2000 + i);
      nextRound(s, 3000 + i);
    }
    expect(livesLeft(s)).toBe(0);
    expect(s.stage).toBe("complete");
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    saveHistory(s, storage);
    saveHistory(s, storage);
    expect(JSON.parse(values.get(HISTORY_KEY)!)).toHaveLength(1);
  });
  it("ignores stale or malformed saved games", () => {
    expect(restorePractice("{", pack)).toBeNull();
    const s = newSession(pack, DEFAULT_SETTINGS, "test");
    expect(
      restorePractice(JSON.stringify({ ...s, pack: "old" }), pack),
    ).toBeNull();
    expect(
      restorePractice(JSON.stringify({ ...s, order: ["not-in-pack"] }), pack),
    ).toBeNull();
  });
});
