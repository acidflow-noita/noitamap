/**
 * Deterministic fixtures for complete RGBA and mutated-material parity.
 * Use the real source atlas for both stampers; these cases deliberately include
 * materials whose sprites contain partial alpha and nonzero RGB at alpha zero.
 *
 * Each call creates independent inputs. A stamper mutates mat and may cache
 * scene.edgeEligible, so clone mat and scene objects before comparing engines.
 * Width/height are padded dimensions unless a case name says "unpadded".
 * Uses the same source data as the production renderer.
 */

import {
  EDGE_ENTRIES_BY_MATERIAL,
  MATERIAL_TYPE_BY_NAME,
} from "../../lib/noita-telescope-vm/js/engine_resolve/edge_data.js";
import { MATERIAL_NAMES_BY_ID } from "../../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";

const entriesByMaterial: Record<string, unknown> = EDGE_ENTRIES_BY_MATERIAL;
const materialTypes: Record<string, number> = MATERIAL_TYPE_BY_NAME;

export interface NativeEdgeScene {
  x: number;
  y: number;
  width: number;
  height: number;
  grid: Int16Array;
  artMask?: Uint8Array | null;
  skipEdges?: boolean;
  edgeEligible?: boolean;
}

export interface NativeEdgeCase {
  name: string;
  mat: Int16Array;
  width: number;
  height: number;
  originX: number;
  originY: number;
  worldSeed: number;
  opts: {
    chunkShiftX?: number;
    chunkShiftY?: number;
    inset?: number;
    scenes?: NativeEdgeScene[];
  };
}

interface CaseSettings {
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  worldSeed?: number;
  shift?: number;
  inset?: number;
  salt?: number;
}

const HALO = 32;
const UNTOUCHED = -2;
const UNKNOWN = -1;
const UNKNOWN_POSITIVE = 32767;
const ids = new Map<string, number>(
  MATERIAL_NAMES_BY_ID.map((name: string, id: number) => [name, id]),
);

function materialId(name: string): number {
  const id = ids.get(name);
  if (id === undefined || !(id > 0))
    throw new Error(`Missing synthetic edge material: ${name}`);
  return id;
}

function sameTypeAlternative(id: number) {
  const type = materialTypes[MATERIAL_NAMES_BY_ID[id]];
  return MATERIAL_NAMES_BY_ID.findIndex(
    (name: string, candidate: number) =>
      candidate > 0 &&
      candidate !== id &&
      materialTypes[name] === type &&
      !entriesByMaterial[name],
  );
}

// Repeated rectangles, bevels, curves, and mixed-material contacts provide
// long straight edges, all normal quadrants, narrow channels, and many ordered
// overlapping random stamps. The upper half retains pure material boundaries;
// the lower half exercises material identity versus material-type matching.
function patternedGrid(width: number, height: number, id: number, salt = 0) {
  const mat = new Int16Array(width * height);
  const alternative = Math.max(0, sameTypeAlternative(id));
  const water = materialId("water");
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / 31),
        by = Math.floor(y / 29);
      const lx = x % 31,
        ly = y % 29;
      const shape = (bx + by + salt) % 3;
      const solid =
        shape === 0
          ? lx < 24 && ly < 22
          : shape === 1
            ? lx < 25 && ly < 24 && lx + ly < 37
            : (lx - 14) ** 2 + (ly - 13) ** 2 < 155;
      let value = solid ? id : 0;
      if (solid && y >= Math.floor(height / 2)) {
        const contact = (x + y * 3 + salt) % 47;
        if (contact === 0 || contact === 1) value = alternative;
        else if (contact === 11) value = water === id ? 0 : water;
        else if (contact === 21) value = UNKNOWN;
        else if (contact === 31) value = UNKNOWN_POSITIVE;
      }
      mat[y * width + x] = value;
    }
  }
  return mat;
}

