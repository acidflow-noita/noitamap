import { generateFixture } from "./generate-worker-fixture";
import { createCpuTerrain } from "../../src/telescope/cpu-terrain-core";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { BIOME_ENGINE } from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import type { GLTerrainGeneration } from "../../src/telescope/gl-terrain-tile-source";

type Area = { name: string; x: number; y: number };
type Terrain = Awaited<ReturnType<typeof createCpuTerrain>>;
const size = 512;

async function hash(pixels: Uint8ClampedArray) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(pixels).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function completedTile(terrain: Terrain, area: Area) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const begin = performance.now();
  const hasContent = terrain.contains(area.x, area.y, size, size);
  if (hasContent) terrain.prefillMaterials(area.x, area.y, size, size);
  const prepared = performance.now();
  if (hasContent) terrain.renderRows(area.x, area.y, size, 0, size, pixels);
  const rendered = performance.now();
  if (hasContent) terrain.finish(pixels, area.x, area.y, size, size);
  return {
    pixels,
    hasContent,
    timing: {
      prefillMs: prepared - begin,
      renderMs: rendered - prepared,
      finishMs: performance.now() - rendered,
      completedMs: performance.now() - begin,
    },
  };
}

function mixedArea(pixels: Uint32Array): Area {
  const byColor = new Map(
    BIOME_ENGINE.map((b: any) => [b.color & 0xffffff, b]),
  );
  for (let y = 14; y < 45; y++)
    for (let x = 1; x < 69; x++) {
      const left: any = byColor.get(pixels[y * 70 + x - 1] & 0xffffff);
      const right: any = byColor.get(pixels[y * 70 + x] & 0xffffff);
      if (left?.supported && left.topo === 2 && right?.topo === 0)
        return {
          name: "mixed-topology",
          x: (x - 35) * 512 - 256,
          y: (y - 14) * 512,
        };
    }
  throw new Error("Real generation has no topology2/topology0 boundary");
}

async function compareTiles(
  baseline: Terrain,
  native: Terrain,
  areas: Area[],
  forceAir?: { x: number; y: number },
) {
  const samples = [];
  for (const [index, area] of areas.entries()) {
    // Alternate execution order. Each first pass starts with the same cache
    // history; the second pass explicitly measures the retained-material case.
    for (const pass of ["first", "cached"] as const) {
      let a, b;
      if (index % 2) {
        b = completedTile(native, area);
        a = completedTile(baseline, area);
      } else {
        a = completedTile(baseline, area);
        b = completedTile(native, area);
      }
      let mismatchedBytes = 0,
        visible = 0;
      const firstDifferences = [];
      for (let i = 0; i < a.pixels.length; i++) {
        if (a.pixels[i] !== b.pixels[i]) {
          mismatchedBytes++;
          if (firstDifferences.length < 8)
            firstDifferences.push({
              byte: i,
              x: area.x + (Math.floor(i / 4) % size),
              y: area.y + Math.floor(i / (size * 4)),
              baseline: a.pixels[i],
              native: b.pixels[i],
            });
        }
        if (i % 4 === 3 && b.pixels[i]) visible++;
      }
      let forceAirBackgroundPixels = 0;
      if (forceAir && area.name === "mines-with-force-air")
        for (let y = forceAir.y; y < forceAir.y + 32; y++)
          for (let x = forceAir.x; x < forceAir.x + 32; x++) {
            const i = ((y - area.y) * size + x - area.x) * 4;
            if (
              b.pixels[i] === 21 &&
              b.pixels[i + 1] === 42 &&
              b.pixels[i + 2] === 63 &&
              b.pixels[i + 3] === 255
            )
              forceAirBackgroundPixels++;
          }
      samples.push({
        ...area,
        pass,
        width: size,
        height: size,
        hasContent: b.hasContent,
        forceAirBackgroundPixels,
        comparedBytes: a.pixels.byteLength,
        mismatchedBytes,
        firstDifferences,
        visible,
        baseline: { ...a.timing, hash: await hash(a.pixels) },
        native: { ...b.timing, hash: await hash(b.pixels) },
      });
    }
  }
  return samples;
}

