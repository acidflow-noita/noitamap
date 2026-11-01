import { describe, expect, it } from "vitest";
import curation from "../build_scripts/guessr/area-curation.json";
import {
  containsArea,
  prepareAreaScorer,
  resolveSnowDifficulty,
  sampleAreaPoint,
  scoreAreaGuess,
  type AreaDefinition,
  type AreaDifficulty,
  type AreaRun,
  type SnowDifficultyRule,
} from "../src/guessr/area-rules";
import type { Point } from "../src/guessr/rules";

// Small complete masks copied from the generated inventory. Tests remain usable
// in a clean checkout without depending on generated task/ artifacts or images.
const jungle: AreaDefinition = {
  id: "biome/underground-jungle",
  label: "Underground Jungle",
  originY: -31744,
  runs: [
    [75, 30, 39],
    [76, 30, 34],
    [76, 35, 39],
    [77, 30, 39],
  ],
  cells: 26,
  bounds: { x: -2560, y: 6656, width: 4608, height: 1536 },
  difficultyTier: "normal",
  scoring: curation.scoringProfiles.normal,
};
const fungalMain: AreaDefinition = {
  id: "biome/fungal-caverns-main",
  label: "Fungal Caverns (main)",
  originY: -31744,
  runs: [
    [65, 28, 31],
    [66, 29, 31],
  ],
  cells: 5,
  bounds: { x: -3584, y: 1536, width: 1536, height: 1024 },
  difficultyTier: "normal",
  scoring: curation.scoringProfiles.normal,
};
const fungalWest: AreaDefinition = {
  id: "biome/fungal-caverns-jungle-west",
  label: "Fungal Caverns (western jungle enclave)",
  originY: -31744,
  runs: [[76, 34, 35]],
  cells: 1,
  bounds: { x: -512, y: 7168, width: 512, height: 512 },
  difficultyTier: "normal",
  scoring: curation.scoringProfiles.normal,
};
const temple: AreaDefinition = {
  id: "biome/crypt",
  label: "Temple of the Art",
  originY: -31744,
  runs: [
    [83, 29, 40],
    [84, 26, 27],
    [84, 29, 40],
    [85, 26, 40],
    [86, 29, 38],
  ],
  cells: 46,
  bounds: { x: -4608, y: 10752, width: 7168, height: 2048 },
  difficultyTier: "easy",
  scoring: curation.scoringProfiles.easy,
};
const holyMountain: AreaDefinition = {
  id: "landmark/holy-mountain-1",
  label: "Holy Mountain (depth 1)",
  originY: -31744,
  runs: [[64, 32, 39]],
  cells: 7,
  bounds: { x: -1536, y: 1024, width: 3584, height: 512 },
  difficultyTier: "normal",
  scoring: curation.holyMountainScoreOverride,
};

function mask(
  runs: readonly AreaRun[],
  tier: AreaDifficulty = "normal",
): AreaDefinition {
  const left = Math.min(...runs.map((run) => run[1]));
  const right = Math.max(...runs.map((run) => run[2]));
  const top = Math.min(...runs.map((run) => run[0]));
  const bottom = Math.max(...runs.map((run) => run[0])) + 1;
  return {
    id: "test/mask",
    label: "Test mask",
    originY: -31744,
    runs,
    cells: runs.reduce((sum, run) => sum + run[2] - run[1], 0),
    bounds: {
      x: -17920 + left * 512,
      y: -31744 + top * 512,
      width: (right - left) * 512,
      height: (bottom - top) * 512,
    },
    difficultyTier: tier,
    scoring: curation.scoringProfiles[tier],
  };
}
function center(area: AreaDefinition): Point {
  const [row, start] = area.runs![0];
  return { x: -17920 + start * 512 + 256, y: area.originY! + row * 512 + 256 };
}