function makeCase(
  name: string,
  id: number,
  {
    width = 128 + HALO * 2,
    height = width,
    originX = -HALO,
    originY = -HALO,
    worldSeed = 786433191,
    shift = 0,
    inset = HALO,
    salt = 0,
  }: CaseSettings = {},
): NativeEdgeCase {
  return {
    name,
    mat: patternedGrid(width, height, id, salt),
    width,
    height,
    originX,
    originY,
    worldSeed,
    opts: { chunkShiftX: shift, chunkShiftY: 0, inset },
  };
}

function makeScene(
  test: NativeEdgeCase,
  x: number,
  y: number,
  width: number,
  height: number,
  cellAt: (x: number, y: number) => number,
  artAt: ((x: number, y: number, id: number) => boolean) | null = null,
  extras: Pick<NativeEdgeScene, "skipEdges" | "edgeEligible"> = {},
): NativeEdgeScene {
  const grid = new Int16Array(width * height);
  const artMask = artAt ? new Uint8Array(Math.ceil(grid.length / 8)) : null;
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      const p = ly * width + lx;
      const id = cellAt(lx, ly);
      grid[p] = id;
      if (artMask && artAt?.(lx, ly, id)) artMask[p >> 3] |= 0x80 >> (p & 7);
    }
  }
  return {
    x: test.originX + x,
    y: test.originY + y,
    width,
    height,
    grid,
    artMask,
    ...extras,
  };
}

