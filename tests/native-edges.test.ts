import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeAll, it, vi } from "vitest";
import { createEdgeStamper } from "../src/native-map/edges/core";
import {
  buildEdgeTables,
  ATLAS_BYTE_LENGTH,
  MATERIAL_STRIDE,
  ENTRY_STRIDE,
  IMAGE_STRIDE,
} from "../src/native-map/edges/data";
import {
  syntheticCases,
  type NativeEdgeCase,
} from "./helpers/native-edge-cases";
import {
  setEdgeDecalAtlas,
  stampEdgeDecals,
} from "../lib/noita-telescope-vm/js/edge_decals.js";
import {
  EDGE_ENTRIES_BY_MATERIAL,
  EDGE_IMAGES,
  MATERIAL_TYPE_BY_NAME,
} from "../lib/noita-telescope-vm/js/engine_resolve/edge_data.js";
import { MATERIAL_NAMES_BY_ID } from "../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";

// The production package alias and direct reference share the same real atlas
// state. No decal logic is mocked; optional native failure injection is below.
vi.mock(
  "noita-telescope-full-pixels/edge_decals.js",
  () => import("../lib/noita-telescope-vm/js/edge_decals.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/edge_data.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/edge_data.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/engine_data.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/engine_data.js"),
);
vi.mock(
  "noita-telescope-full-pixels/engine_resolve/chunk_wobble.js",
  () => import("../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js"),
);
vi.mock(
  "noita-telescope-full-pixels/pixel_scene_edge_flags.js",
  () => import("../lib/noita-telescope-vm/js/pixel_scene_edge_flags.js"),
);

type EdgeStamper = Awaited<ReturnType<typeof createEdgeStamper>>;
interface TestWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  buffer_ptr: (slot: number) => number;
  scene: (...args: number[]) => number;
}
let wasm: Uint8Array<ArrayBuffer>,
  atlas: Uint8Array<ArrayBuffer>,
  parityStamper: EdgeStamper;
const fixtures = syntheticCases();
const rockId = MATERIAL_NAMES_BY_ID.indexOf("rock_static");
type SourceEntry = [number, number, number, number, number, number, number[]];
const entriesByMaterial = EDGE_ENTRIES_BY_MATERIAL as unknown as Record<
  string,
  SourceEntry[]
>;
const materialTypes: Record<string, number> = MATERIAL_TYPE_BY_NAME;
beforeAll(async () => {
  const [binary, pixels] = await Promise.all([
    readFile(new URL("../src/native-map/edges/core.wasm", import.meta.url)),
    readFile(
      new URL("../lib/noita-telescope-vm/data/edge_atlas.bin", import.meta.url),
    ),
  ]);
  wasm = Uint8Array.from(binary);
  atlas = Uint8Array.from(pixels);
  setEdgeDecalAtlas(atlas);
  parityStamper = await createEdgeStamper(wasm, atlas);
  assert.equal(parityStamper.enabled, true);
});

function assertBytes(
  actual: Uint8ClampedArray | Int16Array,
  expected: Uint8ClampedArray | Int16Array,
  label: string,
) {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = Buffer.from(
    expected.buffer,
    expected.byteOffset,
    expected.byteLength,
  );
  assert.equal(Buffer.compare(a, b), 0, label);
}

for (const input of fixtures) {
  it(`preserves complete RGBA and material bytes: ${input.name}`, () => {
    const calls = parityStamper.stats.calls;
    compare(parityStamper, structuredClone(input));
    assert.equal(
      parityStamper.stats.calls,
      calls + 1,
      "parity must exercise the native path",
    );
    assert.equal(parityStamper.stats.fallbacks, 0);
  });
}

function fixture(name = "material:rock_static") {
  const original = fixtures.find((value) => value.name === name);
  assert.ok(original, name);
  return structuredClone(original);
}

function originalResult(input: NativeEdgeCase) {
  const mat = input.mat.slice();
  const rgba = stampEdgeDecals(
    mat,
    input.width,
    input.height,
    input.originX,
    input.originY,
    input.worldSeed,
    structuredClone(input.opts),
  );
  return { mat, rgba };
}

