import { expect, it } from "vitest";
import {
  bottomElevatorStubs,
  includeElevatorOwnership,
  withoutElevatorEndpointSpawns,
} from "../src/telescope/terrain-elevator";
import { createTerrainOwnership } from "../src/telescope/terrain-policy";
import {
  serializeTileLayer,
  restoreTileLayer,
} from "../src/telescope/tile-layer-cache";
const ROBOT = 0xff4e5267;
function stub(x = 2, y = 47) {
  return {
    biomeName: "robobase",
    buffer: new Uint8Array(51 * 55 * 3),
    minX: x,
    minY: y,
    width: 51,
    mapH: 51,
    w: 510,
    h: 510,
    validChunks: new Set([`${x},${y}`]),
  };
}
it("detects only the real isolated bottom-row elevator stub, not the ordinary Power Plant", () => {
  const pixels = new Uint32Array(70 * 48).fill(0xff3d3d3d);
  pixels[47 * 70 + 2] = ROBOT;
  const elevator = stub(),
    ordinary = { ...stub(59, 35), validChunks: new Set(["59,35", "59,36"]) };
  const layers = [
    elevator,
    ordinary,
    { ...stub(3), biomeName: "the_end" },
    { ...stub(4), isFill: true },
  ];
  expect(bottomElevatorStubs(layers, pixels, 70)).toEqual([elevator]);
  expect(bottomElevatorStubs([stub(3)], pixels, 70)).toEqual([]);
  expect(bottomElevatorStubs([stub(2, 46)], pixels, 70)).toEqual([]);
});
it("uses actual chunk ownership instead of hardcoding the NG0 shaft coordinate", () => {
  const pixels = new Uint32Array(72 * 48);
  pixels[47 * 72 + 5] = ROBOT;
  const elevator = stub(5);
  expect(bottomElevatorStubs([elevator], pixels, 72)).toEqual([elevator]);
});
it("adds all lower-plane shaft rows and no neighboring rock or heaven/main cells", () => {
  const pixels = new Uint32Array(70 * 48),
    shafts = [stub()];
  for (const plane of [-1, 0, 1]) {
    const ownership = createTerrainOwnership([], pixels, {}, 70);
    includeElevatorOwnership(ownership, shafts, plane);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 70; x++) {
        const id = ownership.at(x * 512 - 17920, y * 512 - 7168);
        if (plane === 1 && x === 2)
          expect(ownership.names[id]).toBe("robobase");
        else expect(id).toBe(-1);
      }
  }
});
it("preserves existing sky/hell ownership when extending the isolated shaft", () => {
  const pixels = new Uint32Array(70 * 48).fill(1);
  const ownership = createTerrainOwnership(
    [{ ...stub(35, 15), biomeName: "the_end" }],
    pixels,
    { the_end: { color: 1, wangFile: "end" } },
    70,
  );
  const before = ownership.owners.slice();
  includeElevatorOwnership(ownership, [stub()], 1);
  for (let i = 0; i < before.length; i++)
    if (i % 70 !== 2) expect(ownership.owners[i]).toBe(before[i]);
});
it("preserves shaft buffers and absolute source origin through worker/bake serialization", () => {
  const shaft = {
    ...stub(),
    mapH: 2509,
    h: 25090,
    validChunks: new Set(
      Array.from({ length: 49 }, (_, row) => `2,${row + 47}`),
    ),
  };
  const restored = restoreTileLayer(serializeTileLayer(shaft));
  expect(restored.buffer).toEqual(shaft.buffer);
  expect(restored.validChunks).toEqual(shaft.validChunks);
  expect([restored.minX, restored.minY, restored.mapH]).toEqual([2, 47, 2509]);
});

it("replaces only the fake lower endpoint's spawns, preserving all other biome scans", () => {
  const main = [
    { sourceBiome: "robobase", x: -16600, y: 17300 },
    { sourceBiome: "robobase", x: 14000, y: 10000 },
    { sourceBiome: "robobase", x: -16600, y: 6000 },
    { sourceBiome: "the_end", x: -16600, y: 17300 },
  ];
  expect(withoutElevatorEndpointSpawns(main, [2], 70)).toEqual(main.slice(1));
  expect(withoutElevatorEndpointSpawns(main, [], 70)).toBe(main);
  expect(main).toHaveLength(4);
});
