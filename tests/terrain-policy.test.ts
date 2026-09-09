import { describe, it, expect } from "vitest";
import {
  createTerrainOwnership,
  createPlaneOwnership,
  createBackgroundOwnership,
} from "../src/telescope/terrain-policy";
import {
  planeAtWorldY,
  prepareTerrainPlane,
} from "../src/telescope/terrain-planes";
import {
  compositeTerrain,
  textureColor,
} from "../src/telescope/terrain-backgrounds";
import { terrainTileKey } from "../src/telescope/terrain-tile-store";
it("does not paint winter cave bounding boxes or fill biomes over static brown rock", () => {
  const pixels = new Uint32Array(70 * 48).fill(2);
  pixels[70 * 20 + 15] = 1;
  const layers = [
    {
      biomeName: "winter_caves",
      buffer: new Uint8Array(4),
      validChunks: new Set(["15,20", "16,20"]),
      w: 2000,
      h: 2000,
    },
    {
      biomeName: "winter",
      isFill: true,
      buffer: null,
      validChunks: new Set(["16,20"]),
    },
  ];
  const policy = createTerrainOwnership(
    layers,
    pixels,
    {
      winter_caves: { color: 1, wangFile: "snowchasm.png" },
      winter: { color: 2, fillMaterial: "rock" },
    },
    70,
  );
  expect(policy.at(15 * 512 - 17920, 20 * 512 - 7168)).toBe(0);
  expect(policy.at(16 * 512 - 17920, 20 * 512 - 7168)).toBe(-1);
  expect(policy.at(14 * 512 - 17920, 20 * 512 - 7168)).toBe(-1);
});
it("keeps statically painted room exclusions even when they have buffers", () => {
  const p = new Uint32Array(70 * 48).fill(1);
  const policy = createTerrainOwnership(
    [
      {
        biomeName: "dragoncave",
        buffer: new Uint8Array(4),
        validChunks: new Set(["1,1"]),
      },
    ],
    p,
    { dragoncave: { color: 1, wangFile: "static.png" } },
    70,
  );
  expect(policy.at(-17408, -6656)).toBe(-1);
});
it("covers all three vertical planes with no gaps/overlap at the seams", () => {
  expect(
    [-31744, -7169, -7168, 17407, 17408, 41983, 41984].map(planeAtWorldY),
  ).toEqual([-1, -1, 0, 0, 1, 1, null]);
});
it("keeps background texture world anchoring at native resolution", () => {
  const texture = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
  };
  expect(textureColor(texture, 0, 0)).toBe(0xff010203);
  expect(textureColor(texture, 1, 0)).toBe(0xff040506);
  expect(textureColor(texture, -1, 0)).toBe(0xff040506);
  expect(compositeTerrain(0, 0xff010203)).toBe(0xff010203);
  expect(compositeTerrain(0x800000ff, 0xffff0000)).toBe(0xff7f0080);
});
it("never confuses cached terrain between seed, plane, world or geometry", () => {
  const key = terrainTileKey(1, "normal", 0, 0, "bounds", 4, 0, 0);
  expect(key).not.toBe(terrainTileKey(1, "normal", 1, 0, "bounds", 4, 0, 0));
  expect(key).not.toBe(terrainTileKey(2, "normal", 0, 0, "bounds", 4, 0, 0));
  expect(key).not.toBe(terrainTileKey(1, "normal", 0, 1, "bounds", 4, 0, 0));
});

it("heaven and hell reuse source Wang buffers; row broadcast changes materials only", async () => {
  const pixels = new Uint32Array(70 * 48).fill(2);
  pixels.fill(3, 0, 70);
  pixels.fill(4, 47 * 70);
  const tileLayers = [
    {
      buffer: new Uint8Array([10, 20, 30]),
      biomeName: "coalmine",
      validChunks: new Set(["35,15"]),
    },
  ];
  const gen = {
    biomeData: { pixels },
    tileLayers,
    seed: 786433191,
    isNGP: false,
  };
  for (const plane of [-1, 1] as const) {
    const vertical = await prepareTerrainPlane(gen, plane);
    expect(vertical.tileLayers).toBe(tileLayers);
    expect(vertical.tileLayers[0].buffer).toBe(tileLayers[0].buffer);
    expect(vertical.sourceBiomeData).toBe(gen.biomeData);
    expect(new Set(vertical.biomeData.pixels)).toEqual(
      new Set([plane < 0 ? 3 : 4]),
    );
    expect(await prepareTerrainPlane(gen, plane)).toBe(vertical);
  }
  expect(pixels[70 * 15 + 35]).toBe(2);
});
it("vertical material bands cannot fill main-world gaps, static rock or holy mountains", () => {
  const source = new Uint32Array(70 * 48).fill(9),
    paint = new Uint32Array(70 * 48).fill(3);
  source[70 * 15 + 35] = 1;
  source[70 * 16 + 35] = 2;
  const layers = [
    {
      biomeName: "coalmine",
      buffer: new Uint8Array(3),
      validChunks: new Set(["35,15", "36,15"]),
    },
    {
      biomeName: "temple_altar",
      buffer: new Uint8Array(3),
      validChunks: new Set(["35,16"]),
    },
  ];
  const config = {
    coalmine: { color: 1, wangFile: "mines" },
    temple_altar: { color: 2, wangFile: "temple" },
    the_sky: { color: 3, wangFile: "sky" },
  };
  const ownership = createPlaneOwnership(layers, source, paint, config, 70);
  expect(ownership.names[ownership.at(0, 512)]).toBe("the_sky");
  expect(ownership.at(512, 512)).toBe(-1);
  expect(ownership.at(0, 1024)).toBe(-1);
  expect(ownership.at(0, 1536)).toBe(-1);
});

it("hell's native background continues through gaps without adding terrain", () => {
  const pixels = new Uint32Array(70 * 48).fill(3);
  const terrain = createTerrainOwnership([], pixels, {}, 70);
  const background = createBackgroundOwnership(
    terrain,
    pixels,
    { the_end: { color: 3, wangFile: "end" } },
    1,
  );
  expect(terrain.at(0, 1024)).toBe(-1);
  expect(background.names[background.at(0, 1024)]).toBe("the_end");
  expect(createBackgroundOwnership(terrain, pixels, {}, 0)).toBe(terrain);
});