function compare(
  stamper: EdgeStamper,
  input: NativeEdgeCase,
  expected: { mat: Int16Array; rgba: Uint8ClampedArray } = originalResult(
    input,
  ),
) {
  const rgba = stamper.stamp(
    input.mat,
    input.width,
    input.height,
    input.originX,
    input.originY,
    input.worldSeed,
    input.opts,
  );
  assertBytes(rgba, expected.rgba, `${input.name}: complete RGBA`);
  assertBytes(input.mat, expected.mat, `${input.name}: mutated materials`);
  return expected;
}

it("large safe-integer inset falls back before WASM int32 truncation", async () => {
  const input = fixture();
  input.opts.inset = 2 ** 32 + 32;
  const stamper = await createEdgeStamper(wasm, atlas);
  assert.equal(stamper.enabled, true);
  const expected = compare(stamper, input);
  assert.ok(expected.rgba.every((value) => value === 0));
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.equal(stamper.stats.failures, 0);
});

it("non-Int16 scene grids fall back before signed conversion changes paint marks", async () => {
  const input = fixture();
  // The original checks the unconverted negative value for artwork blocking,
  // then stores a positive rock ID into its Int16 world. Native narrowing
  // before that sign test would incorrectly mark every rock cell as painted.
  const grid = Float64Array.from(input.mat, (value) =>
    value === rockId ? value - 65536 : 0,
  );
  input.opts.scenes = [
    {
      x: input.originX,
      y: input.originY,
      width: input.width,
      height: input.height,
      grid: grid as unknown as Int16Array,
      artMask: new Uint8Array(Math.ceil(grid.length / 8)).fill(255),
      edgeEligible: true,
    },
  ];
  const stamper = await createEdgeStamper(wasm, atlas);
  const expected = compare(stamper, input);
  assert.ok(
    expected.rgba.some((value) => value !== 0),
    "the reference must actually stamp this fixture",
  );
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.equal(stamper.stats.failures, 0);
});

it("a scene grid aliased with caller materials preserves sequential overlay reads", async () => {
  const width = 17,
    height = 17;
  const mat = Int16Array.from({ length: width * height }, (_, index) =>
    index % 2 ? rockId : 0,
  );
  const input = {
    name: "aliased-scene-grid",
    mat,
    width,
    height,
    originX: 0,
    originY: 0,
    worldSeed: 123,
    opts: {
      inset: 0,
      scenes: [
        {
          x: 1,
          y: 0,
          width,
          height,
          grid: mat,
          edgeEligible: false,
        },
      ],
    },
  };
  // Clone the complete input together: cloning mat and opts separately would
  // destroy the alias whose behavior this regression must preserve.
  const stock = structuredClone(input);
  assert.equal(stock.mat.buffer, stock.opts.scenes[0].grid.buffer);
  const rgba = stampEdgeDecals(stock.mat, width, height, 0, 0, 123, stock.opts);
  const stamper = await createEdgeStamper(wasm, atlas);
  compare(stamper, input, { rgba, mat: stock.mat });
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.equal(stamper.stats.failures, 0);
});

it("an artwork bitmask aliased with caller materials retains live mask reads", async () => {
  const input = fixture();
  const grid = Int16Array.from(input.mat, (value) =>
    value === rockId ? rockId : 0,
  );
  input.opts.scenes = [
    {
      x: input.originX,
      y: input.originY,
      width: input.width,
      height: input.height,
      grid,
      artMask: new Uint8Array(input.mat.buffer, 0, Math.ceil(grid.length / 8)),
      edgeEligible: true,
    },
  ];
  const stock = structuredClone(input);
  assert.equal(stock.mat.buffer, stock.opts.scenes![0].artMask!.buffer);
  const rgba = stampEdgeDecals(
    stock.mat,
    stock.width,
    stock.height,
    stock.originX,
    stock.originY,
    stock.worldSeed,
    stock.opts,
  );
  const stamper = await createEdgeStamper(wasm, atlas);
  compare(stamper, input, { rgba, mat: stock.mat });
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.equal(stamper.stats.failures, 0);
});

