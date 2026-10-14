import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import {
  createPageComposer,
  createStrictEdgeStamper,
  compositeRGBA,
  type PageCompositionInputs,
  type PreparedScene,
} from "../src/native-map/composition";
import {
  buildEdgeTables,
  EDGE_ATLAS_WIDTH,
} from "../src/native-map/edges/data";
import {
  setEdgeDecalAtlas,
  stampEdgeDecals,
} from "../lib/noita-telescope-vm/js/edge_decals.js";
import { syntheticCases } from "./helpers/native-edge-cases";

let wasm: Uint8Array<ArrayBuffer>, atlas: Uint8Array<ArrayBuffer>;
let strict: Awaited<ReturnType<typeof createStrictEdgeStamper>>;
const tables = buildEdgeTables();
beforeAll(async () => {
  const files = await Promise.all([
    readFile(new URL("../src/native-map/edges/core.wasm", import.meta.url)),
    readFile(
      new URL("../lib/noita-telescope-vm/data/edge_atlas.bin", import.meta.url),
    ),
  ]);
  wasm = Uint8Array.from(files[0]);
  atlas = Uint8Array.from(files[1]);
  setEdgeDecalAtlas(atlas);
  strict = await createStrictEdgeStamper(wasm, {
    tables,
    atlas,
    atlasWidth: EDGE_ATLAS_WIDTH,
  });
});

for (const test of syntheticCases())
  it(`strict owned edge adapter preserves RGBA and sequential materials: ${test.name}`, () => {
    const reference = structuredClone(test),
      actual = structuredClone(test);
    const expected = stampEdgeDecals(
      reference.mat,
      test.width,
      test.height,
      test.originX,
      test.originY,
      test.worldSeed,
      reference.opts,
    );
    const result = strict.stamp(
      actual.mat,
      test.width,
      test.height,
      test.originX,
      test.originY,
      test.worldSeed,
      {
        chunkShiftX: test.opts.chunkShiftX ?? 0,
        chunkShiftY: test.opts.chunkShiftY ?? 0,
        inset: test.opts.inset ?? 0,
        scenes: actual.opts.scenes ?? [],
        skipSeamAt: () => false,
      },
    );
    assert.equal(Buffer.compare(Buffer.from(result), Buffer.from(expected)), 0);
    assert.equal(
      Buffer.compare(
        Buffer.from(actual.mat.buffer),
        Buffer.from(reference.mat.buffer),
      ),
      0,
    );
  });

const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());
const blank = [0, 0, 0, 0],
  red = [200, 20, 10, 255],
  blue = [10, 20, 200, 255];