describe("prepared chat area scoring", () => {
  it("matches single-guess scoring across tiers, the Holy Mountain override, holes and half-open edges", () => {
    const areas = [
      jungle,
      fungalMain,
      fungalWest,
      temple,
      holyMountain,
      mask(
        [
          [0, 0, 2],
          [1, 0, 1],
          [1, 2, 3],
        ],
        "hard",
      ),
    ];
    for (const area of areas) {
      const target = center(area),
        score = prepareAreaScorer(area, target);
      const points: (Point | null)[] = [
        null,
        target,
        { x: target.x + 64, y: target.y },
        { x: target.x + 65, y: target.y },
        { x: -256, y: 7424 },
        { x: -513, y: 7424 },
        { x: 0, y: 7424 },
      ];
      for (const [row, start, end] of area.runs!)
        for (const x of [
          -17920 + start * 512 - 1,
          -17920 + start * 512,
          -17920 + end * 512 - 1,
          -17920 + end * 512,
        ])
          points.push({ x, y: area.originY! + row * 512 });
      for (const maximum of [5000, 4900, 2800, 1000, 1, 0, -50, 8000, 1432.8])
        for (const point of points)
          expect(score(point, maximum)).toEqual(
            scoreAreaGuess(area, target, point, maximum),
          );
    }
  });
  it("preserves validation and snapshots the original target and scoring budgets", () => {
    expect(() =>
      prepareAreaScorer({ ...jungle, cells: 0 }, center(jungle)),
    ).toThrow();
    expect(() => prepareAreaScorer(jungle, { x: -256, y: 7424 })).toThrow(
      "outside",
    );
    const area = structuredClone(jungle),
      target = center(area),
      score = prepareAreaScorer(area, target);
    const expected = score(target);
    const fixed = { ...target };
    target.x += 500;
    area.scoring!.area = 0;
    expect(score(fixed)).toEqual(expected);
    expect(() => score(fixed, Infinity)).toThrow("finite");
    expect(() => score({ x: NaN, y: 0 })).toThrow("finite");
  });
});

describe("Guessr source-cell area membership", () => {
  it("keeps the real western Fungal Caverns hole out of the Jungle", () => {
    const hole = { x: -256, y: 7424 };
    expect(containsArea(jungle, hole)).toBe(false);
    expect(containsArea(fungalWest, hole)).toBe(true);
    expect(containsArea(jungle, { x: -513, y: hole.y })).toBe(true);
    expect(containsArea(jungle, { x: 0, y: hole.y })).toBe(true);
  });

  it("does not credit a distant area merely because both are Fungal Caverns", () => {
    const target = center(fungalMain);
    const guess = center(fungalWest);
    expect(containsArea(fungalMain, guess)).toBe(false);
    expect(containsArea(fungalWest, target)).toBe(false);
    expect(scoreAreaGuess(fungalMain, target, guess)).toMatchObject({
      areaMatch: false,
      areaScore: 0,
      perfect: false,
    });
  });

  it("owns left/top edges and excludes right/bottom edges using the declared realm origin", () => {
    expect(containsArea(fungalWest, { x: -512, y: 7168 })).toBe(true);
    expect(containsArea(fungalWest, { x: -0.001, y: 7679.999 })).toBe(true);
    for (const point of [
      { x: 0, y: 7168 },
      { x: -512, y: 7680 },
      { x: -512.001, y: 7168 },
    ])
      expect(containsArea(fungalWest, point)).toBe(false);
    const shifted = {
      ...fungalWest,
      originY: -7168,
      bounds: { ...fungalWest.bounds!, y: 31744 },
    };
    expect(containsArea(shifted, { x: -256, y: 32000 })).toBe(true);
    expect(containsArea(shifted, center(fungalWest))).toBe(false);
    expect(containsArea(fungalWest, { x: NaN, y: 7168 })).toBe(false);
  });
});