it("an invalid WASM module runs the complete original stamper", async () => {
  const stamper = await createEdgeStamper(new Uint8Array([0, 1, 2, 3]), atlas);
  assert.equal(stamper.enabled, false);
  compare(stamper, fixture("scene:overlap-order:AB"));
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.failures, 1);
  assert.equal(stamper.stats.fallbacks, 1);
});

it("an initialization failure runs the complete original stamper", async () => {
  const stamper = await createEdgeStamper(wasm, atlas, {
    instantiate: async () => {
      throw new Error("injected initialization failure");
    },
  });
  assert.equal(stamper.enabled, false);
  compare(stamper, fixture("scene:overlap-order:AB"));
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.failures, 1);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.match(
    stamper.timing.initializationError ?? "",
    /injected initialization failure/,
  );
});

it("a second-scene failure leaves caller materials untouched before complete fallback", async () => {
  const input = fixture("scene:overlap-order:AB");
  const before = input.mat.slice();
  const expected = originalResult(input);
  let sceneCalls = 0;
  let checkedAtomicity = false;
  const stamper = await createEdgeStamper(wasm, atlas, {
    instantiate: async (bytes, imports) => {
      const actual =
        bytes instanceof WebAssembly.Module
          ? await WebAssembly.instantiate(bytes, imports)
          : await WebAssembly.instantiate(bytes, imports);
      const api = (
        "instance" in actual ? actual.instance.exports : actual.exports
      ) as TestWasmExports;
      return {
        instance: {
          exports: {
            ...api,
            scene(...args: number[]) {
              sceneCalls++;
              if (sceneCalls === 2) {
                assert.deepEqual(
                  input.mat,
                  before,
                  "caller materials must still be unmodified",
                );
                const nativeMaterials = new Int16Array(
                  api.memory.buffer,
                  api.buffer_ptr(9),
                  input.mat.length,
                );
                assert.notDeepEqual(
                  nativeMaterials,
                  before,
                  "the injected failure must occur after a real native scene mutation",
                );
                checkedAtomicity = true;
                throw new Error("injected second-scene failure");
              }
              return api.scene(...args);
            },
          },
        },
      };
    },
  });
  assert.equal(stamper.enabled, true);
  compare(stamper, input, expected);
  assert.equal(sceneCalls, 2);
  assert.equal(checkedAtomicity, true);
  assert.equal(stamper.enabled, false);
  assert.equal(stamper.stats.calls, 0);
  assert.equal(stamper.stats.failures, 1);
  assert.equal(stamper.stats.fallbacks, 1);
  assert.match(
    stamper.stats.lastFailure ?? "",
    /injected second-scene failure/,
  );
  // Disabling a failed instance must also preserve subsequent requests.
  compare(stamper, fixture());
  assert.equal(stamper.stats.fallbacks, 2);
  assert.equal(sceneCalls, 2);
});

const tables = buildEdgeTables();

it("all material, entry, and image tables retain source values within the memory bound", () => {
  let entryChecks = 0;
  for (let id = 0; id < MATERIAL_NAMES_BY_ID.length; id++) {
    const name = MATERIAL_NAMES_BY_ID[id];
    const entries = entriesByMaterial[name] || [];
    const base = id * MATERIAL_STRIDE;
    assert.equal(tables.materialTable[base + 1], entries.length);
    assert.equal(tables.materialTable[base + 2], materialTypes[name] ?? 0);
    for (let n = 0; n < entries.length; n++) {
      const [type, percent, overwrite, sameMat, sameType, color, images] =
        entries[n];
      const entry = tables.materialTable[base] + n;
      const p = entry * ENTRY_STRIDE;
      assert.deepEqual(
        [...tables.entryTable.subarray(p, p + 5)],
        [type, overwrite, sameMat, sameType, color | 0],
      );
      assert.equal(tables.entryPercent[entry], percent);
      const start = tables.entryTable[p + 5];
      const count = tables.entryTable[p + 6];
      assert.deepEqual(
        [...tables.imageIndices.subarray(start, start + count)],
        images,
      );
      entryChecks++;
    }
  }
  for (let i = 0; i < EDGE_IMAGES.length; i++) {
    assert.deepEqual(
      [...tables.imageTable.subarray(i * IMAGE_STRIDE, (i + 1) * IMAGE_STRIDE)],
      EDGE_IMAGES[i],
    );
  }
  assert.equal(tables.materialCount, 466);
  assert.equal(entryChecks, 66);
  assert.equal(tables.imageCount, 184);
  assert.equal(tables.byteLength, 538792);
  assert.equal(ATLAS_BYTE_LENGTH, 414720);
  assert.ok(tables.byteLength + ATLAS_BYTE_LENGTH < 1024 * 1024);
});

