#!/usr/bin/env node
// Development oracle only. The shipped index.ts has no import of this file,
// the source generator, a task fixture, a DOM shim or the reference modules.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  createCompleteMaterialResolver, prepareTopology0Seed, prepareCarveTables,
  MaterialClassification as C, MODIFIER_KEYS,
} from "./index.ts";
import * as ownedData from "./engine-data.mjs";
import * as referenceData from "../../../lib/noita-telescope-vm/js/engine_resolve/engine_data.js";
import { surfaceNoisePhase } from "../../../lib/noita-telescope-vm/js/engine_resolve/topo0_resolve.js";
import { bitmapNoiseNodeOffset, getModifierGrid } from "../../../lib/noita-telescope-vm/js/engine_resolve/bitmap_caves.js";
import { selectComponentForCell } from "../../../lib/noita-telescope-vm/js/engine_resolve/band_select.js";
import { computeMaterialNoiseDensity, setTopo2WorldOffX } from "../../../lib/noita-telescope-vm/js/engine_resolve/topo2_resolve.js";
import { resolveCellFull } from "../../../lib/noita-telescope-vm/js/engine_resolve/chunk_wobble.js";
import { engineWorld } from "../../../lib/noita-telescope-vm/test/helpers/generate.mjs";

const base = new URL("./", import.meta.url);
const hash = data => createHash("sha256").update(data).digest("hex");
const bytes = await readFile(new URL("complete-materials.wasm", base));
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const tables = prepareCarveTables();
const { BIOME_ENGINE, WANG_PARAMS_BY_ID } = referenceData;
const params = WANG_PARAMS_BY_ID.map(([scale, threshold, type]) => ({ scale, threshold, type }));
const byColor = new Map(BIOME_ENGINE.map(b => [b.color & 0xffffff, b]));
const report = {
  scope: "Exact pinned-source material IDs and classifications; real normal/NG+ geometry, mixed topology, negative worlds, bands, vertical/local shaft coordinates. No game capture or completed-art claim.",
  node: process.version, artifactSha256: hash(bytes), seedGrids: [], main: [], vertical: [], bands: {}, classifications: [],
};
function compare(actual, expected, name) {
  assert.equal(actual.length, expected.length);
  let mismatch = 0;
  const first = [];
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) {
    mismatch++;
    if (first.length < 8) first.push({ index: i, actual: actual[i], expected: expected[i] });
  }
  assert.equal(mismatch, 0, `${name}: ${JSON.stringify(first)}`);
  return { pixels: actual.length, mismatches: mismatch, sha256: hash(new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength)) };
}
function fixture() {
  const mapWidth = 70, cells = mapWidth * 48;
  return {
    seed: 786433191, mapWidth, parameters: params, carveTables: tables,
    biomePixels: new Uint32Array(cells).fill(18175), hostChunks: new Uint32Array(cells).fill(256),
    lattice: { GW: 19, GH: 17, cov: new Float32Array(19 * 17).fill(1), mat: new Uint16Array(19 * 17).fill(2), chunkCovered: new Uint8Array(cells).fill(1) },
  };
}
async function loadPlaneReference() {
  const source = await readFile(new URL("../../../src/telescope/plane-material-field.ts", base), "utf8");
  const rewritten = source.replace(/"noita-telescope-full-pixels\/([^"]+)"/g,
    (_, path) => JSON.stringify(new URL("../../../lib/noita-telescope-vm/js/" + path, base).href));
  const js = ts.transpileModule(rewritten, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  report.planeReferenceSha256 = hash(source);
  return (await import("data:text/javascript," + encodeURIComponent(js))).createPlaneMaterialField;
}

