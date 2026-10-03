// @ts-ignore — generated engine asset manifest; no browser dependencies.
import { SCENE_BACKGROUNDS } from "../lib/noita-telescope-vm/js/pixel_scene_backgrounds.js";
import { beforeAll, describe, expect, it } from "vitest";
import { encode } from "fast-png";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import sharp from "sharp";
import { decodePngToRgba } from "../src/telescope/png-decode";
import { compositeTerrain } from "../src/telescope/terrain-backgrounds";
import { createSceneTileCompositor } from "../src/telescope/terrain-scenes";

function trns(png: Uint8Array, values: number[]): ArrayBuffer {
  // Truecolor/grayscale tRNS is a source-depth sample key, always stored as
  // big-endian 16-bit values in the chunk. fast-png only encodes palette tRNS.
  const chunk = Buffer.alloc(12 + values.length * 2);
  chunk.writeUInt32BE(values.length * 2, 0);
  chunk.write("tRNS", 4);
  values.forEach((value, i) => chunk.writeUInt16BE(value, 8 + i * 2));
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  // PNG signature + IHDR = 33 bytes; tRNS goes before IDAT.
  return new Uint8Array(
    Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]),
  ).buffer;
}
const arrayBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
function normalizedRGBA(bytes: Uint8Array) {
  const rgba = new Uint8ClampedArray(bytes);
  for (let i = 0; i < rgba.length; i += 4)
    if (!rgba[i + 3]) rgba.fill(0, i, i + 4);
  return rgba;
}

describe("PNG authored color-key transparency", () => {
  it.each([
    [107, 0, 128],
    [255, 0, 0],
    [255, 96, 0],
    [128, 0, 128],
  ])("honors RGB tRNS %i,%i,%i without erasing other art", (r, g, b) => {
    const png = encode({
      width: 3,
      height: 1,
      channels: 3,
      data: new Uint8Array([r, g, b, 28, 36, 18, r, g, b ^ 1]),
    });
    const out = decodePngToRgba(trns(png, [r, g, b]));
    expect(Array.from(out.data)).toEqual([
      0,
      0,
      0,
      0,
      28,
      36,
      18,
      255,
      r,
      g,
      b ^ 1,
      255,
    ]);
  });
  it("does not guess a transparent color from the top-left pixel", () => {
    const png = encode({
      width: 2,
      height: 1,
      channels: 3,
      data: new Uint8Array([107, 0, 128, 0, 0, 0]),
    });
    expect(Array.from(decodePngToRgba(arrayBuffer(png)).data)).toEqual([
      107, 0, 128, 255, 0, 0, 0, 255,
    ]);
  });
  it("honors grayscale tRNS", () => {
    const png = encode({
      width: 3,
      height: 1,
      channels: 1,
      data: new Uint8Array([0, 120, 121]),
    });
    expect(Array.from(decodePngToRgba(trns(png, [120])).data)).toEqual([
      0, 0, 0, 255, 0, 0, 0, 0, 121, 121, 121, 255,
    ]);
  });
  it.each([1, 3] as const)(
    "compares %i-channel 16-bit keys before rounding to 8-bit",
    (channels) => {
      const key = new Array(channels).fill(0x8080);
      const png = encode({
        width: 3,
        height: 1,
        channels,
        depth: 16,
        data: new Uint16Array([...key, ...key.map((v) => v + 1), ...key]),
      });
      expect(Array.from(decodePngToRgba(trns(png, key)).data)).toEqual([
        0, 0, 0, 0, 128, 128, 128, 255, 0, 0, 0, 0,
      ]);
    },
  );
  it("preserves palette tRNS and partial alpha", () => {
    const png = encode({
      width: 3,
      height: 1,
      channels: 1,
      depth: 8,
      palette: [
        [107, 0, 128, 0],
        [28, 36, 18, 128],
        [1, 2, 3, 255],
      ],
      data: new Uint8Array([0, 1, 2]),
    });
    expect(Array.from(decodePngToRgba(arrayBuffer(png)).data)).toEqual([
      0, 0, 0, 0, 28, 36, 18, 128, 1, 2, 3, 255,
    ]);
  });
});