it("24,910 normal lookups exactly match the current source function", async () => {
  const source = await readFile(
    new URL("../lib/noita-telescope-vm/js/edge_decals.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const RAY_OX =");
  const end = source.indexOf("/**\n * The CARDINAL_DIRECTIONS angle:");
  assert.ok(
    start >= 0 && end > start,
    "the original normal implementation must be found",
  );
  const normalSource = source.slice(start, end);
  const typeById = Int8Array.from(
    MATERIAL_NAMES_BY_ID.map(
      (name: string) => (name && materialTypes[name]) ?? 0,
    ),
  );
  // Execute the unchanged original ray setup and normal routine. The lookup
  // implementation below only discovers hit bits; angle computation comes
  // exclusively from the generated Float64 table under test.
  const reference = Function(
    "TYPE_BY_ID",
    `
    const TWO_PI = Math.PI * 2;
    const DEG = 180 / Math.PI;
    const pmod = (v, m) => ((v % m) + m) % m;
    ${normalSource}
    return { angle: surfaceNormalAngle, ox: RAY_OX, oy: RAY_OY };
  `,
  )(typeById);
  assert.deepEqual(tables.rayOx, reference.ox);
  assert.deepEqual(tables.rayOy, reference.oy);

  function lookup(
    mat: Int16Array,
    width: number,
    height: number,
    cx: number,
    cy: number,
    id: number,
    type: number | undefined,
    sameType: boolean,
  ) {
    let mask = 0;
    for (let ray = 0; ray < 16; ray++) {
      const dx = tables.rayOx[ray] / 5;
      const dy = tables.rayOy[ray] / 5;
      let last = -1;
      for (let t = 1; t < 5; t++) {
        const px = Math.floor(cx + dx * t);
        const py = Math.floor(cy + dy * t);
        if (px < 0 || py < 0 || px >= width || py >= height) break;
        const j = py * width + px;
        if (j === last) continue;
        last = j;
        const material = mat[j];
        if (
          material === id ||
          (sameType && material > 0 && typeById[material] === type)
        )
          continue;
        mask |= 1 << ray;
        break;
      }
    }
    return tables.normalAngles[mask];
  }

  let comparisons = 0;
  const width = 53,
    height = 47;
  const mat = new Int16Array(width * height);
  for (let variant = 0; variant < 5; variant++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        mat[y * width + x] =
          variant === 0
            ? 100
            : variant === 1
              ? x < 25
                ? 100
                : 0
              : variant === 2
                ? y < 21
                  ? 100
                  : 0
                : variant === 3
                  ? (((Math.imul(x + 13, 1103515245) ^
                      Math.imul(y + 7, 1013904223)) >>>
                      0) %
                      467) -
                    1
                  : (x + y) % 5 === 0
                    ? 0
                    : 100;
      }
    }
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        for (const sameType of [false, true]) {
          const id = mat[cy * width + cx];
          const type = typeById[id];
          assert.ok(
            Object.is(
              reference.angle(mat, width, height, cx, cy, id, type, sameType),
              lookup(mat, width, height, cx, cy, id, type, sameType),
            ),
            `variant ${variant}, cell (${cx}, ${cy}), sameType ${sameType}`,
          );
          comparisons++;
        }
      }
    }
  }
  assert.equal(comparisons, 24910);
  assert.equal(tables.normalAngles[0], -1);
  assert.ok(tables.normalAngles.every(Number.isFinite));
});
