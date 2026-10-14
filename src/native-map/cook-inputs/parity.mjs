#!/usr/bin/env node
// Reference-only development test. No runtime file imports this oracle.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ts from "typescript";
import JSZip from "jszip";
import { decodePngToRgba } from "../png.ts";
import { loadMaterialAtlas, materialTexelRGBA, materialFlatAlpha } from "./atlas.ts";
import { loadLegacyColorPolicy, createLegacyColorResolver } from "./legacy.ts";
import { prepareWorldMaterialInputs, buildHostChunks, buildMaterialLattice } from "./materials.ts";
import { createBaseForegroundPainter, ForegroundClassification } from "./foreground.ts";
import { createCompleteMaterialResolver, MaterialClassification } from "../complete-materials/index.ts";
import { engineWorld } from "../../../lib/noita-telescope-vm/test/helpers/generate.mjs";
import { buildEngineLattice } from "../../../lib/noita-telescope-vm/js/engine_resolve/lattice_builder.js";
import { buildEngineResources, buildMatColorTable } from "../../../lib/noita-telescope-vm/js/gl/engine_resources.js";
import { buildTerrainResources } from "../../../lib/noita-telescope-vm/js/gl/terrain_resources.js";
import { buildChunkTextures, CHUNK_FLAG_FILL, CHUNK_FLAG_FG_DEFINED, CHUNK_FLAG_HAS_TILES } from "../../../lib/noita-telescope-vm/js/gl/chunk_textures.js";
import * as referenceAtlas from "../../../lib/noita-telescope-vm/js/gl/material_atlas.js";
import { getTileOverlayBiome, chunkAtRasterTile, initBiomeColors, TILE_FOREGROUND_COLORS, edgeNoiseOverlayExceptions } from "../../../lib/noita-telescope-vm/js/image_processing.js";
import { PALETTE_ALPHA_SKIP, PALETTE_ALPHA_CHUNK_FG, PALETTE_SIZE } from "../../../lib/noita-telescope-vm/js/gl/palette.js";
import { NO_REGION } from "../../../lib/noita-telescope-vm/js/gl/indirection.js";
import { BIOME_ENGINE } from "../complete-materials/engine-data.mjs";
import { BIOME_COLOR_TO_NAME } from "../../../lib/noita-telescope-vm/js/generator_config.js";

