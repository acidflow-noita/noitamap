import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorkerData } from "../build_scripts/guessr/prepare-worker-data.mts";
import { createPreparedRoundSource } from "../src/guessr/prepared-rounds";
import {
  framesForPoint,
  type PrivateImageSet,
} from "../src/guessr/image-game-server";
import { prepareAreaStarts } from "../src/guessr/starting-view";
import type { AreaDefinition } from "../src/guessr/area-rules";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(areaIds = ['private-area-0', 'private-area-1'], random = () => 0.375) {
  const root = await mkdtemp(join(tmpdir(), "guessr-worker-data-"));
  temporary.push(root);
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
    version: "fixture-version",
    images,
    levels: { 11: { images: grid } },
    capture: {
      sha256: "fixture-source",
      originX: -17920,
      originY: 0,
      width: 2048,
      height: 1024,
      tileSize: 512,
      overlap: 2,
      maxLevel: 11,
    },
  };
  const areas: AreaDefinition[] = areaIds.map((id, ordinal) => ({
    id,
    label: "Private area " + ordinal,
    originY: 0,
    runs: [[ordinal % 2, 0, 4]],
    cells: 4,
    bounds: { x: -17920, y: (ordinal % 2) * 512, width: 2048, height: 512 },
    difficultyTier: "normal",
    scoring: { area: 1000, position: 4000, maximum: 5000 },
  }));
  const inventory = {
    capture: { sha256: index.capture.sha256 },
    puzzleAreas: [...areas, { ...areas[0], id: "unreviewed", scoring: null }],
  };
  const indexPath = join(root, "index.json"),
    inventoryPath = join(root, "inventory.json");
  await Promise.all([
    writeFile(indexPath, JSON.stringify(index)),
    writeFile(inventoryPath, JSON.stringify(inventory)),
  ]);
  const outputDirectory = join(root, "private"),
    publicConfigPath = join(root, "public/config.json");
  const options = {
    indexPath,
    inventoryPath,
    outputDirectory,
    publicConfigPath,
    referenceRoot: "https://reference.test/map_files/",
  };
  const report = await prepareWorkerData(options);
  const requests: string[] = [];
  const source = createPreparedRoundSource(
    async (path) => {
      requests.push(path);
      return new Response(await readFile(join(outputDirectory, path)), {
        headers: {
          "Content-Type": path.endsWith("json")
            ? "application/json"
            : "application/octet-stream",
        },
      });
    },
    "/images",
    options.referenceRoot,
    random,
  );
  return { index, areas, inventory, source, requests, report, options };
}

describe("prepared private Worker rounds", () => {
  it.each([3, 10])('shares one Holy Mountain/brickwork slot across all depths in a %i-round game', async count => {
    const ids = [1, 2, 3, 4, 5, 6, 'final'].map(depth => `landmark/holy-mountain-${depth}`);
    ids.push(...Array.from({ length: 12 }, (_, n) => `biome/fixture-${n}`));
    const f = await fixture(ids, () => 0);
    for (let game = 0; game < 2; game++) {
      const rounds = await f.source.sampleRounds(count);
      expect(rounds).toHaveLength(count);
      expect(rounds.filter(r => r.area.id.startsWith('landmark/holy-mountain-'))).toHaveLength(1);
      expect(new Set(rounds.map(r => r.area.id)).size).toBe(count);
      for (const round of rounds) {
        expect(round.area).toMatchObject(f.areas.find(area => area.id === round.area.id)!);
        expect(prepareAreaStarts(f.index, round.area).contains(round.answer)).toBe(true);
      }
    }
    expect(f.areas.map(area => area.id)).toEqual(ids);
  });

  it('does not refill the Holy Mountain family when a small collection repeats other areas', async () => {
    const f = await fixture(['landmark/holy-mountain-final', 'landmark/holy-mountain-1', 'biome/other'], () => 0);
    const rounds = await f.source.sampleRounds(10);
    expect(rounds.map(r => r.area.id)).toEqual(['landmark/holy-mountain-final', ...Array(9).fill('biome/other')]);
    const onlyMountains = await fixture(['landmark/holy-mountain-1', 'landmark/holy-mountain-final'], () => 0);
    await expect(onlyMountains.source.sampleRounds(3)).rejects.toThrow('Not enough eligible puzzle areas');
  });

  it("samples exact eligible points and the same opaque frames without decoding pixel masks", async () => {
    const f = await fixture(),
      rounds = await f.source.sampleRounds(2);
    expect(new Set(rounds.map((r) => r.area.id)).size).toBe(2);
    for (const round of rounds) {
      expect(
        prepareAreaStarts(f.index, round.area).contains(round.answer),
      ).toBe(true);
      expect(round.frames).toEqual(
        framesForPoint(f.index, round.answer, "/images"),
      );
    }
    const requests = [...f.requests];
    await f.source.sampleRounds(2);
    expect(f.requests).toEqual(requests);
    expect(f.report.areas).toBe(2);
    expect(f.report.excluded).toEqual(["unreviewed"]);
    expect(f.report.gridBytes).toBe(12 + 8 * 16);
    expect(f.report.positions).toBe(321 * 257);
  });

  it("exports only safe reference configuration for Pages and keeps all sampling data private", async () => {
    const f = await fixture(),
      config = await f.source.config();
    expect(
      JSON.parse(await readFile(f.options.publicConfigPath, "utf8")),
    ).toEqual(config);
    const text = JSON.stringify(config);
    for (const forbidden of [
      "private-area",
      "fixture-source",
      "answer",
      "starts",
      "positions",
      "native-grid",
    ])
      expect(text).not.toContain(forbidden);
    expect(config.map.tiles).toBe("https://reference.test/map_files/");
  });

  it("rejects mismatched captures before packaging and rejects corrupt binary masks", async () => {
    const f = await fixture();
    f.inventory.capture.sha256 = "different-capture";
    await writeFile(f.options.inventoryPath, JSON.stringify(f.inventory));
    await expect(prepareWorkerData(f.options)).rejects.toThrow(
      "same captured map",
    );
    const catalog = JSON.parse(
      await readFile(
        join(f.options.outputDirectory, "game-data/catalog.json"),
        "utf8",
      ),
    );
    const bad = createPreparedRoundSource(
      async (path) => {
        if (path.includes("/starts/")) return new Response(new Uint8Array(9));
        return new Response(
          await readFile(join(f.options.outputDirectory, path)),
        );
      },
      "/images",
      "/reference/",
      () => 0,
    );
    await expect(bad.sampleRounds(1)).rejects.toThrow("starting positions");
    expect(catalog.areas).toHaveLength(2);
    await expect(bad.sampleRounds(100)).rejects.toThrow("round count");
  });
});
