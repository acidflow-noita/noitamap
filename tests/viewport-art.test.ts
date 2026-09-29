// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import Flatbush from "flatbush";
import { drawViewportArt } from "../src/telescope/viewport-art";
import { createPixelSceneTileSource } from "../src/telescope/pixel-scene-tile-source";
import { createMarkerTileSource } from "../src/telescope/marker-tile-source";
import { createBiomeBackgroundTiles } from "../src/telescope/biome-background-tile-source";
import { setSpoilerFree } from "../src/spoiler-free";

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

let OSD: any;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return createCanvas(this.width || 1, this.height || 1).getContext(
        "2d",
      ) as any;
    },
  );
  OSD = (await import("openseadragon")).default;
  vi.stubGlobal("OpenSeadragon", OSD);
  OSD.pixelDensityRatio = 1;
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const pixels = (canvas: any) =>
  Buffer.from(
    canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
      .data,
  );
const itemAt = (x = 0, y = 0, scale = 1) => ({
  opacity: 1,
  imageToViewportCoordinates: (ix: number, iy: number) => ({
    x: x + ix * scale,
    y: y + iy * scale,
  }),
});
const viewport = { pixelFromPoint: (point: { x: number; y: number }) => point };
function art(width: number, height: number, color: string) {
  const image = createCanvas(width, height) as any;
  image.getContext("2d").fillStyle = color;
  image.getContext("2d").fillRect(0, 0, width, height);
  image.close = vi.fn();
  return image;
}

