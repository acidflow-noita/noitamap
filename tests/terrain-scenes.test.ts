import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  applySceneVisualArt,
  applySceneForceAir,
  createSceneTileCompositor,
  type TerrainSceneData,
} from "../src/telescope/terrain-scenes";

const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());
const rock = [80, 60, 40, 255],
  backdrop = [2, 3, 4, 255],
  clear = [0, 0, 0, 0];
function fixture(): TerrainSceneData {
  return {
    scenes: [
      { key: "mines/test", name: "test", x: 0, y: 0, width: 3, height: 1 },
    ],
    sources: {
      "mines/test": {
        data: rgba(clear, clear, clear),
        width: 3,
        height: 1,
        backgroundArt: {
          data: rgba(backdrop, backdrop, backdrop),
          width: 3,
          height: 1,
        },
      },
    },
  };
}
describe("full-pixel scene paint order", () => {
  it("clears actual terrain for force-air instead of hiding it behind a flat color", () => {
    const scene = createSceneTileCompositor(fixture(), () => ({
      pixels: rgba(clear, clear, clear),
      airMask: rgba(clear, [0, 0, 0, 255], clear),
    }));
    const terrain = rgba(rock, rock, rock),
      background = rgba(clear, clear, clear);
    scene.paint(terrain, background, 0, 0, 3, 1);
    expect(terrain).toEqual(rgba(rock, clear, rock));
    expect(background).toEqual(rgba(backdrop, backdrop, backdrop));
  });
  it("leaves untouched cells alone and replaces the cell beneath translucent material", () => {
    const water = [0, 50, 200, 128];
    const scene = createSceneTileCompositor(fixture(), () => ({
      pixels: rgba(clear, water, clear),
      airMask: rgba(clear, [0, 0, 0, 255], clear),
    }));
    const terrain = rgba(rock, rock, rock),
      background = rgba(clear, clear, clear);
    scene.paint(terrain, background, 0, 0, 3, 1);
    expect(terrain).toEqual(rgba(rock, water, rock));
  });
  it("paints acid-tank glass with its opaque art while leaving air empty", () => {
    const source = {
      data: rgba(clear, clear, clear),
      width: 3,
      height: 1,
      visualArt: { data: rgba(rock, rock, rock), width: 3, height: 1 },
    };
    const pixels = rgba(clear, [20, 30, 40, 128], [1, 2, 3, 255]);
    applySceneVisualArt(pixels, source);
    expect(pixels).toEqual(rgba(clear, rock, rock));
  });
  it("matches upstream scene art for every cell/art alpha and clipped art bounds", () => {
    const upstream = readFileSync(
      new URL("../lib/noita-telescope-vm/js/pixel_scene_generation.js", import.meta.url),
      "utf8",
    ).match(/export function overlayVisualArt\([\s\S]*?\n\}/)?.[0];
    expect(upstream, "Review the changed upstream scene-art boundary").toBeTruthy();
    const overlay = new Function(
      `${upstream!.replace("export ", "")}; return overlayVisualArt;`,
    )();
    const width = 259, height = 256, artWidth = 256;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const art = new Uint8ClampedArray(artWidth * (height + 1) * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        pixels.set([23, 79, 183, y], (y * width + x) * 4);
        if (x < artWidth) art.set([239, 141, 37, x], (y * artWidth + x) * 4);
      }
    const visualArt = { data: art, width: artWidth, height: height + 1 };
    const expected = overlay(pixels, width, height, visualArt);
    applySceneVisualArt(pixels, { data: pixels, width, height, visualArt });
    expect(pixels).toEqual(new Uint8ClampedArray(expected));
  });
  it("caches by placed instance, not shared variant, and preserves game paint order", () => {
    const data = fixture();
    data.scenes.push({ ...data.scenes[0], x: 1 });
    const paint = vi.fn((scene) => ({
      pixels: rgba(
        [scene.x, 0, 0, 255],
        [scene.x, 0, 0, 255],
        [scene.x, 0, 0, 255],
      ),
      airMask: null,
    }));
    const compositor = createSceneTileCompositor(data, paint);
    const terrain = rgba(clear, clear, clear, clear),
      background = terrain.slice();
    compositor.paint(terrain, background, 0, 0, 4, 1);
    expect(terrain).toEqual(
      rgba([0, 0, 0, 255], [1, 0, 0, 255], [1, 0, 0, 255], [1, 0, 0, 255]),
    );
    compositor.paint(terrain, background, 0, 0, 4, 1);
    expect(paint).toHaveBeenCalledTimes(2);
  });
  it("paints a background at its native extent, not stretched to the scene", () => {
    const data = fixture();
    data.sources["mines/test"].backgroundArt = {
      data: rgba(backdrop, backdrop, backdrop, backdrop),
      width: 4,
      height: 1,
    };
    const compositor = createSceneTileCompositor(data, () => ({
      pixels: rgba(clear, clear, clear),
      airMask: null,
    }));
    const terrain = rgba(rock, rock),
      background = rgba(clear, clear);
    compositor.paint(terrain, background, 3, 0, 2, 1);
    expect(background).toEqual(rgba(backdrop, clear));
    expect(terrain).toEqual(rgba(rock, rock));
  });
});

it("does not copy Telescope's opaque-air display exceptions into shop/capsule geometry", () => {
  const p = {
    pixels: rgba([80, 180, 230, 255], [10, 20, 30, 255]),
    airMask: null as Uint8Array | null,
  };
  applySceneForceAir(rgba([0, 0, 66, 255], [255, 255, 255, 255]), p);
  expect(p.pixels).toEqual(rgba([80, 180, 230, 0], [10, 20, 30, 255]));
  expect(Array.from(p.airMask!)).toEqual(
    Array.from(rgba([0, 0, 0, 255], clear)),
  );
});
