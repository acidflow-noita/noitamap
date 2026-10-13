import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { BIOME_ENGINE } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import type { MaterialInputs } from "../src/native-map/materials";

// Production Vite aliases the fork package; unit tests load those same real modules.
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/topo2_resolve.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/engine_data.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/engine_data.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/band_select.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/band_select.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/chunk_wobble.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js"),
);

const binary = readFile(
  new URL("../src/native-map/materials/owned-materials.wasm", import.meta.url),
);
function inputs(): MaterialInputs {
  const mapWidth = 70,
    cells = mapWidth * 48;
  return {
    mapWidth,
    lattice: {
      GW: 19,
      GH: 17,
      cov: new Float32Array(19 * 17).fill(1),
      mat: new Uint16Array(19 * 17).fill(2),
      chunkCovered: new Uint8Array(cells).fill(1),
    },
    biomePixels: new Uint32Array(cells).fill(18175),
    hostChunks: new Uint32Array(cells).fill(256),
    parameters: [
      { scale: 1, threshold: 0.5, type: 0 },
      { scale: 1, threshold: 0.5, type: 0 },
    ],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("preserves CPU host guards and explicit JS fallback at unknown boundaries", async () => {
  const bytes = await binary;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes)),
  );
  const { createNativeMaterialResolver } =
    await import("../src/native-map/materials");
  const input = inputs(),
    unknown = 15 * input.mapWidth + 34;
  (input.biomePixels as Uint32Array)[unknown] = 0x123456;
  input.hostChunks[unknown] = 512;
  const resolver = await createNativeMaterialResolver(input);
  expect(resolver).not.toBeNull();
  expect(resolver!.resolve(-23, 512, 1, 1)[0]).toBe(-1);
  expect(resolver!.resolve(0, -7169, 1, 1)[0]).toBe(0);
  expect(resolver!.resolve(0, 17408, 1, 1)[0]).toBe(0);
  expect(resolver!.resolve(100, 800, 1, 1)[0]).toBe(1);
  input.hostChunks.fill(2048);
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 800, 1, 1)[0],
  ).toBe(0);
  input.hostChunks.fill(256);
  input.lattice.chunkCovered.fill(0);
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 800, 1, 1)[0],
  ).toBe(-1);
  input.lattice.chunkCovered.fill(1);
  (input.biomePixels as Uint32Array).fill(
    BIOME_ENGINE.find((b: any) => b.supported && b.topo === 0)!.color,
  );
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 800, 1, 1)[0],
  ).toBe(-1);
  input.plane = { offsetY: 24576 };
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 25376, 1, 1)[0],
  ).toBe(-1);
  (input.biomePixels as Uint32Array).fill(0x123456);
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 25376, 1, 1)[0],
  ).toBe(-1);
  (input.biomePixels as Uint32Array).fill(18175);
  input.hostChunks.fill(512);
  expect(
    (await createNativeMaterialResolver(input))!.resolve(100, 25376, 1, 1)[0],
  ).toBe(-1);
});