/** Return a fresh, bounded suite of named stampEdgeDecals argument objects. */
export function syntheticCases(): NativeEdgeCase[] {
  const cases: NativeEdgeCase[] = [];
  const origins = [
    [-32, -32],
    [480, 480],
    [-544, -544],
    [-33280, -10784],
    [32736, 16352],
    [-32737, 511],
  ];
  const seeds = [0, 1, 786433191, 4294967295, 195331, 11033];

  // All 66 shipped edge materials: all three populated entry types, every
  // referenced image, both stripe directions, and random flip/transposition.
  Object.keys(EDGE_ENTRIES_BY_MATERIAL).forEach((name, index) => {
    const [originX, originY] = origins[index % origins.length];
    cases.push(
      makeCase(`material:${name}`, materialId(name), {
        originX,
        originY,
        worldSeed: seeds[index % seeds.length],
        shift: index & 1 ? 256 : 0,
        salt: index,
      }),
    );
  });

  const rock = materialId("rock_static");
  const temple = materialId("templebrick_static");
  const steel = materialId("steel_static");
  const ice = materialId("ice");
  const noEdge = materialId("rock_static_noedge");

  for (const kept of [1, 17, 128]) {
    for (const shift of [0, 256]) {
      for (const sign of [-1, 1]) {
        const id = kept === 1 ? temple : kept === 17 ? steel : rock;
        const test = makeCase(`padded:${kept}:shift${shift}:pw${sign}`, id, {
          width: kept + HALO * 2,
          originX: sign * 32768 - shift - HALO,
          originY: sign * 512 - HALO,
          worldSeed: sign < 0 ? 4294967295 : 11033,
          shift,
          salt: kept,
        });
        // Exercise both nonzero seam shifts, including negative pmod inputs.
        test.opts.chunkShiftY = shift;
        cases.push(test);
      }
    }
  }

  for (const [width, height] of [
    [1, 1],
    [17, 17],
    [128, 17],
  ]) {
    cases.push(
      makeCase(`unpadded:${width}x${height}:normal-border`, temple, {
        width,
        height,
        originX: -513,
        originY: -257,
        inset: 0,
        shift: 256,
      }),
    );
  }

  // These families use the real atlas's transparent-colored and partial-alpha
  // texels. Tight repeated stamps make their first-painted behavior observable.
  for (const name of [
    "steel_rusted_no_holes",
    "endslime",
    "rock_hard_border",
  ]) {
    const id = materialId(name);
    const test = makeCase(`atlas-alpha:${name}`, id, {
      originX: -337,
      originY: 497,
      worldSeed: 0x80000000,
    });
    for (let y = 0; y < test.height; y++) {
      for (let x = 0; x < test.width; x++) {
        test.mat[y * test.width + x] = x % 17 < 12 && y % 19 < 14 ? id : 0;
      }
    }
    cases.push(test);
  }

  const mixedCell = (x: number, y: number) => {
    if (x === 0 || y === 0) return temple;
    return [UNTOUCHED, 0, UNKNOWN, UNKNOWN_POSITIVE, rock, temple, noEdge, ice][
      (Math.floor(x / 7) + Math.floor(y / 9)) % 8
    ];
  };
  for (const variant of [
    "mixed",
    "art-bits",
    "skip",
    "eligible-false",
    "eligible-true-covered",
  ]) {
    const test = makeCase(`scene:${variant}`, rock, {
      originX: -545,
      originY: 495,
    });
    const artAt =
      variant === "art-bits"
        ? (x: number, y: number) => (x + y * 3) % 11 < 5
        : variant === "eligible-true-covered"
          ? () => true
          : null;
    const extras =
      variant === "skip"
        ? { skipEdges: true }
        : variant === "eligible-false"
          ? { edgeEligible: false }
          : variant === "eligible-true-covered"
            ? { edgeEligible: true }
            : {};
    test.opts.scenes = [
      makeScene(test, 21, 17, 139, 151, mixedCell, artAt, extras),
    ];
    cases.push(test);
  }

  for (const reversed of [false, true]) {
    const test = makeCase(
      `scene:overlap-order:${reversed ? "BA" : "AB"}`,
      rock,
      {
        originX: -32913,
        originY: -257,
        shift: 256,
      },
    );
    const first = makeScene(
      test,
      18,
      13,
      139,
      145,
      (x, y) => ((x + y) % 19 < 3 ? UNTOUCHED : x % 29 < 4 ? 0 : temple),
      (x, y) => x % 13 < 2 && y % 17 < 9,
    );
    const second = makeScene(
      test,
      39,
      37,
      139,
      141,
      (x, y) => ((x * 3 + y) % 17 < 4 ? UNTOUCHED : y % 23 < 3 ? UNKNOWN : ice),
      (x, y) => (x + y * 7) % 23 < 3,
    );
    test.opts.scenes = reversed ? [second, first] : [first, second];
    cases.push(test);
  }

  for (const coveredOutside of [false, true]) {
    const test = makeCase(
      `scene:eligibility-outside-tile:${coveredOutside ? "covered" : "uncovered"}`,
      rock,
    );
    // The sole created edge-capable cell is left of the padded tile. When
    // uncovered it enables stamping of kept world cells inside the scene.
    test.opts.scenes = [
      makeScene(
        test,
        -40,
        12,
        test.width + 80,
        test.height - 24,
        (x, y) => (x === 3 && y === 3 ? temple : UNTOUCHED),
        coveredOutside ? (x, y) => x === 3 && y === 3 : null,
      ),
    ];
    cases.push(test);
  }

  for (const offset of [
    [-37, -29],
    [151, 149],
    [-400, -400],
  ]) {
    const test = makeCase(`scene:clipped:${offset.join(",")}`, steel, {
      originX: -519,
      originY: -513,
      worldSeed: 1,
    });
    test.opts.scenes = [
      makeScene(
        test,
        offset[0],
        offset[1],
        91,
        87,
        mixedCell,
        (x, y, id) => id > 0 && (x + y) % 7 === 0,
      ),
    ];
    cases.push(test);
  }

  const allocated = new Set<ArrayBufferLike>();
  for (const test of cases) {
    allocated.add(test.mat.buffer);
    for (const scene of test.opts.scenes ?? []) {
      allocated.add(scene.grid.buffer);
      if (scene.artMask) allocated.add(scene.artMask.buffer);
    }
  }
  const bytes = [...allocated].reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  if (cases.length > 110 || bytes > 40 * 1024 * 1024) {
    throw new Error(
      `Synthetic edge fixture bounds exceeded: ${cases.length} cases, ${bytes} bytes`,
    );
  }
  return cases;
}