async function inspect(seed: number, initializationFailure = false) {
  const generationStart = performance.now();
  const generated = await generateFixture(true, seed, true);
  const generationMs = performance.now() - generationStart;
  const sceneX = -400,
    sceneY = 640;
  const forceAir = new Uint8Array(32 * 32 * 4);
  const backgroundArt = forceAir.slice();
  for (let i = 0; i < forceAir.length; i += 4) forceAir.set([0, 0, 66, 255], i);
  for (let i = 0; i < backgroundArt.length; i += 4)
    backgroundArt.set([21, 42, 63, 255], i);
  const gen: GLTerrainGeneration = {
    tileLayers: generated.tileLayers!,
    biomeData: generated.biomeData,
    seed,
    isNGP: false,
    gameMode: "normal",
    plane: 0,
    sceneData: {
      scenes: [
        {
          key: "general/native-materials-test",
          name: "native-materials-test",
          x: sceneX,
          y: sceneY,
          width: 32,
          height: 32,
        },
      ],
      sources: {
        "general/native-materials-test": {
          data: forceAir,
          width: 32,
          height: 32,
          skipEdgeTextures: true,
          backgroundArt: { data: backgroundArt, width: 32, height: 32 },
        },
      },
    },
  };
  let start = performance.now();
  const baseline = await createCpuTerrain(gen, { nativeMaterials: false });
  const baselineInitMs = performance.now() - start;
  start = performance.now();
  const native = await createCpuTerrain(gen);
  const nativeInitMs = performance.now() - start;
  const areas: Area[] =
    seed === 195331
      ? [{ name: "authored-mana-pool", x: -3392, y: 640 }]
      : [
          { name: "mines-with-force-air", x: -512, y: 512 },
          mixedArea(generated.biomeData.pixels),
          { name: "west-world-boundary", x: -18176, y: 512 },
          { name: "west-parallel-chunk-seam", x: -36096, y: 512 },
        ];
  if (initializationFailure) areas.splice(1);
  const samples = await compareTiles(baseline, native, areas, {
    x: sceneX,
    y: sceneY,
  });
  // Unowned raw color spans stay lazy, and split-row callers retain the
  // untouched output rows even when the target rectangle crosses block seams.
  const unowned = await createCpuTerrain(
    { ...gen, tileLayers: [], sceneData: undefined },
    { nativeMaterials: false },
  );
  const partial = new Uint8ClampedArray(31 * 32 * 4).fill(73);
  unowned.renderRows(-129, 511, 31, 7, 23, partial);
  const lazyUnowned = {
    resolved: unowned.materialStats.resolved,
    changedOutsideRows:
      partial.subarray(0, 7 * 31 * 4).some((n) => n !== 73) ||
      partial.subarray(23 * 31 * 4).some((n) => n !== 73),
    nonzeroInsideRows: partial
      .subarray(7 * 31 * 4, 23 * 31 * 4)
      .some((n) => n !== 0),
  };
  const whole = new Uint8ClampedArray(131 * 129 * 4),
    split = whole.slice();
  baseline.renderRows(-129, 511, 131, 0, 129, whole);
  for (const [from, to] of [
    [0, 7],
    [7, 71],
    [71, 129],
  ])
    baseline.renderRows(-129, 511, 131, from, to, split);
  const splitRowDifferences = whole.reduce(
    (n, value, i) => n + Number(value !== split[i]),
    0,
  );
  return {
    seed,
    generationMs,
    baselineInitMs,
    nativeInitMs,
    nativeMaterialStats: { ...native.nativeMaterialStats },
    baselineMaterialStats: { ...baseline.materialStats },
    nativeCacheStats: { ...native.materialStats },
    lazyUnowned,
    splitRowDifferences,
    samples,
  };
}

/** Prepared plane inputs include the actual generated local elevator lattices. */
async function inspectVertical() {
  const seed = 786433191;
  const generated = await generateFixture(true, seed, true);
  const source: GLTerrainGeneration = {
    seed,
    isNGP: false,
    gameMode: "normal",
    plane: 0,
    tileLayers: generated.tileLayers!,
    biomeData: generated.biomeData,
  };
  const cases = [];
  for (const plane of [-1, 1] as const) {
    const gen = await prepareTerrainPlane(source, plane);
    let start = performance.now();
    const baseline = await createCpuTerrain(gen, { nativeMaterials: false });
    const baselineInitMs = performance.now() - start;
    start = performance.now();
    const native = await createCpuTerrain(gen);
    const nativeInitMs = performance.now() - start;
    const areas: Area[] = [
      { name: "warped-main", x: -3520, y: 1600 + plane * 24576 },
      { name: "mixed-west", x: -39872, y: 64 + plane * 24576 },
      { name: "bottom-seam", x: -4032, y: 17392 + plane * 24576 },
    ];
    if (plane === 1) {
      const shaft = gen.elevatorShafts?.[0];
      if (!shaft) throw new Error("Real Hell generation has no elevator shaft");
      for (const row of [0, 23, 47])
        areas.push({
          name: `elevator-${row}`,
          x: shaft.minX * 512 - 17920,
          y: 17408 + row * 512,
        });
      areas.push({
        name: "elevator-west-seam",
        x: shaft.minX * 512 - 17920 - 35840 - 16,
        y: 17408 + 23 * 512,
      });
    }
    const samples = await compareTiles(baseline, native, areas);
    cases.push({
      seed,
      plane,
      elevatorCount: gen.elevatorShafts?.length ?? 0,
      baselineInitMs,
      nativeInitMs,
      nativeMaterialStats: { ...native.nativeMaterialStats },
      samples,
    });
  }
  return cases;
}

/** Actual final CPU tile pipeline, emitted assets, no WebGL or browser. */
export async function verifyNativeMaterials(initializationFailure = false) {
  return {
    scope:
      "Real main-plane, Heaven/Hell and generated elevator terrain, raw materials + water + scenes + edges + backgrounds; one 512px tile per measurement. Cache and module initialization reported separately.",
    cases: initializationFailure
      ? [await inspect(786433191, true)]
      : [await inspect(786433191), await inspect(195331)],
    verticalCases: await inspectVertical(),
  };
}
