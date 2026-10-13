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
  it("preserves every RGBA byte for opaque, transparent, mixed-alpha and odd reductions", () => {
    // Deliberately simple independent box-filter oracle, including the current
    // four-sample denominator at odd image boundaries and hidden color bytes.
    const reference = (pixels: Uint8Array, width: number, height: number) => {
      const w = Math.ceil(width / 2),
        h = Math.ceil(height / 2);
      const out = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const color = [0, 0, 0];
          let alpha = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              if (x * 2 + dx >= width || y * 2 + dy >= height) continue;
              const p = ((y * 2 + dy) * width + x * 2 + dx) * 4;
              alpha += pixels[p + 3];
              for (let c = 0; c < 3; c++)
                color[c] += pixels[p + c] * pixels[p + 3];
            }
          const p = (y * w + x) * 4;
          if (alpha)
            for (let c = 0; c < 3; c++)
              out[p + c] = Math.round(color[c] / alpha);
          out[p + 3] = Math.round(alpha / 4);
        }
      return out;
    };
    let seed = 0x12345678;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let n = 0; n < 96; n++) {
      const width = n < 4 ? [1, 2, 17, 18][n] : 1 + (random() % 131);
      const height = n < 4 ? [1, 2, 18, 17][n] : 1 + (random() % 129);
      const pixels = Buffer.alloc(width * height * 4);
      for (let p = 0; p < pixels.length; p += 4) {
        pixels.writeUInt32LE(random(), p);
        if (n % 4 === 0) pixels[p + 3] = 0;
        else if (n % 4 === 1) pixels[p + 3] = 255;
        else if (n % 4 === 2) pixels[p + 3] = random() % 3;
      }
      expect(
        reduce2(pixels, width, height).data,
        `case ${n}, ${width}x${height}`,
      ).toEqual(reference(pixels, width, height));
    }
  });

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
