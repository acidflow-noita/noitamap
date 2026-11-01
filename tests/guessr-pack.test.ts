import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { prepareRanked } from "../build_scripts/guessr/prepare-ranked.mjs";
import { privateOutput } from "../build_scripts/guessr/private-output.mjs";
import sharp from "sharp";
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("private ranked pack preparation", () => {
  it("strips source metadata carrying a seed or coordinates", async () => {
    const root = await mkdtemp(join(tmpdir(), "guessr-metadata-"));
    cleanup.push(root);
    const pack = JSON.parse(
      await readFile("public/guessr/practice/pack.json", "utf8"),
    );
    const questions = [];
    for (let i = 0; i < 10; i++) {
      const image = join(root, `private-${i}.png`);
      await sharp({
        create: {
          width: 256,
          height: 256,
          channels: 3,
          background: { r: 40 + i * 20, g: 70, b: 90 },
        },
      })
        .withMetadata({
          exif: { IFD0: { ImageDescription: "seed=1234,x=-555,y=777" } },
        })
        .png()
        .toFile(image);
      questions.push({
        image,
        name: "Private",
        biome: "Mines",
        x: 0,
        y: 0,
        seed: 1234,
      });
    }
    const path = join(root, "input.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        visibility: "private",
        days: [
          {
            day: "2026-10-12",
            title: "Private",
            bounds: pack.bounds,
            questions,
          },
        ],
      }),
    );
    await prepareRanked(path, join(root, "out"));
    const sql = await readFile(join(root, "out/private-import.sql"), "utf8"),
      name = sql.match(/[a-f0-9]{64}\.webp/)![0];
    const bytes = await readFile(join(root, "out/assets", name)),
      metadata = await sharp(bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(bytes.includes(Buffer.from("seed=1234"))).toBe(false);
  });
  it("rejects output under public build and tracked repository paths", () => {
    for (const path of [
      "public/guessr/private",
      "src/guessr/answers",
      "dist/private",
      "workers/noitamap-guessr/private-assets/answers",
    ])
      expect(() => privateOutput(path)).toThrow("Keep private packs");
    expect(privateOutput("task/guessr/private/preview")).toBe(
      resolve("task/guessr/private/preview"),
    );
  });
  it("keeps public fixtures disabled and writes only opaque asset filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "guessr-pack-"));
    cleanup.push(root);
    const pack = JSON.parse(
      await readFile("public/guessr/practice/pack.json", "utf8"),
    );
    const input = {
      version: 1,
      visibility: "public-fixture",
      days: [
        {
          day: "2026-10-12",
          title: "A 'quoted' title",
          enabled: true,
          bounds: pack.bounds,
          questions: pack.places.slice(0, 10).map((p: any) => ({
            ...p,
            seed: pack.seed,
            image: resolve("public" + p.image),
          })),
        },
      ],
    };
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(input));
    await expect(prepareRanked(path, join(root, "blocked"))).rejects.toThrow(
      "private pack",
    );
    const result = await prepareRanked(path, join(root, "allowed"), {
      allowPublicFixture: true,
    });
    expect(result[0].enabled).toBe(false);
    const sql = await readFile(
      join(root, "allowed/private-import.sql"),
      "utf8",
    );
    expect(sql).toContain("A ''quoted'' title");
    expect(sql.match(/[a-f0-9]{64}\.webp/g)).toHaveLength(10);
    expect(sql).not.toContain("/guessr/practice/");
  });
  it("rejects duplicate clues and missing rounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "guessr-pack-"));
    cleanup.push(root);
    const pack = JSON.parse(
      await readFile("public/guessr/practice/pack.json", "utf8"),
    );
    const q = {
      ...pack.places[0],
      seed: pack.seed,
      image: resolve("public" + pack.places[0].image),
    };
    const input = {
      version: 1,
      visibility: "private",
      days: [
        {
          day: "2026-10-12",
          title: "Test",
          bounds: pack.bounds,
          questions: [q],
        },
      ],
    };
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(input));
    await expect(prepareRanked(path, join(root, "out"))).rejects.toThrow(
      "Exactly ten",
    );
    input.days[0].questions = Array(10).fill(q);
    await writeFile(path, JSON.stringify(input));
    await expect(prepareRanked(path, join(root, "out"))).rejects.toThrow(
      "Duplicate",
    );
  });
});