describe("actual scene-background assets (independent native PNG reference)", () => {
  let zip: JSZip;
  beforeAll(async () => {
    zip = await JSZip.loadAsync(
      await readFile(new URL("../public/data.zip", import.meta.url)),
    );
  });
  for (const path of [
    "rainforest/plantlife",
    "rainforest/hut01",
    "snowcave/snowcastle",
    "snowcave/horizontalobservatory",
    "snowcave/horizontalobservatory3",
    "snowcave/verticalobservatory",
    "snowcave/tinyobservatory",
    "vault/lab2",
  ]) {
    it(`decodes every pixel of ${path}_background.png identically to native libvips`, async () => {
      const bytes = await zip
        .file(`data/biome_impl/${path}_background.png`)!
        .async("uint8array");
      const decoded = decodePngToRgba(arrayBuffer(bytes));
      const native = await sharp(bytes, { ignoreIcc: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([decoded.width, decoded.height]).toEqual([
        native.info.width,
        native.info.height,
      ]);
      expect(
        Buffer.from(decoded.data).equals(
          Buffer.from(normalizedRGBA(native.data)),
        ),
      ).toBe(true);
      expect(decoded.data[3]).toBe(0);
      expect(decoded.data.some((a, i) => i % 4 === 3 && a > 0)).toBe(true);
    });
  }
  it("preserves native RGBA for every engine-listed scene background, not just the reported colors", async () => {
    const paths = new Set<string>(
      Object.values(SCENE_BACKGROUNDS).map((path) =>
        String(path).replace(/^data\/backgrounds\//, "data/"),
      ),
    );
    for (const path of paths) {
      const file = zip.file(path);
      expect(file, `missing original scene background ${path}`).not.toBeNull();
      const bytes = await file!.async("uint8array");
      const decoded = decodePngToRgba(arrayBuffer(bytes));
      // Compare authored samples, not Photoshop ICC-adjusted display colors.
      const native = await sharp(bytes, { ignoreIcc: true })
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(
        Buffer.from(decoded.data).equals(Buffer.from(normalizedRGBA(native))),
        path,
      ).toBe(true);
    }
  });
  it("keeps the screenshot's purple area transparent through actual scene compositing", async () => {
    const bytes = await zip
      .file("data/biome_impl/rainforest/plantlife_background.png")!
      .async("uint8array");
    const backgroundArt = decodePngToRgba(arrayBuffer(bytes));
    const { width, height } = backgroundArt;
    const sources = {
      plantlife: {
        width,
        height,
        data: new Uint8Array(width * height * 4),
        backgroundArt,
      },
    };
    const compositor = createSceneTileCompositor(
      {
        sources,
        scenes: [
          { key: "plantlife", name: "plantlife", x: 0, y: 0, width, height },
        ],
      },
      () => ({ pixels: sources.plantlife.data, airMask: null }),
    );
    const terrain = new Uint8ClampedArray(width * height * 4),
      background = terrain.slice();
    for (let i = 0; i < background.length; i += 4)
      background.set([12, 20, 8, 255], i);
    compositor.paint(terrain, background, 0, 0, width, height);
    expect(Array.from(background.subarray(0, 4))).toEqual([12, 20, 8, 255]);
    for (let i = 0; i < background.length; i += 4) {
      const s = backgroundArt.data;
      const rgba =
        ((s[i + 3] << 24) | (s[i] << 16) | (s[i + 1] << 8) | s[i + 2]) >>> 0;
      const expected = compositeTerrain(rgba, 0xff0c1408);
      const actual =
        ((background[i + 3] << 24) |
          (background[i] << 16) |
          (background[i + 1] << 8) |
          background[i + 2]) >>>
        0;
      expect(actual).toBe(expected);
    }
  });
});