describe("Guessr uniform area sampling", () => {
  it("weights unequal runs by native-pixel area and reaches every cell equally", () => {
    const area = mask([
      [0, 0, 1],
      [1, 0, 3],
    ]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const point = sampleAreaPoint(area, () => (i + 0.5) / 400);
      const key = `${Math.floor((point.x + 17920) / 512)},${Math.floor((point.y + 31744) / 512)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      "0,0": 100,
      "0,1": 100,
      "1,1": 100,
      "2,1": 100,
    });
  });

  it("weights clipped rows by their remaining pixels and never enters a hole", () => {
    // At this real Jungle/Fungal border, one row has 3 eligible pixels and the
    // next row only 1. Picking source cells or runs with equal probability fails.
    const clip = { x: -513, y: 7167, width: 3, height: 2 };
    const samples = [0, 1, 2, 3].map((i) =>
      sampleAreaPoint(jungle, () => (i + 0.5) / 4, clip),
    );
    expect(samples).toEqual([
      { x: -513, y: 7167 },
      { x: -512, y: 7167 },
      { x: -511, y: 7167 },
      { x: -513, y: 7168 },
    ]);
    expect(samples.every((point) => containsArea(jungle, point))).toBe(true);
    expect(sampleAreaPoint(jungle, () => 0, clip)).toEqual(samples[0]);
    expect(sampleAreaPoint(jungle, () => 1 - Number.EPSILON, clip)).toEqual(
      samples[3],
    );
  });

  it("clips fractional bounds on the native-pixel lattice without rounding outside them", () => {
    const clip = { x: -511.8, y: 7168.2, width: 2.6, height: 1.7 };
    expect(sampleAreaPoint(fungalWest, () => 0, clip)).toEqual({
      x: -511,
      y: 7169,
    });
    expect(sampleAreaPoint(fungalWest, () => 1 - Number.EPSILON, clip)).toEqual(
      { x: -510, y: 7169 },
    );
  });

  it("never fills a real hole with a bounding-box sample", () => {
    const random = () => 0.5;
    expect(() => sampleAreaPoint(jungle, random, fungalWest.bounds!)).toThrow(
      /no eligible/,
    );
    for (let i = 0; i < 104; i++) {
      const point = sampleAreaPoint(jungle, () => (i + 0.5) / 104);
      expect(containsArea(jungle, point)).toBe(true);
      expect(containsArea(fungalWest, point)).toBe(false);
    }
  });

  it("rejects empty clips and invalid random endpoints rather than producing out-of-mask points", () => {
    expect(() =>
      sampleAreaPoint(jungle, () => 0, { x: 0, y: 0, width: 0, height: 1 }),
    ).toThrow(/no eligible/);
    expect(() =>
      sampleAreaPoint(jungle, () => 0, { x: 0, y: 0, width: -1, height: 1 }),
    ).toThrow(/bounds/);
    for (const value of [-0.01, 1, NaN, Infinity])
      expect(() => sampleAreaPoint(jungle, () => value)).toThrow(
        /Random source/,
      );
  });
});

describe("Guessr area and position scores", () => {
  it.each([
    ["easy", 500, 4500],
    ["normal", 1000, 4000],
    ["hard", 3000, 2000],
  ] as const)(
    "uses the %s budgets and existing distance curve",
    (tier, areaScore, positionBudget) => {
      const area = mask([[0, 0, 20]], tier);
      const target = center(area);
      const near = { x: target.x + 64, y: target.y };
      expect(scoreAreaGuess(area, target, near)).toMatchObject({
        score: 5000,
        areaScore,
        positionScore: positionBudget,
        perfect: true,
        difficultyTier: tier,
      });
      const decayed = scoreAreaGuess(area, target, {
        x: target.x + 3064,
        y: target.y,
      });
      expect(decayed.areaScore).toBe(areaScore);
      expect(decayed.positionScore).toBe(Math.round(positionBudget / Math.E));
      expect(decayed.perfect).toBe(false);
    },
  );

  it("gives an adjacent wrong-area guess proximity points without an area award or perfect result", () => {
    const target = { x: -513, y: 7424 };
    const result = scoreAreaGuess(jungle, target, { x: -512, y: 7424 });
    expect(result).toMatchObject({
      distance: 1,
      areaMatch: false,
      areaScore: 0,
      positionScore: 4000,
      score: 4000,
      perfect: false,
    });
  });

  it("caps distant EDR recognition at its Normal 1000 area points", () => {
    // First and last source runs of the actual EDR union; the intervening mask
    // is irrelevant to this long-distance pair and is not fabricated here.
    const edr = {
      ...mask([
        [0, 1, 4],
        [143, 51, 69],
      ]),
      id: "terrain/edr",
      label: "extremely dense rock",
    };
    const result = scoreAreaGuess(edr, center(edr), { x: 16896, y: 41472 });
    expect(result).toMatchObject({
      areaMatch: true,
      areaScore: 1000,
      positionScore: 0,
      score: 1000,
      difficultyTier: "normal",
    });
    expect(
      curation.groups.find((group) => group.id === "terrain/edr")
        ?.difficultyTier,
    ).toBe("normal");
  });

  it("honors the Holy Mountain override instead of recomputing it from the Normal tier", () => {
    expect(
      scoreAreaGuess(holyMountain, center(holyMountain), center(holyMountain)),
    ).toMatchObject({
      areaScore: 1500,
      positionScore: 3500,
      difficultyTier: "normal",
      score: 5000,
    });
    expect(
      scoreAreaGuess(temple, center(temple), center(temple)),
    ).toMatchObject({
      areaScore: 500,
      positionScore: 4500,
      difficultyTier: "easy",
    });
  });

  it("scales both components by assistance and keeps the rounded sum within every cap", () => {
    const target = center(holyMountain);
    expect(scoreAreaGuess(holyMountain, target, target, 2500)).toMatchObject({
      score: 2500,
      areaScore: 750,
      positionScore: 1750,
      maximum: 2500,
      perfect: true,
    });
    for (const tier of ["easy", "normal", "hard"] as const) {
      const area = mask([[0, 0, 1]], tier);
      const target = center(area);
      for (const cap of [0, 1, 5, 9, 13, 2500, 4999, 5000]) {
        const result = scoreAreaGuess(area, target, target, cap);
        expect(result.score).toBe(cap);
        expect(result.areaScore + result.positionScore).toBe(result.score);
        expect(result.areaScore).toBeGreaterThanOrEqual(0);
        expect(result.positionScore).toBeGreaterThanOrEqual(0);
      }
    }
    expect(
      scoreAreaGuess(temple, center(temple), center(temple), 5),
    ).toMatchObject({ score: 5, areaScore: 1, positionScore: 4 });
    expect(scoreAreaGuess(holyMountain, target, target, 5001).maximum).toBe(
      5000,
    );
    expect(scoreAreaGuess(holyMountain, target, target, 12.9).score).toBe(12);
    expect(scoreAreaGuess(holyMountain, target, target, -1).score).toBe(0);
  });

  it("scales partial proximity and wrong-area scores, and gives no points for skipping", () => {
    const area = mask([[0, 0, 20]], "hard");
    const target = center(area);
    expect(
      scoreAreaGuess(area, target, { x: target.x + 3064, y: target.y }, 2500),
    ).toMatchObject({
      areaScore: 1500,
      positionScore: Math.round(1000 / Math.E),
    });
    expect(
      scoreAreaGuess(jungle, { x: -513, y: 7424 }, { x: -512, y: 7424 }, 2500),
    ).toMatchObject({ areaScore: 0, positionScore: 2000, score: 2000 });
    expect(scoreAreaGuess(area, target, null, 2500)).toEqual({
      score: 0,
      distance: null,
      areaScore: 0,
      positionScore: 0,
      areaMatch: false,
      perfect: false,
      maximum: 2500,
      difficultyTier: "hard",
    });
  });

  it("rejects invalid targets, guesses and score caps", () => {
    expect(() => scoreAreaGuess(jungle, center(fungalWest), null)).toThrow(
      /target.*outside/,
    );
    expect(() =>
      scoreAreaGuess(jungle, center(jungle), { x: Infinity, y: 0 }),
    ).toThrow(/finite/);
    expect(() => scoreAreaGuess(jungle, center(jungle), null, NaN)).toThrow(
      /finite/,
    );
  });
});

describe("Guessr pending area definitions", () => {
  const snowRule = curation.groups.find(
    (group) => group.id === "biome/snowy-wasteland",
  )!.difficultyRule as SnowDifficultyRule;
  const pendingSnow: AreaDefinition = {
    ...mask([[48, 16, 27]]),
    id: "biome/snowy-wasteland",
    label: "snowy wasteland",
    difficultyTier: null,
    scoring: null,
    difficultyRule: snowRule,
  };

  it("requires explicit original-view snow evidence and never chooses a default tier", () => {
    expect(resolveSnowDifficulty(true)).toBe("normal");
    expect(resolveSnowDifficulty(false)).toBe("hard");
    expect(() => resolveSnowDifficulty(undefined)).toThrow(
      /unknown.*requires review/,
    );
    expect(() => sampleAreaPoint(pendingSnow, () => 0)).toThrow(
      /snow classification.*unresolved/,
    );
    expect(() =>
      scoreAreaGuess(pendingSnow, center(pendingSnow), null),
    ).toThrow(/snow classification.*unresolved/);
    expect(() => containsArea(pendingSnow, center(pendingSnow))).toThrow(
      /snow classification.*unresolved/,
    );
  });

  it("uses a resolved frozen round tier without reclassifying from later coordinates", () => {
    for (const hasSnowPixels of [true, false]) {
      const tier = resolveSnowDifficulty(hasSnowPixels);
      const area = {
        ...pendingSnow,
        difficultyTier: tier,
        scoring: curation.scoringProfiles[tier],
      };
      const target = center(area);
      const result = scoreAreaGuess(area, target, {
        x: target.x + 4096,
        y: target.y,
      });
      expect(result.difficultyTier).toBe(tier);
      expect(result.areaScore).toBe(hasSnowPixels ? 1000 : 3000);
      expect(sampleAreaPoint(area, () => 0)).toEqual({ x: -9728, y: -7168 });
    }
    expect(pendingSnow.difficultyTier).toBeNull();
    expect(pendingSnow.scoring).toBeNull();
  });

  it("rejects the point-only final Holy Mountain and missing scoring", () => {
    const finalMountain: AreaDefinition = {
      id: "landmark/holy-mountain-final",
      label: "Holy Mountain (lowest, beside Kolmi)",
      difficultyTier: "easy",
      scoring: curation.scoringProfiles.easy,
    };
    expect(() => sampleAreaPoint(finalMountain, () => 0)).toThrow(
      /runs are missing/,
    );
    expect(() =>
      scoreAreaGuess(finalMountain, { x: 2590, y: 13144 }, null),
    ).toThrow(/runs are missing/);
    expect(() =>
      sampleAreaPoint({ ...jungle, scoring: null }, () => 0),
    ).toThrow(/scoring is missing/);
    expect(() =>
      scoreAreaGuess(
        { ...jungle, difficultyTier: undefined },
        center(jungle),
        null,
      ),
    ).toThrow(/difficulty tier/);
  });

  it("rejects overlapping masks, mismatched cells and invalid budgets instead of double weighting", () => {
    expect(() =>
      sampleAreaPoint(
        mask([
          [0, 0, 2],
          [0, 1, 3],
        ]),
        () => 0,
      ),
    ).toThrow(/nonoverlapping/);
    expect(() => sampleAreaPoint({ ...jungle, cells: 27 }, () => 0)).toThrow(
      /cell count/,
    );
    expect(() =>
      scoreAreaGuess(
        { ...jungle, scoring: { area: 1000, position: 5000, maximum: 5000 } },
        center(jungle),
        null,
      ),
    ).toThrow(/budgets/);
  });
});