try {
  assert.deepEqual(ownedData, referenceData, "Owned metadata differs from pinned reference");
  const seeds = [0, 1, 42, 786433191, 2147483645, 2147483646, 4294967295];
  for (const seed of seeds) {
    const own = prepareTopology0Seed(seed);
    assert.equal(own.surfacePhase, surfaceNoisePhase(seed));
    assert.equal(own.bitmapNoiseOffset, bitmapNoiseNodeOffset(seed));
    for (const key of MODIFIER_KEYS) {
      const expected = getModifierGrid(seed, key), actual = own.modifiers[key];
      assert.equal(actual.W, expected.W); assert.equal(actual.H, expected.H);
      assert.equal(actual.node94, expected.node94);
      report.seedGrids.push({ seed, key, ...compare(actual.data, expected.data, `seed ${seed} ${key}`) });
    }
  }
  const topology0 = prepareTopology0Seed(786433191);
  const make = changes => ({ ...fixture(), topology0, ...changes });
  for (const [name, edit, x, y, wanted, material] of [
    ["resolved", () => {}, 100, 800, C.resolved, 1],
    ["outside", () => {}, 100, -7169, C.outsidePlane, 0],
    ["force-air", input => input.hostChunks.fill(2048), 100, 800, C.forceAir, 0],
    ["legacy", input => input.hostChunks.fill(512), 100, 800, C.legacy, -1],
    ["unowned", input => input.lattice.chunkCovered.fill(0), 100, 800, C.unowned, -1],
    ["unknown", input => input.biomePixels.fill(0x123456), 100, 800, C.unknownBiome, -1],
    ["raw-biome", input => input.biomePixels.fill(BIOME_ENGINE.find(b => !b.supported).color), 100, 800, C.rawBiome, -1],
    ["vertical-topo0", input => { input.plane = { offsetY: 24576 }; input.biomePixels.fill(BIOME_ENGINE[0].color); }, 100, 25376, C.unsupportedTopology, -1],
    ["missing-modifier", input => { input.biomePixels.fill(BIOME_ENGINE[2].color); input.topology0 = { ...topology0, modifiers: Object.fromEntries(MODIFIER_KEYS.map(key => [key, null])) }; }, 100, 800, C.missingModifier, -1],
    ["outside-tables", input => { input.biomePixels.fill(BIOME_ENGINE[0].color); input.carveTables = { hashMin: 0, hash: new Float32Array(1), xMin: 0, cosine: new Float64Array(1), yMin: 0, sine: new Float64Array(1) }; }, 100, 2000, C.outsideCarveTables, -1],
  ]) {
    const input = make(); edit(input);
    const resolver = await createCompleteMaterialResolver(input, module, { maxWidth: 64, maxHeight: 64 });
    const actual = resolver.resolve(x, y, 1, 1);
    assert.equal(actual.classifications[0], wanted, name);
    assert.equal(actual.materials[0], material, name);
    assert.equal(actual.unresolvedCount, material < 0 ? 1 : 0, name);
    report.classifications.push(name);
  }
  // Unknown-color host ownership must remain separate from field ownership.
  const unknown = make();
  unknown.biomePixels[15 * 70 + 34] = 0x123456;
  unknown.hostChunks[15 * 70 + 34] = 512;
  const unknownResolver = await createCompleteMaterialResolver(unknown, module);
  const unknownBatch = unknownResolver.resolve(-23, 512, 1, 1);
  assert.equal(unknownBatch.materials[0], -1);
  assert.equal(unknownBatch.classifications[0], C.legacy);
  assert.notEqual(unknownBatch.owners[0], unknownBatch.hostOwners[0]);
  report.classifications.push("distinct-host-and-field-ownership");

  // All band records, exact threshold boundaries and coverage-based scene calls.
  const selector = await createCompleteMaterialResolver(make(), module);
  const direct = [], coverage = [];
  for (let biomeId = 0; biomeId < BIOME_ENGINE.length; biomeId++) {
    const b = BIOME_ENGINE[biomeId];
    for (const d of [b.setMin, b.setMax, 0, 0.5, 1, 1.100000023841858])
      direct.push({ biomeId, x: -43017 + biomeId * 41, y: 31811 - biomeId * 31, density: Math.fround(d) });
    for (const c of [0.5, 0.75, 1])
      coverage.push({ biomeId, x: -43017 + biomeId * 41, y: 31811 - biomeId * 31, coverage: c });
  }
  const directExpected = Int32Array.from(direct, p => selectComponentForCell(BIOME_ENGINE[p.biomeId], p.x, p.y, Math.fround(p.density)));
  const coverageExpected = Int32Array.from(coverage, p => selectComponentForCell(BIOME_ENGINE[p.biomeId], p.x, p.y, computeMaterialNoiseDensity(p.x, p.y, Math.fround(p.coverage))));
  report.bands.direct = compare(selector.selectBandPoints(direct), directExpected, "direct bands");
  report.bands.coverage = compare(selector.resolveCoverageBandPoints(coverage), coverageExpected, "coverage bands");
  const densityExpected = Float32Array.from(coverage, p => computeMaterialNoiseDensity(p.x, p.y, Math.fround(p.coverage)));
  report.bands.density = compare(selector.computeMaterialNoiseDensityPoints(coverage), densityExpected, "density points");

  const planeReference = await loadPlaneReference();
  for (const options of [{ seed: 786433191, ngPlus: 0 }, { seed: 786433192, ngPlus: 0 }, { seed: 42, ngPlus: 2 }]) {
    const world = await engineWorld(options);
    const input = {
      seed: options.seed, mapWidth: world.W, lattice: world.lattice,
      biomePixels: world.biomeData.pixels, hostChunks: world.res.chunk,
      parameters: params, carveTables: tables,
    };
    // The generator test helper supplies its own canvas stubs. Resolving must
    // work after those globals are absent, including every newly prepared seed.
    const savedDocument = globalThis.document, savedCanvas = globalThis.OffscreenCanvas;
    delete globalThis.document; delete globalThis.OffscreenCanvas;
    let resolver;
    try { resolver = await createCompleteMaterialResolver(input, module); }
    finally { globalThis.document = savedDocument; globalThis.OffscreenCanvas = savedCanvas; }
    setTopo2WorldOffX(world.W * 256);
    const bmap = { w: world.W, colorAt: (cx, cy) => (world.biomeData.pixels[cy * world.W + cx] ?? 0) & 0xffffff };
    const hostNoise = color => !!byColor.get(color)?.noiseBiomeEdges;
    const cell = {};
    const rectangles = [
      { name: "mixed", x: -4400, y: -512, w: 600, h: 512 },
      { name: "surface", x: 2048, y: -512, w: 600, h: 512 },
      { name: "desert", x: 11000, y: 0, w: 600, h: 512 },
      { name: "mines", x: -512, y: 512, w: 600, h: 512 },
      { name: "west-mixed", x: -4400 - world.W * 512, y: -512, w: 600, h: 512 },
    ];
    for (const rect of rectangles) {
      const actual = resolver.resolve(rect.x, rect.y, rect.w, rect.h);
      const expected = new Int32Array(rect.w * rect.h);
      for (let y = 0, i = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++, i++) {
        const wx = rect.x + x, wy = rect.y + y;
        resolveCellFull(bmap, wx, wy, hostNoise, cell);
        const flags = world.res.chunk[cell.cy * world.W + cell.cx];
        expected[i] = flags & 2048 ? 0 : ((flags >> 8) & 3) === 2 ? -1 : world.field.materialAt(wx, wy);
        assert.equal(actual.hostOwners[i], cell.cy * world.W + cell.cx);
        assert.equal(actual.materials[i] < 0, actual.classifications[i] >= C.legacy);
      }
      report.main.push({ ...options, ...rect, ...compare(actual.materials, expected, `${options.seed} ${rect.name}`), unresolvedCount: actual.unresolvedCount });
    }
    if (options.seed === 786433192) continue;
    for (const plane of [-1, 1]) {
      const pixels = new Uint32Array(world.W * 48), offsetY = plane * 24576;
      const sourceRow = plane < 0 ? 0 : 47;
      for (let row = 0; row < 48; row++) pixels.set(world.biomeData.pixels.subarray(sourceRow * world.W, (sourceRow + 1) * world.W), row * world.W);
      for (const originX of [undefined, 0, 1433, -409.25]) {
        const localOffset = plane * Math.trunc(33 * 512 / 10) * 10;
        const lattice = originX === undefined ? world.lattice : {
          GW: 51, GH: 359, cov: new Float32Array(51 * 359), mat: new Uint16Array(51 * 359),
        };
        if (originX !== undefined) for (let y = 0; y < lattice.GH; y++) for (let x = 0; x < lattice.GW; x++) {
          const i = ((y + 800) % world.lattice.GH) * world.lattice.GW + (x + 1433) % world.lattice.GW;
          lattice.cov[y * lattice.GW + x] = world.lattice.cov[i]; lattice.mat[y * lattice.GW + x] = world.lattice.mat[i];
        }
        const reference = planeReference(lattice, pixels, world.W, originX === undefined ? offsetY : localOffset, originX);
        const verticalInput = {
          ...input, biomePixels: pixels, hostChunks: new Uint32Array(world.W * 48),
          plane: { offsetY, shafts: originX === undefined ? undefined : [world.W / 2 - 1, world.W / 2].map(column => ({ column, lattice, offsetY: localOffset, originX })) },
        };
        const vertical = await createCompleteMaterialResolver(verticalInput, module);
        for (const pw of [-1, 0, 1]) {
          const rect = { x: pw * world.W * 512 - 18, y: offsetY + 507, w: 48, h: 24 };
          const actual = vertical.resolve(rect.x, rect.y, rect.w, rect.h);
          const expected = new Int32Array(rect.w * rect.h);
          for (let row = 0, i = 0; row < rect.h; row++) for (let col = 0; col < rect.w; col++, i++) expected[i] = reference(rect.x + col, rect.y + row);
          report.vertical.push({ ...options, plane, originX: originX ?? null, pw, ...compare(actual.materials, expected, `vertical ${options.seed}/${plane}/${originX}/${pw}`) });
        }
      }
    }
  }
  // Exact clipping, last duplicate shaft column wins, and shaft-before-host.
  const shaftInput = make({ plane: { offsetY: 24576 } });
  shaftInput.hostChunks.fill(2048);
  const air = { ...shaftInput.lattice, cov: new Float32Array(19 * 17) };
  const shaft = { column: 35, lattice: shaftInput.lattice, offsetY: 24576, originX: 0 };
  shaftInput.plane.shafts = [{ ...shaft, lattice: air }, shaft];
  const shaftResolver = await createCompleteMaterialResolver(shaftInput, module);
  assert.deepEqual([...shaftResolver.resolve(-1, 24676, 2, 1).materials], [0, 1]);
  assert.deepEqual([...shaftResolver.resolve(0, 17407, 1, 2).classifications], [C.outsidePlane, C.resolved]);
  assert.deepEqual([...shaftResolver.resolve(0, 41983, 1, 2).materials], [1, 0]);
  shaft.offsetY = Number.NaN; shaftInput.lattice.GW = 0;
  assert.equal(shaftResolver.resolve(0, 24676, 1, 1).materials[0], 1, "Resolver retained mutable caller configuration");
  report.classifications.push("shaft-precedence-duplicates-clipping-and-owned-inputs");
  await assert.rejects(createCompleteMaterialResolver(make({ seed: -1 }), module), RangeError);
  await assert.rejects(createCompleteMaterialResolver(make(), module, { maxBytes: 1024 }), /memory budget/);
  assert.throws(() => selector.resolve(0, 0, 0, 1), RangeError);
  assert.throws(() => selector.resolve(0, 0, 1025, 1), RangeError);
  assert.throws(() => selector.selectBandPoints([{ biomeId: 0, x: 0, y: 0, density: 0.1 }]), /exact float32/);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(error);
}
report.totals = {
  seedGridCells: report.seedGrids.reduce((n, row) => n + row.pixels, 0),
  mainPixels: report.main.reduce((n, row) => n + row.pixels, 0),
  verticalPixels: report.vertical.reduce((n, row) => n + row.pixels, 0),
  bandPoints: Object.values(report.bands).reduce((n, row) => n + row.pixels, 0),
  mismatches: [...report.seedGrids, ...report.main, ...report.vertical, ...Object.values(report.bands)].reduce((n, row) => n + row.mismatches, 0),
};
await writeFile(new URL("parity-result.json", base), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ success: report.success, ...report.totals, explicitClassificationChecks: report.classifications.length }));
