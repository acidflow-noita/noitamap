import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  reduce2,
  saveCore,
  corePath,
  makeParent,
  writeOverlap,
  maxLevel,
  levelSize,
} from "../build_scripts/terrain-pyramid.mjs";

describe("native lossless terrain pyramid", () => {
  it("averages all pixels with premultiplied alpha, not hidden black/color values", () => {
    const source = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0,
    ]);
    expect([...reduce2(source, 2, 2).data]).toEqual([255, 0, 0, 128]);
    expect([...reduce2(Buffer.from([9, 8, 7, 255]), 1, 1).data]).toEqual([
      9, 8, 7, 64,
    ]);
  });
  it("derives stable mips and identical overlap pixels at odd world edges", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "terrain-pyramid-"));
    try {
      const width = 1027,
        height = 515,
        max = maxLevel(width, height),
        world = "middle";
      const full = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          full[i] = x % 251;
          full[i + 1] = y % 241;
          full[i + 2] = (x + y) % 239;
          full[i + 3] = (x + y) % 7 ? 255 : 128;
        }
      for (let ty = 0; ty < 2; ty++)
        for (let tx = 0; tx < 3; tx++) {
          const w = Math.min(512, width - tx * 512),
            h = Math.min(512, height - ty * 512),
            data = Buffer.alloc(w * h * 4);
          for (let y = 0; y < h; y++)
            full.copy(
              data,
              y * w * 4,
              ((ty * 512 + y) * width + tx * 512) * 4,
              ((ty * 512 + y) * width + tx * 512 + w) * 4,
            );
          await saveCore(corePath(dir, world, max, tx, ty), data, w, h);
        }
      const parent = levelSize(width, height, max, max - 1);
      for (let tx = 0; tx < 2; tx++)
        await makeParent({
          cores: dir,
          world,
          level: max - 1,
          childWidth: width,
          childHeight: height,
          tx,
          ty: 0,
          width: Math.min(512, parent.width - tx * 512),
          height: parent.height,
          path: corePath(dir, world, max - 1, tx, 0),
        });
      const direct = reduce2(full, width, height);
      const tail = await sharp(
        await readFile(corePath(dir, world, max - 1, 1, 0)),
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let y = 0; y < tail.info.height; y++)
        expect(
          tail.data.subarray(
            y * tail.info.width * 4,
            (y + 1) * tail.info.width * 4,
          ),
        ).toEqual(
          direct.data.subarray(
            (y * direct.width + 512) * 4,
            (y * direct.width + direct.width) * 4,
          ),
        );
      const leftPath = resolve(dir, "left.webp"),
        rightPath = resolve(dir, "right.webp");
      await writeOverlap({
        cores: dir,
        world,
        level: max,
        tx: 0,
        ty: 0,
        levelWidth: width,
        levelHeight: height,
        path: leftPath,
      });
      await writeOverlap({
        cores: dir,
        world,
        level: max,
        tx: 1,
        ty: 0,
        levelWidth: width,
        levelHeight: height,
        path: rightPath,
      });
      const a = await sharp(leftPath)
          .raw()
          .toBuffer({ resolveWithObject: true }),
        b = await sharp(rightPath).raw().toBuffer({ resolveWithObject: true });
      expect(a.info.width).toBe(514);
      expect(b.info.width).toBe(516);
      for (let y = 0; y < 512; y++)
        expect(
          a.data.subarray((y * 514 + 510) * 4, (y * 514 + 514) * 4),
        ).toEqual(b.data.subarray(y * 516 * 4, (y * 516 + 4) * 4));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
