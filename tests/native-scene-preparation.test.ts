import { expect, it } from "vitest";
import { createMaterialAtlas } from "../src/native-map/cook-inputs/atlas";
import {
  createNativeScenePreparer,
  prepareNativeScene,
  prepareNativeScenes,
  type NativeScenePreparationResources,
  type NativeScenePlacement,
} from "../src/native-map/composition/prepare-scenes";

const rgba = (...pixels: number[][]) => new Uint8Array(pixels.flat());
function resources(): NativeScenePreparationResources {
  const atlas = createMaterialAtlas(
    { width: 2, height: 1, textures: { "wall.png": [0, 0, 2, 1] } },
    rgba([9, 19, 29, 255], [99, 89, 79, 0]),
    [
      {
        name: "wall",
        wang: "0x112233",
        texture_color: "0xff102030",
        color: "0xff102030",
        texture: "wall.png",
      },
      {
        name: "water",
        wang: "0x223344",
        texture_color: "0xff203040",
        color: "0x80203040",
      },
    ],
    "scene-unit",
  );
  return {
    atlas,
    generatorConfig: { room: { color: 1 } },
    engineBiomes: [{ color: 1, bands: [{}] }],
    materialNames: ["air", "wall", "water"],
    wangMaterialIds: [
      [0x112233, 1],
      [0x223344, 2],
    ],
    fillBiomeMaterials: { 1: "wall" },
    fillLayerMaterials: {},
    biomeForegroundColors: {},
    biomeBackgroundColors: { room: 0x445566 },
    bands: {
      resolveCoverageBandPoints(points) {
        return Int32Array.from(points, (p) => (p.x % 3 ? 1 : -1));
      },
    },
  };
}
function placement(
  width: number,
  extra: Partial<NativeScenePlacement> = {},
): NativeScenePlacement {
  return {
    key: "general/test",
    name: "test",
    variantKey: "biome=room",
    x: 0,
    y: 0,
    width,
    height: 1,
    ...extra,
  };
}
it("keeps ordered substitution cascades even in transparent source RGB", () => {
  const input = rgba([0x11, 0x22, 0x33, 255], [0x11, 0x22, 0x33, 0]);
  const scene = prepareNativeScene(
    placement(2, { variantKey: "112233=abcdef&abcdef=223344&biome=room" }),
    { width: 2, height: 1, data: input },
    resources(),
  );
  expect(scene.pixels).toEqual(
    rgba([0x20, 0x30, 0x40, 128], [0x22, 0x33, 0x44, 0]),
  );
  expect(scene.edge.grid).toEqual(new Int16Array([2, -2]));
  expect(scene.eraseMask).toEqual(rgba([0, 0, 0, 255], [0, 0, 0, 0]));
  expect(input).toEqual(rgba([0x11, 0x22, 0x33, 255], [0x11, 0x22, 0x33, 0]));
});
it("retains transparent texel material identity without manufacturing an erase", () => {
  const scene = prepareNativeScene(
    placement(2),
    {
      width: 2,
      height: 1,
      data: rgba([0x11, 0x22, 0x33, 128], [0x11, 0x22, 0x33, 255]),
    },
    resources(),
  );
  expect(scene.pixels).toEqual(rgba([9, 19, 29, 128], [0x11, 0x22, 0x33, 0]));
  expect(scene.eraseMask).toBeNull();
  expect(scene.edge.grid).toEqual(new Int16Array([1, 1]));
});
it("preserves density-to-air, force-air RGB, art threshold and source-alpha distinctions", () => {
  const scene = prepareNativeScene(
    placement(4, { name: "friendroom" }),
    {
      width: 4,
      height: 1,
      data: rgba(
        [255, 255, 255, 255],
        [0, 0, 66, 255],
        [0x22, 0x33, 0x44, 255],
        [0, 0, 0, 0],
      ),
      visualArt: {
        width: 4,
        height: 1,
        data: rgba(
          [200, 0, 0, 255],
          [200, 0, 0, 255],
          [200, 0, 0, 255],
          [200, 0, 0, 255],
        ),
      },
    },
    resources(),
  );
  expect(scene.pixels).toEqual(
    rgba(
      [255, 255, 255, 0],
      [0x44, 0x55, 0x66, 0],
      [200, 0, 0, 255],
      [0, 0, 0, 0],
    ),
  );
  expect(scene.edge.grid).toEqual(new Int16Array([0, 0, 2, -2]));
  expect(scene.edge.artMask).toEqual(new Uint8Array([0b11100000]));
  expect(scene.sourceAlpha).toEqual(new Uint8Array([255, 255, 255, 0]));
  expect(scene.eraseMask).toEqual(
    rgba([0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 0]),
  );
});
it("resolves the entire scene in bounded borrowed-output batches", () => {
  const r = resources(),
    batches: number[] = [],
    borrowed = new Int32Array(4096);
  r.bands = {
    resolveCoverageBandPoints(points) {
      batches.push(points.length);
      points.forEach((p, i) => {
        expect(p.coverage).toBe(1);
        borrowed[i] = p.x % 2 ? 2 : -1;
      });
      return borrowed.subarray(0, points.length);
    },
  };
  const source = {
    width: 8200,
    height: 1,
    data: new Uint8Array(8200 * 4).fill(255),
  };
  const prepare = createNativeScenePreparer(r),
    scene = prepare(placement(8200), source);
  expect(batches).toEqual([4096, 4096, 8]);
  for (let p = 0; p < 8200; p++) expect(scene.edge.grid[p]).toBe(p % 2 ? 2 : 0);
  expect(scene.width).toBe(8200);
});
it("single and bounded-batch APIs preserve placement order and expose source metadata", () => {
  const r = resources(),
    data = { width: 1, height: 1, data: rgba([0x22, 0x33, 0x44, 255]) };
  const placements = [placement(1, { x: 100 }), placement(1, { x: -100 })];
  const scenes = prepareNativeScenes(placements, { "general/test": data }, r);
  expect(scenes.map((s) => s.x)).toEqual([100, -100]);
  expect(scenes[0].key).toBe("general/test");
  expect(scenes[0]).toEqual(prepareNativeScene(placements[0], data, r));
});
it("rejects missing resources and invalid full-scene dimensions", () => {
  expect(() =>
    createNativeScenePreparer({ ...resources(), bands: undefined as any }),
  ).toThrow(/resources/);
  expect(() =>
    prepareNativeScene(
      placement(2),
      { width: 1, height: 1, data: rgba([0, 0, 66, 255]) },
      resources(),
    ),
  ).toThrow(/bounds differ/);
});