function inputs(
  extra: Partial<PageCompositionInputs> = {},
): PageCompositionInputs {
  return {
    seed: 123,
    worldWidth: 35840,
    scenes: [],
    staticMasks: [],
    liquidSurfaces: [],
    materialAt: () => 0,
    ownsTerrain: () => true,
    backgroundAt: () => 0xff101820,
    liquidColor: () => 0x800028c8,
    sceneAirBackground: () => 0xffc8c8c8,
    edgeStamper: strict,
    chunkShiftX: 0,
    chunkShiftY: 0,
    skipSeamAt: () => false,
    ...extra,
  };
}
function scene(
  pixels: Uint8ClampedArray,
  extra: Partial<PreparedScene> = {},
): PreparedScene {
  const width = pixels.length / 4;
  return {
    x: 0,
    y: 0,
    width,
    height: 1,
    pixels,
    eraseMask: null,
    sourceAlpha: new Uint8Array(width).fill(255),
    backgroundArt: null,
    edge: {
      x: 0,
      y: 0,
      width,
      height: 1,
      grid: new Int16Array(width).fill(-2),
      skipEdges: true,
    },
    ...extra,
  };
}
it("keeps scene background extent, erase-before-translucency, and both static clear stages", () => {
  const s = scene(rgba(blank, [0, 40, 200, 128], blank), {
    eraseMask: rgba(blank, [0, 0, 0, 255], [0, 0, 0, 255]),
    backgroundArt: {
      width: 5,
      height: 1,
      data: rgba(blue, blue, blue, blue, blue),
    },
  });
  const compose = createPageComposer(
    inputs({
      scenes: [s],
      staticMasks: [
        {
          x: 0,
          y: 0,
          width: 5,
          height: 1,
          bits: new Uint8Array([0b10000]),
          airBits: new Uint8Array([1]),
        },
      ],
    }),
  );
  const foreground = rgba(red, red, red, blank, red),
    before = foreground.slice();
  const result = compose({ x: 0, y: 0, width: 5, height: 1, foreground });
  expect(result).toEqual(rgba(blue, [5, 30, 200, 255], blue, blue, blank));
  expect(foreground).toEqual(before);
});
it("paints every scene background before scene air fallback and preserves ordinal foreground order", () => {
  const first = scene(rgba(blank, red), {
    eraseMask: rgba([0, 0, 0, 255], blank),
  });
  const second = scene(rgba(blank, [10, 50, 90, 128]), {
    backgroundArt: { width: 2, height: 1, data: rgba(blue, blue) },
  });
  const compose = createPageComposer(
    inputs({ backgroundAt: () => 0, scenes: [first, second] }),
  );
  expect(
    compose({ x: 0, y: 0, width: 2, height: 1, foreground: rgba(red, red) }),
  ).toEqual(rgba(blue, [105, 35, 50, 255]));
});
it("liquid leveling uses the external bottom probe and leaves the original material field for edges", () => {
  const reads: number[][] = [];
  const materialAt = (x: number, y: number) => {
    reads.push([x, y]);
    return y === 16 ? 4 : 0;
  };
  const compose = createPageComposer(
    inputs({
      liquidSurfaces: [{ left: 0, right: 10, y: 10, material: 4 }],
      materialAt,
    }),
  );
  const result = compose({
    x: 0,
    y: 10,
    width: 1,
    height: 1,
    foreground: rgba(blank),
  });
  expect(result).toEqual(rgba([8, 32, 116, 255]));
  expect(reads).toContainEqual([0, 16]);
});
it("fails without complete inputs instead of publishing a missing finish stage", () => {
  expect(() =>
    createPageComposer(inputs({ edgeStamper: undefined as any })),
  ).toThrow(/edge stamper/);
  expect(() =>
    createPageComposer(
      inputs({
        scenes: [scene(rgba(blank), { sourceAlpha: undefined as any })],
      }),
    ),
  ).toThrow(/alpha coverage/);
  const compose = createPageComposer(inputs({ readMaterials() {} }));
  expect(() =>
    compose({ x: 0, y: 0, width: 1, height: 1, foreground: rgba(red) }),
  ).toThrow(/Unresolved material rectangle/);
});
it("rejects unavailable WASM with no JavaScript fallback", async () => {
  await expect(
    createStrictEdgeStamper(new Uint8Array([0, 1, 2, 3]), {
      tables,
      atlas,
      atlasWidth: EDGE_ATLAS_WIDTH,
    }),
  ).rejects.toThrow();
});
it("commits no caller material mutation when a later scene pass fails", async () => {
  const fixture = syntheticCases().find(
    (c) => c.name === "scene:overlap-order:AB",
  )!;
  const before = fixture.mat.slice();
  let calls = 0;
  const broken = await createStrictEdgeStamper(
    wasm,
    { tables, atlas, atlasWidth: EDGE_ATLAS_WIDTH },
    {
      instantiate: async (source, imports) => {
        const actual =
          source instanceof WebAssembly.Module
            ? await WebAssembly.instantiate(source, imports)
            : await WebAssembly.instantiate(source, imports);
        const exports = (
          "instance" in actual ? actual.instance.exports : actual.exports
        ) as any;
        return {
          exports: {
            ...exports,
            scene: (...args: number[]) =>
              ++calls === 2 ? 0 : exports.scene(...args),
          },
        };
      },
    },
  );
  expect(() =>
    broken.stamp(
      fixture.mat,
      fixture.width,
      fixture.height,
      fixture.originX,
      fixture.originY,
      fixture.worldSeed,
      {
        chunkShiftX: fixture.opts.chunkShiftX ?? 0,
        chunkShiftY: 0,
        inset: 32,
        scenes: fixture.opts.scenes!,
        skipSeamAt: () => false,
      },
    ),
  ).toThrow(/rejected scene/);
  expect(fixture.mat).toEqual(before);
  expect(broken.stats.calls).toBe(0);
});
it("preserves RGB bytes at alpha zero when both carriers are transparent", () => {
  expect(compositeRGBA(0x00102030, 0x00405060)).toBe(0x00102030);
});