it("bounds the optional foreground wait and reuses a download completed later", async () => {
  const bytes = await binary;
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const fetcher = vi.fn(() => pending);
  vi.stubGlobal("fetch", fetcher);
  const { createNativeMaterialResolver } =
    await import("../src/native-map/materials");
  const started = performance.now();
  expect(await createNativeMaterialResolver(inputs())).toBeNull();
  expect(performance.now() - started).toBeLessThan(500);
  complete(new Response(bytes));
  expect(await createNativeMaterialResolver(inputs())).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("matches absolute plane and local shaft coordinates across samplers and parallel seams", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(await binary)),
  );
  const { createNativeMaterialResolver } =
    await import("../src/native-map/materials");
  const { createPlaneMaterialField } =
    await import("../src/telescope/plane-material-field");
  const { WANG_PARAMS_BY_ID } =
    await import("noita-telescope-full-pixels/engine_resolve/engine_data.js");
  const { setTopo2WorldOffX } =
    await import("noita-telescope-full-pixels/engine_resolve/topo2_resolve.js");
  let compared = 0;
  for (const mapWidth of [64, 70]) {
    setTopo2WorldOffX(mapWidth * 256);
    for (const type of [0, 1, 2]) {
      const input = inputs();
      input.mapWidth = mapWidth;
      input.biomePixels = new Uint32Array(mapWidth * 48).fill(18175);
      input.hostChunks = new Uint32Array(mapWidth * 48).fill(256);
      // Plane helpers intentionally ignore main-plane chunkCovered.
      input.lattice.chunkCovered = new Uint8Array(mapWidth * 48);
      input.parameters = WANG_PARAMS_BY_ID.map(
        ([scale, threshold, type]: number[]) => ({ scale, threshold, type }),
      );
      const material = WANG_PARAMS_BY_ID.findIndex(
        (p: number[]) => p[2] === type && p[0] > 0,
      );
      input.lattice.mat.fill(material + 1);
      for (let i = 0; i < input.lattice.cov.length; i++)
        input.lattice.cov[i] = [0, 0.25, 0.5, 0.75, 1][i % 5];
      for (const plane of [-1, 1])
        for (const originX of [undefined, 0, 1433, -409.25]) {
          const offsetY = plane * 24576;
          const localOffset = plane * Math.trunc((33 * 512) / 10) * 10;
          input.plane = { offsetY };
          if (originX !== undefined)
            input.plane.shafts = [mapWidth / 2 - 1, mapWidth / 2].map(
              (column) => ({
                column,
                lattice: input.lattice,
                offsetY: localOffset,
                originX,
              }),
            );
          const reference = createPlaneMaterialField(
            input.lattice,
            input.biomePixels as Uint32Array,
            mapWidth,
            originX === undefined ? offsetY : localOffset,
            originX,
          );
          const resolver = await createNativeMaterialResolver(input);
          expect(resolver).not.toBeNull();
          for (const pw of [-1, 0, 1]) {
            const x = pw * mapWidth * 512 - 18,
              y = offsetY + 507,
              width = 48,
              height = 24;
            const values = resolver!.resolve(x, y, width, height);
            const expected = new Int32Array(width * height);
            for (let row = 0; row < height; row++)
              for (let col = 0; col < width; col++)
                expected[row * width + col] = reference(x + col, y + row);
            expect(
              values,
              JSON.stringify({ mapWidth, type, plane, originX, pw }),
            ).toEqual(expected);
            compared += values.length;
          }
        }
    }
  }
  expect(compared).toBe(165888);
}, 30000);

it("keeps shaft precedence, duplicate-column semantics and clipping independent of host flags", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(await binary)),
  );
  const { createNativeMaterialResolver } =
    await import("../src/native-map/materials");
  const input = inputs(),
    offsetY = 24576;
  input.hostChunks.fill(2048);
  const air = {
    ...input.lattice,
    cov: new Float32Array(input.lattice.cov.length),
  };
  const shaft = { column: 35, lattice: input.lattice, offsetY, originX: 0 };
  input.plane = { offsetY, shafts: [{ ...shaft, lattice: air }, shaft] };
  const resolver = (await createNativeMaterialResolver(input))!;
  expect(resolver).not.toBeNull();
  const values = resolver.resolve(-1, offsetY + 100, 2, 1);
  expect([...values]).toEqual([0, 1]);
  expect([...resolver.resolve(0, offsetY - 7169, 1, 2)]).toEqual([0, 1]);
  expect([...resolver.resolve(0, offsetY + 17407, 1, 2)]).toEqual([1, 0]);
  const copy = resolver.resolve(0, offsetY, 2, 2).slice();
  await createNativeMaterialResolver(inputs());
  expect([...copy]).toEqual([1, 1, 1, 1]);
  input.plane.shafts = [shaft, { ...shaft, lattice: air }];
  expect(
    (await createNativeMaterialResolver(input))!.resolve(0, offsetY, 1, 1)[0],
  ).toBe(0);
});

it("rejects invalid or unbounded plane configurations before optional code delivery", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { createNativeMaterialResolver } =
    await import("../src/native-map/materials");
  const input = inputs();
  for (const offsetY of [NaN, Infinity, 0.5, 2 ** 31]) {
    input.plane = { offsetY };
    expect(await createNativeMaterialResolver(input)).toBeNull();
  }
  input.plane = {
    offsetY: 24576,
    shafts: [
      { column: -1, lattice: input.lattice, offsetY: 24576, originX: 0 },
    ],
  };
  expect(await createNativeMaterialResolver(input)).toBeNull();
  input.plane.shafts = Array.from({ length: 71 }, (_, column) => ({
    column,
    lattice: input.lattice,
    offsetY: 24576,
    originX: 0,
  }));
  expect(await createNativeMaterialResolver(input)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