describe("direct viewport artwork with native canvas", () => {
  it('averages native artwork when zooming out, without changing its source pixels', () => {
    const source = art(64, 64, '#ff0000'), ctx = source.getContext('2d');
    ctx.fillStyle = '#0000ff';
    for (let x = 1; x < 64; x += 2) ctx.fillRect(x, 0, 1, 64);
    const output = createCanvas(32, 32), target = output.getContext('2d');
    drawViewportArt(target as any, itemAt(0, 0, .5), viewport, 64, 64, () => target.drawImage(source, 0, 0));
    const reduced = target.getImageData(10, 10, 1, 1).data;
    expect(reduced[0]).toBeGreaterThan(100);
    expect(reduced[2]).toBeGreaterThan(100);
    expect([...ctx.getImageData(10, 10, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it("composes density, rotation and drawer flip while restoring context and preserving lower layers", () => {
    OSD.pixelDensityRatio = 2;
    const output = createCanvas(128, 96),
      expected = createCanvas(128, 96);
    for (const canvas of [output, expected]) {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#145890";
      ctx.fillRect(0, 0, 128, 96);
      ctx.translate(128, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.8;
    }
    const ctx = output.getContext("2d"),
      before = ctx.getTransform();
    const drawn = drawViewportArt(
      ctx as any,
      { ...itemAt(5, 7), opacity: 0.5 },
      {
        pixelFromPoint: (p: any) => ({ x: 50 - p.y, y: p.x }),
      },
      20,
      15,
      (bounds) => {
        expect(bounds.scale).toBe(2);
        ctx.fillStyle = "#e94421";
        ctx.fillRect(-20, -20, 100, 100);
      },
    );
    const ref = expected.getContext("2d");
    ref.save();
    ref.globalAlpha *= 0.5;
    ref.transform(0, 2, -2, 0, 86, 10);
    ref.fillStyle = "#e94421";
    ref.fillRect(0, 0, 20, 15);
    ref.restore();
    expect(drawn).toBe(true);
    expect(pixels(output)).toEqual(pixels(expected));
    expect(ctx.getTransform()).toEqual(before);
    expect(ctx.globalAlpha).toBeCloseTo(0.8);
    OSD.pixelDensityRatio = 1;
  });

  it("renders scenes at exact authored size in stable instance order without tile requests or readback", () => {
    const a = art(13, 11, "#ed1122"),
      b = art(9, 7, "#22bb4480");
    a.getContext("2d").clearRect(2, 2, 3, 3);
    const f = createPixelSceneTileSource({
      generationId: 900,
      items: [
        { osdX: -90, osdY: -40, w: 13, h: 11, sceneKey: "a" },
        { osdX: -85, osdY: -36, w: 9, h: 7, sceneKey: "b" },
        { osdX: 90000, osdY: 500, w: 13, h: 11, sceneKey: "a" },
      ],
      bitmapByKey: new Map([
        ["a", a],
        ["b", b],
      ]),
    });
    const output = createCanvas(64, 48),
      expected = createCanvas(64, 48);
    const ctx = output.getContext("2d");
    const read = vi.spyOn(ctx, "getImageData"),
      tile = vi.spyOn(f.source, "downloadTileStart");
    const draw = vi.spyOn(ctx, "drawImage");
    try {
      expect(f.source.__drawViewport(ctx, itemAt(-40, -42), viewport)).toBe(
        true,
      );
      expect(read).not.toHaveBeenCalled();
      expect(tile).not.toHaveBeenCalled();
      expect(draw).toHaveBeenCalledTimes(2);
      const ref = expected.getContext("2d");
      ref.drawImage(a, 10, 8);
      ref.drawImage(b, 15, 12);
      expect(pixels(output)).toEqual(pixels(expected));
      expect(f.source.sceneTileStats.rendered).toBe(0);
      f.source.destroy();
      draw.mockClear();
      f.source.__drawViewport(ctx, itemAt(), viewport);
      expect(draw).not.toHaveBeenCalled();
    } finally {
      f.source.destroy();
    }
  });

  it.each([-35840, 0, 35840])(
    "keeps native background phase at PW offset %s and clips holes without clearing lower layers",
    (offset) => {
      const texture = art(3, 2, "#ffff00");
      const t = texture.getContext("2d");
      t.fillStyle = "#12aabb";
      t.fillRect(1, 0, 1, 1);
      const ring = [
        { x: -7, y: -5 },
        { x: 17, y: -5 },
        { x: 17, y: 13 },
        { x: -7, y: 13 },
      ];
      const hole = [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
      ];
      const pack = createBiomeBackgroundTiles({
        regions: [{ rings: [ring, hole], textureKey: "a" }],
        textures: new Map([["a", texture]]),
        originX: -7,
        originY: -5,
        width: 24,
        height: 18,
        phaseX: -11,
        phaseY: -8,
      });
      const source = pack.createSource(offset),
        output = createCanvas(24, 18),
        expected = createCanvas(24, 18);
      for (const canvas of [output, expected]) {
        const c = canvas.getContext("2d");
        c.fillStyle = "#d01564";
        c.fillRect(0, 0, 24, 18);
      }
      try {
        expect(
          source.__drawViewport(output.getContext("2d"), itemAt(), viewport),
        ).toBe(true);
        const ref = expected.getContext("2d"),
          tex = texture.getContext("2d").getImageData(0, 0, 3, 2).data;
        for (let y = 0; y < 18; y++)
          for (let x = 0; x < 24; x++) {
            const gx = x - 7,
              gy = y - 5;
            if (gx >= 0 && gx < 4 && gy >= 0 && gy < 3) continue;
            const tx = (((gx + offset + 11) % 3) + 3) % 3,
              ty = (((gy + 8) % 2) + 2) % 2,
              i = (ty * 3 + tx) * 4;
            ref.fillStyle = `rgb(${tex[i]},${tex[i + 1]},${tex[i + 2]})`;
            ref.fillRect(x, y, 1, 1);
          }
        expect(pixels(output)).toEqual(pixels(expected));
        expect(pack.stats.rendered).toBe(0);
        source.destroy();
        const after = pixels(output);
        source.__drawViewport(output.getContext("2d"), itemAt(), viewport);
        expect(pixels(output)).toEqual(after);
      } finally {
        pack.destroy();
      }
    },
  );

  it("bounds coarse background work by visible regions and preserves native texture assets", () => {
    const texture = art(96, 96, "#918152"),
      pack = createBiomeBackgroundTiles({
        regions: [
          {
            rings: [
              [
                { x: 0, y: 0 },
                { x: 100000, y: 0 },
                { x: 100000, y: 100000 },
                { x: 0, y: 100000 },
              ],
            ],
            textureKey: "a",
          },
        ],
        textures: new Map([["a", texture]]),
        originX: 0,
        originY: 0,
        width: 100000,
        height: 100000,
        phaseX: 0,
        phaseY: 0,
      });
    const canvas = createCanvas(100, 100),
      ctx = canvas.getContext("2d"),
      pattern = vi.spyOn(ctx, "createPattern"),
      draw = vi.spyOn(ctx, "drawImage");
    try {
      pack.createSource().__drawViewport(ctx, itemAt(0, 0, 0.001), viewport);
      expect(pattern).toHaveBeenCalledTimes(1);
      expect(draw).not.toHaveBeenCalled();
      expect(texture.width).toBe(96);
      expect(texture.close).not.toHaveBeenCalled();
    } finally {
      pack.destroy();
    }
  });

  it("draws atlas layers and rotated wands without a LOD cutoff, retaining spoiler substitutions", () => {
    const sprite = art(20, 8, "#cc4400"),
      sctx = sprite.getContext("2d");
    sctx.fillStyle = "#0088cc";
    sctx.fillRect(10, 0, 10, 8);
    const items = [
      {
        poi: {},
        pw: 0,
        spriteKey: ["item:a", "item:b"],
        osdX: 15,
        osdY: 12,
        w: 10,
        h: 8,
      },
      {
        poi: { isTaikasauva: true },
        pw: 0,
        spriteKey: "item:a",
        osdX: 35,
        osdY: 20,
        w: 10,
        h: 8,
      },
    ];
    const index = new Flatbush(items.length);
    for (const i of items)
      index.add(
        i.osdX - i.w / 2,
        i.osdY - i.h / 2,
        i.osdX + i.w / 2,
        i.osdY + i.h / 2,
      );
    index.finish();
    const atlas = {
      "item:a": { x: 0, y: 0, w: 10, h: 8, ox: 2, oy: 3 },
      "item:b": { x: 10, y: 0, w: 10, h: 8, ox: 6, oy: 2 },
      "spell:_unidentified": { x: 10, y: 0, w: 4, h: 4 },
    };
    const source = createMarkerTileSource({
      index,
      spritesheet: sprite,
      atlas,
      items,
      originX: 0,
      originY: 0,
      bboxWidth: 64,
      bboxHeight: 48,
    } as any);
    const output = createCanvas(64, 48),
      expected = createCanvas(64, 48),
      ref = expected.getContext("2d");
    try {
      source.__drawViewport(output.getContext("2d"), itemAt(), viewport);
      ref.drawImage(sprite, 0, 0, 10, 8, 13, 9, 10, 8);
      ref.drawImage(sprite, 10, 0, 10, 8, 13, 9, 10, 8);
      ref.save();
      ref.translate(38, 21);
      ref.rotate(-Math.PI / 2);
      ref.drawImage(sprite, 0, 0, 10, 8, -5, -4, 10, 8);
      ref.restore();
      expect(pixels(output)).toEqual(pixels(expected));
      const draw = vi.spyOn(output.getContext("2d"), "drawImage");
      source.__drawViewport(
        output.getContext("2d"),
        itemAt(0, 0, 0.01),
        viewport,
      );
      expect(draw).toHaveBeenCalledTimes(3);
      setSpoilerFree(true);
      draw.mockClear();
      source.__drawViewport(output.getContext("2d"), itemAt(), viewport);
      expect(draw).toHaveBeenCalledTimes(2);
      expect(
        draw.mock.calls.every((call) => call[1] === 10 && call[3] === 4),
      ).toBe(true);
    } finally {
      setSpoilerFree(false);
      source.destroy();
    }
  });
});