const base = new URL("./", import.meta.url);
let archive;
async function archiveAsset(path) {
  archive ??= JSZip.loadAsync(await readFile(new URL("../../../public/data.zip", base)));
  return (await archive).file(path)?.async("uint8array");
}
const assets = { revision: "pinned-source-parity-authoritative-biome-impl", async read(path) {
  if (path.startsWith("data/biome_impl/")) {
    const bytes = await archiveAsset(path);
    if (!bytes) throw new Error(`Missing authoritative biome asset: ${path}`);
    return bytes;
  }
  try { return await readFile(new URL("../../../lib/noita-telescope-vm/" + path, base)); }
  catch (error) { if (error.code !== "ENOENT") throw error; const bytes = await archiveAsset(path); if (!bytes) throw error; return bytes; }
} };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const binary = await readFile(new URL("../complete-materials/complete-materials.wasm", base));
const module = await WebAssembly.compile(binary);
const atlas = await loadMaterialAtlas(assets), policy = await loadLegacyColorPolicy(assets);
const report = { scope: "Exact source lattice/host/atlas/raw foreground integration; no final composed-map claim.", artifactSha256: hash(binary), atlas: {}, worlds: [], raw: [], foreground: [], policies: [] };
function compare(a, b, label) {
  assert.equal(a.length, b.length, label);
  let mismatches = 0;
  const first = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
    mismatches++; if (first.length < 5) first.push({ i, actual: a[i], expected: b[i] });
  }
  assert.equal(mismatches, 0, `${label}: ${JSON.stringify(first)}`);
  return { values: a.length, mismatches, sha256: hash(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) };
}
const mod = (v, size) => ((v % size) + size) % size;
const packed = (r, g, b, a) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
async function rawFactory() {
  const source = await readFile(new URL("../../../src/telescope/cpu-terrain-core.ts", base), "utf8");
  const start = source.indexOf("  function rawColorAt("), end = source.indexOf("  function colorAt(", start);
  assert(start > 0 && end > start);
  const names = "materialCache,materials,texture,packed,getTileOverlayBiome,gen,mapWidth,mod,chunks,CHUNK_FLAG_FILL,fillMaterials,foreground,CHUNK_FLAG_HAS_TILES,centerPx,worldWidth,worldStride,chunkAtRasterTile,resources,NO_REGION,PALETTE_ALPHA_SKIP,PALETTE_ALPHA_CHUNK_FG,CHUNK_FLAG_FG_DEFINED,paletteMaterials,PALETTE_SIZE";
  const sourceModule = `export function factory(deps) { const {${names}}=deps; ${source.slice(start, end)}; return rawColorAt; }`;
  const js = ts.transpileModule(sourceModule, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  report.rawReferenceSha256 = hash(source.slice(start, end));
  return (await import("data:text/javascript," + encodeURIComponent(js))).factory;
}
try {
  await initBiomeColors();
  // Execute the unmodified source lookup body with its current delivered
  // biome_impl images. The Node helper otherwise reads stale fork PNG copies.
  const lookupSource = await readFile(new URL("../../../lib/noita-telescope-vm/js/image_processing.js", base), "utf8");
  const lookupBody = lookupSource.slice(lookupSource.indexOf("export async function createBiomeColorLookup"), lookupSource.indexOf("// TODO: Rename these"));
  const lookupFactory = await import("data:text/javascript," + encodeURIComponent(`export function factory(loadPNG,BIOME_COLOR_TO_NAME){ ${lookupBody.replace("export async function", "async function")}; return createBiomeColorLookup; }`));
  const lookup = lookupFactory.factory(async path => decodePngToRgba(Uint8Array.from(await assets.read(path.replace("../data/biome_maps/", "data/biome_impl/"))).buffer), BIOME_COLOR_TO_NAME);
  const [, foreground] = await lookup("../data/biome_maps/biome_map_foreground.png");
  for (const key of Object.keys(TILE_FOREGROUND_COLORS)) delete TILE_FOREGROUND_COLORS[key];
  Object.assign(TILE_FOREGROUND_COLORS, foreground);
  report.authoritativeColorLookupSha256 = hash(lookupBody);
  report.biomeColorAssetAuthority = "public/data.zip:data/biome_impl";
  assert.deepEqual(Object.fromEntries(policy.foregroundColors), TILE_FOREGROUND_COLORS);
  assert.deepEqual(policy.edgeNoiseExceptions, edgeNoiseOverlayExceptions);
  report.atlas.materialTable = compare(atlas.materialTable, buildMatColorTable(atlas).data, "flat material table");
  let texels = 0;
  for (let entry = 1; entry <= atlas.entryCount; entry++) for (const x of [-53824, -1, 0, 1, 173, 35840]) for (const y of [-31744, -1, 0, 1, 259, 41983]) {
    assert.equal(materialTexelRGBA(atlas, entry, x, y), referenceAtlas.materialTexelRGBA(atlas, entry, x, y)); texels++;
  }
  for (const name of atlas.materialByName.keys()) assert.equal(materialFlatAlpha(atlas, name), referenceAtlas.materialFlatAlpha(atlas, name));
  report.atlas.texels = texels; report.atlas.entries = atlas.entryCount;
  const makeRaw = await rawFactory();
  for (const options of [{ seed: 786433191, ngPlus: 0 }, { seed: 42, ngPlus: 2 }, { seed: 195331, ngPlus: 0 }]) {
    const world = await engineWorld(options);
    const description = { seed: options.seed, ngPlus: options.ngPlus, gameMode: "normal", worldSize: world.W, worldCenter: world.W / 2, biomeData: world.biomeData, tileLayers: world.layers, elevatorShafts: [] };
    // Exercise an actual generated lower shaft when the source owns one.
    if (options.seed === 786433191) {
      const bottom = world.layers.find(layer => layer.biomeName === "robobase" && layer.buffer && [...(layer.validChunks ?? [])].some(key => key.endsWith(",47")));
      if (bottom) {
        const [column] = [...bottom.validChunks].find(key => key.endsWith(",47")).split(",").map(Number);
        const pixels = new Uint32Array(world.W * 96);
        for (let row = 47; row < 96; row++) pixels[row * world.W + column] = world.GENERATOR_CONFIG.robobase.color;
        const { generateBiomeTiles } = await import("../../../lib/noita-telescope-vm/js/tile_generator.js");
        const oldLog = console.log; console.log = () => {};
        try { description.elevatorShafts = await generateBiomeTiles(pixels, world.W, 96, { robobase: world.GENERATOR_CONFIG.robobase }, options.seed, options.ngPlus, 0, "normal"); }
        finally { console.log = oldLog; }
      }
    }
    const hostPolicy = { generatorConfig: world.GENERATOR_CONFIG, emptyTopology0: "legacy-fill" };
    const prepared = prepareWorldMaterialInputs(description, hostPolicy);
    const row = { ...options, latticeCoverage: compare(prepared.lattice.cov, world.lattice.cov, "coverage lattice"), latticeMaterials: compare(prepared.lattice.mat, world.lattice.mat, "material lattice"), covered: compare(prepared.lattice.chunkCovered, world.lattice.chunkCovered, "covered chunks"), planes: [] };
    for (const plane of [-1, 0, 1]) {
      const input = prepared.forPlane(plane), offsetY = plane * 24576;
      const reference = buildEngineResources(world.layers, { pixels: input.biomePixels }, world.GENERATOR_CONFIG, world.W);
      row.planes.push({ plane, host: compare(input.hostChunks, reference.chunk, "host chunks"), shafts: input.plane?.shafts?.length ?? 0 });
      for (const [i, shaft] of (input.plane?.shafts ?? []).entries()) {
        const original = description.elevatorShafts[i];
        const expected = buildEngineLattice([{ ...original, minX: 0, minY: 0, chunkBasePos: { x: 0, y: 0 }, validChunks: undefined }], world.GENERATOR_CONFIG, Math.ceil(original.w / 512), Math.ceil(original.h / 512));
        compare(shaft.lattice.cov, expected.cov, "shaft coverage"); compare(shaft.lattice.mat, expected.mat, "shaft material");
        assert.equal(shaft.offsetY, Math.trunc(original.minY * 512 / 10) * 10);
      }
      const raw = createLegacyColorResolver(description, prepared, plane, world.GENERATOR_CONFIG, atlas, policy);
      const biomeData = {
        pixels: input.biomePixels,
        heavenPixels: plane === 0 ? prepared.forPlane(-1).biomePixels : input.biomePixels,
        hellPixels: plane === 0 ? prepared.forPlane(1).biomePixels : input.biomePixels,
      };
      const gen = { biomeData, isNGP: options.ngPlus > 0, gameMode: "normal" };
      const resources = buildTerrainResources(world.layers, world.biomeData, { isNGP: gen.isNGP, gameMode: "normal", maxTextureSize: 16384, lut: { recolorMaterials: true, clearSpawnPixels: true } });
      const chunks = buildChunkTextures(biomeData, world.W);
      const texture = (entry, x, y) => { const c = referenceAtlas.materialTexelRGBA(atlas, entry, x, y); return c < 0 ? 0 : c; };
      const expectedRaw = makeRaw({ materialCache: { materialAt: () => -1 }, materials: atlas.materialTable, texture, packed, getTileOverlayBiome, gen, mapWidth: world.W, mod, chunks, CHUNK_FLAG_FILL,
        fillMaterials: referenceAtlas.buildFillMaterialTable(atlas, biomeData, world.W), foreground: index => { const p = index * 4; return packed(...chunks.fg.subarray(p, p + 4)); }, CHUNK_FLAG_HAS_TILES,
        centerPx: prepared.centerPx, worldWidth: prepared.worldWidth, worldStride: prepared.worldStride, chunkAtRasterTile, resources, NO_REGION, PALETTE_ALPHA_SKIP, PALETTE_ALPHA_CHUNK_FG, CHUNK_FLAG_FG_DEFINED,
        paletteMaterials: referenceAtlas.buildPaletteMaterialTable(atlas, resources.palette), PALETTE_SIZE });
      const rectangles = [
        { name: "mixed", x: -4400, y: -512 + offsetY, w: 160, h: 128 },
        { name: "mines", x: -512, y: 512 + offsetY, w: 160, h: 128 },
        { name: "temple", x: -512, y: 1536 + offsetY, w: 160, h: 128 },
        { name: "west-seam", x: -prepared.worldWidth - 32, y: 512 + offsetY, w: 160, h: 128 },
      ];
      for (const rect of rectangles) {
        const actual = new Uint32Array(rect.w * rect.h), expected = new Uint32Array(actual.length);
        for (let y = 0, i = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++, i++) {
          actual[i] = raw.colorAt(rect.x + x, rect.y + y);
          expected[i] = expectedRaw(rect.x + x, rect.y + y - offsetY, rect.y + y, -1);
        }
        report.raw.push({ ...options, plane, ...rect, ...compare(actual, expected, `raw ${options.seed}/${plane}/${rect.name}`) });
      }
      const resolver = await createCompleteMaterialResolver(input, module);
      const painter = createBaseForegroundPainter({ materials: resolver, atlas, ownsTerrain: () => true, legacy: raw });
      const rect = rectangles[2], result = painter.paintRect(rect.x, rect.y, rect.w, rect.h), expected = new Uint8ClampedArray(result.pixels.length);
      for (let y = 0, i = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++, i++) {
        const c = expectedRaw(rect.x + x, rect.y + y - offsetY, rect.y + y, result.materials[i]);
        expected.set([(c >>> 16) & 255, (c >>> 8) & 255, c & 255, c >>> 24], i * 4);
      }
      assert.equal(result.unresolvedCount, 0);
      report.foreground.push({ ...options, plane, ...compare(result.pixels, expected, "base foreground") });
    }
    report.worlds.push(row);
  }
  // Required policy, intentional air versus explicit stand-in, and missing work.
  const biome = BIOME_ENGINE.find(b => b.topo === 0 && !b.bands.length && !b.paintsNothing);
  assert(biome);
  const tiny = { GW: 1, GH: 1, cov: new Float32Array(1), mat: new Uint16Array(1), chunkCovered: new Uint8Array(70 * 48) };
  const colors = new Uint32Array(70 * 48).fill(biome.color), config = { test: { color: biome.color, fillMaterial: "rock_static" } };
  assert(buildHostChunks(colors, tiny, 70, { generatorConfig: config, emptyTopology0: "engine-air" })[0] & 2048);
  assert.equal((buildHostChunks(colors, tiny, 70, { generatorConfig: config, emptyTopology0: "legacy-fill" })[0] >> 8) & 3, 2);
  assert.throws(() => buildHostChunks(colors, tiny, 70, { generatorConfig: config }), /Explicit/);
  const fake = { resolve: () => ({ materials: new Int32Array([-1, -1, -1]), classifications: new Uint8Array([MaterialClassification.missingModifier, MaterialClassification.legacy, MaterialClassification.unowned]) }) };
  const p = createBaseForegroundPainter({ materials: fake, atlas, ownsTerrain: x => x !== 2, legacy: { colorAt: () => 0xff123456 } }).paintRect(0, 0, 3, 1);
  assert.deepEqual([...p.classifications], [ForegroundClassification.unresolved, ForegroundClassification.legacyColor, ForegroundClassification.outsideOwnership]);
  assert.equal(p.unresolvedCount, 1);
  report.policies.push("explicit empty-topology0 policy", "missing modifier remains unresolved", "raw fallback distinct from resolved materials", "ownership gates source pixels");
  report.success = true;
} catch (error) {
  report.success = false; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(error);
}
report.totals = {
  mainLatticeCells: report.worlds.reduce((n, w) => n + w.latticeCoverage.values, 0),
  hostChunks: report.worlds.flatMap(w => w.planes).reduce((n, p) => n + p.host.values, 0),
  rawPixels: report.raw.reduce((n, r) => n + r.values, 0),
  foregroundBytes: report.foreground.reduce((n, r) => n + r.values, 0),
  mismatches: [...report.raw, ...report.foreground].reduce((n, r) => n + r.mismatches, 0),
};
await writeFile(new URL("parity-result.json", base), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ success: report.success, ...report.totals }));
