import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { prepareCapturedMap } from "../build_scripts/guessr/prepare-captured-map.mjs";
import { readRegion } from "../build_scripts/guessr/prepare-clues.mjs";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("captured map tiles", () => {
  it("preserves native RGB through overlapping tile boundaries and uneven right/bottom edges", async () => {
    const root = await mkdtemp(join(tmpdir(), "guessr-capture-"));
    cleanup.push(root);
    const width = 83,
      height = 139,
      input = join(root, "source.png"),
      out = join(root, "out");
    const pixels = Buffer.from(
      Array.from(
        { length: width * height * 3 },
        (_, i) => (i * 17 + Math.floor(i / width) * 23) % 256,
      ),
    );
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(input);
    const options = { originX: -42, originY: -53, tileSize: 32 };
    const meta = await prepareCapturedMap(input, out, options);
    expect(meta).toMatchObject({
      width,
      height,
      maxLevel: 8,
      originX: -42,
      originY: -53,
    });
    expect(await readFile(join(out, "map.dzi"), "utf8")).toContain(
      'Format="webp"',
    );
    for (const rect of [
      { left: 0, top: 0, width, height },
      { left: 19, top: 30, width: 27, height: 12 },
      { left: 61, top: 118, width: 22, height: 21 },
    ]) {
      const crop = await readRegion(out, meta, {
        x: rect.left + options.originX,
        y: rect.top + options.originY,
        width: rect.width,
        height: rect.height,
      });
      const expected = await sharp(input)
        .extract(rect)
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(crop.data.equals(expected)).toBe(true);
    }
    expect(await prepareCapturedMap(input, out, options)).toEqual(meta);
    expect(
      (await prepareCapturedMap(input, out, { ...options, originX: -84 }))
        .originX,
    ).toBe(-84);
  });
});
