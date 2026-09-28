import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { generateDynamicMap } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
import { setTerrainPlane } from "../../src/telescope/instant-terrain-plane";
import { prewarmTerrainShader } from "../../src/telescope/terrain-shader-prewarm";
import { SharedInstantTerrainResources, buildPlaneEngineChunks } from "../../src/telescope/shared-instant-terrain";
import { GLTerrainRenderer } from "noita-telescope-full-pixels/gl/terrain_renderer.js";
import { initMaterialAtlas } from "noita-telescope-full-pixels/gl/material_atlas.js";
import { GENERATOR_CONFIG, BIOME_COLOR_TO_NAME, FILL_LAYER_COLORS } from "noita-telescope-full-pixels/generator_config.js";
import { BIOME_ENGINE } from "noita-telescope-full-pixels/engine_resolve/engine_data.js";
import { buildEngineResources } from "noita-telescope-full-pixels/gl/engine_resources.js";
import { buildEngineLattice } from "noita-telescope-full-pixels/engine_resolve/lattice_builder.js";
import { setTopo2WorldOffX } from "noita-telescope-full-pixels/engine_resolve/topo2_resolve.js";
import { createPlaneMaterialField } from "../../src/telescope/plane-material-field";
import { createMaterialField } from "noita-telescope-full-pixels/engine_resolve/material_field.js";
import { encodeTerrainPages, decodeTerrainPage } from "../../src/telescope/retained-terrain-codec-core";

type Plane = -1 | 0 | 1;
type Sample = { name: string; plane: Plane; pw: number; x: number; y: number; width: number; height: number };

export async function verifySharedTerrainResources() {
  const trace = (globalThis as any).__sharedResourceTrace;
  const phase = (value: string) => { trace.phase = value; };
  const count = (list: string[], selected: string) => list.filter(value => value === selected).length;
  const uploads = (selected: string) => trace.uploads.filter((entry: any) => entry.phase === selected);
  const largeUploads = (selected: string) => uploads(selected).filter((entry: any) => entry.bytes >= 1024 ** 2).length;
  setFullPixelTerrainForBake(true);
  const generation = await generateDynamicMap({ seed: 786433191, ngPlus: 0, parallelWorlds: [0], unlocks: null });
  await initMaterialAtlas();
  const options = {
    seed: generation.seed, isNGP: false, gameMode: "normal", engineTerrain: true,
    generatorConfig: GENERATOR_CONFIG, lut: { recolorMaterials: true, clearSpawnPixels: true },
  };
  const samples: Sample[] = [];
  for (const plane of [0, -1, 1] as const) for (const pw of [-1, 0, 1]) {
    for (const [name, x, y, width, height] of [
      ["mixed-wang", -4032, 64, 64, 64],
      ["warped-material", -3520, 1600, 64, 64],
      ["world-and-plane-top-seam", -17936, -7184, 32, 32],
      ["plane-bottom-seam", -4032, 17392, 32, 32],
    ] as const) samples.push({ name, plane, pw, x: x + pw * 35840, y: y + plane * 24576, width, height });
  }
  // A real stand-in fill exercises the legacy fallback alongside the engine
  // resolver. Its location is read from this seed's biome map, not fabricated.
  const temple = Array.from(generation.biomeData.pixels as Uint32Array)
    .findIndex(color => BIOME_COLOR_TO_NAME[color & 0xffffff] === "temple_wall");
  if (temple < 0) throw new Error("Fixture seed no longer contains temple_wall fallback");
  for (const pw of [-1, 0, 1]) samples.push({ name: "temple-fallback", plane: 0, pw,
    x: (temple % 70) * 512 - 17920 + 240 + pw * 35840,
    y: Math.floor(temple / 70) * 512 - 7168 + 240, width: 32, height: 32 });

  const view = (sample: Sample) => ({ width: sample.width, height: sample.height,
    camX: sample.x + sample.width / 2 + 17920 - sample.pw * 35840,
    camY: sample.y + sample.height / 2 + 7168, camZ: 1, pw: sample.pw, pwVertical: 0,
    edgeNoise: true, materialTextures: true, engineTerrain: true });
  const pixels = (renderer: any, render: () => any, material = false) => {
    // The native harness multiplexes its one GLES context onto canvas objects.
    // Selecting a canvas here changes only the harness's readback destination.
    renderer.canvas?.getContext("webgl2");
    const canvas = render();
    if (!canvas) throw new Error(renderer.failed || "Terrain renderer returned no canvas");
    if (material) {
      renderer.gl.uniform1i(renderer.uniforms.u_materialIdOut, 1);
      renderer.gl.drawArrays(renderer.gl.TRIANGLES, 0, 3);
    }
    if (renderer.gl.getError()) throw new Error("Native terrain GL error");
    return new Uint8ClampedArray(canvas.__nativeGlesPixels);
  };
  const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    if (a.length !== b.length) throw new Error("Reference and shared dimensions differ");
    let mismatchedBytes = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mismatchedBytes++;
    return mismatchedBytes;
  };
  const destroyReference = (renderer: any) => {
    renderer.invalidate();
    if (renderer.program) renderer.gl.deleteProgram(renderer.program);
  };
  const expected = new Map<Sample, Uint8ClampedArray>();
  const expectedTables = new Map<Plane, Uint16Array>();
  let tableCellsCompared = 0, tableMismatches = 0, selectedPlaneTableMismatches = 0;
  let referenceCoverage: Uint8Array | undefined;
  phase("reference");
  for (const plane of [0, -1, 1] as const) {
    const data = await prepareTerrainPlane(generation, plane), renderer = new GLTerrainRenderer();
    await prewarmTerrainShader(renderer);
    if (!renderer.ensureResources(data.tileLayers, data.biomeData, options)) throw new Error(renderer.failed);
    if (!renderer.engineReady) throw new Error("Reference engine resources are incomplete");
    const table = new Uint16Array(renderer.engineChunkModes);
    expectedTables.set(plane, table);
    const coverage = trace.coverage.at(-1);
    if (coverage?.phase !== "reference") throw new Error("Actual reference lattice coverage was not captured");
    if (plane === 0) referenceCoverage = coverage.covered;
    const factored = buildPlaneEngineChunks(data.biomeData.pixels, coverage.covered);
    for (let i = 0; i < table.length; i++) {
      tableCellsCompared++;
      if (factored[i] !== table[i]) tableMismatches++;
    }
    if (plane === 0 && ((renderer.engineChunkModes[temple] >> 8) & 3) !== 2)
      throw new Error("Temple sample no longer exercises the legacy fallback");
    setTerrainPlane(renderer, plane);
    for (const sample of samples.filter(sample => sample.plane === plane))
      expected.set(sample, pixels(renderer, () => renderer.render(view(sample))));
    destroyReference(renderer);
  }
  const referenceLatticeBuilds = count(trace.latticeBuilds, "reference");
  const referenceLargeUploads = largeUploads("reference");
  // These are actual textured native GL outputs, not screenshots or synthetic
  // uniform pages. Ratios describe only the sampled windows, not the full map.
  const compressionSamples = samples.map(sample => {
    const original = expected.get(sample)!;
    const encoded = encodeTerrainPages([{ width: sample.width, height: sample.height,
      pixels: original, columns: 1, rows: 1, coverage: new Uint8Array([1]) }])[0];
    const decoded = decodeTerrainPage(encoded);
    if (difference(original, decoded.pixels)) throw new Error("Native retained codec changed output bytes");
    return { name: sample.name, plane: sample.plane, pw: sample.pw,
      rawBytes: original.byteLength, encodedBytes: encoded.data.byteLength, encoding: encoded.encoding };
  });
  const retentionCompression = {
    rawBytes: compressionSamples.reduce((sum, sample) => sum + sample.rawBytes, 0),
    encodedBytes: compressionSamples.reduce((sum, sample) => sum + sample.encodedBytes, 0),
    samples: compressionSamples,
  };

  // Exercise every committed biome and every fill fallback, including biomes
  // absent from this seed. Each color occurs in both a covered and uncovered
  // cell of the real generated lattice; the oracle is upstream's whole builder.
  phase("all-biome-table-oracle");
  const colors = [...new Set<number>([
    ...BIOME_ENGINE.map((biome: any) => biome.color), ...FILL_LAYER_COLORS,
  ])];
  let unknown = 0x010203;
  while (colors.includes(unknown)) unknown++;
  colors.push(unknown);
  const covered: number[] = [], uncovered: number[] = [];
  referenceCoverage!.forEach((value, index) => (value ? covered : uncovered).push(index));
  if (covered.length < colors.length || uncovered.length < colors.length)
    throw new Error("Fixture lacks covered/uncovered cells for the complete biome table audit");
  const syntheticPixels = new Uint32Array(70 * 48).fill(unknown);
  colors.forEach((color, index) => {
    syntheticPixels[covered[index]] = color;
    syntheticPixels[uncovered[index]] = color;
  });
  const oracle = buildEngineResources(generation.tileLayers, { pixels: syntheticPixels }, GENERATOR_CONFIG, 70);
  const factored = buildPlaneEngineChunks(syntheticPixels, oracle.lattice.chunkCovered);
  let allBiomeTableMismatches = 0;
  for (let i = 0; i < oracle.chunk.length; i++) if (factored[i] !== oracle.chunk[i]) allBiomeTableMismatches++;
  const allBiomeColorsCompared = colors.length;
  const allBiomeCoveredCases = colors.length * 2;

  phase("shared-init");
  const renderer = new GLTerrainRenderer(), owner = new SharedInstantTerrainResources(renderer);
  await owner.ensureResources(generation.tileLayers, generation.biomeData, options);
  const sharedLatticeBuilds = count(trace.latticeBuilds, "shared-init");
  const sharedLargeUploads = largeUploads("shared-init");
  const payloadBytes = (selected: string) => uploads(selected)
    .filter((entry: any) => entry.method === "texImage2D")
    .reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  const referenceUploadedBytes = payloadBytes("reference");
  const sharedUploadedBytes = payloadBytes("shared-init");
  const planeUploads = uploads("shared-init").filter((entry: any) =>
    entry.method === "texImage2D" && entry.width === 70 && entry.height === 48);
  const allPlaneUploadedBytes = planeUploads.reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  const smallBytesPerPlane = allPlaneUploadedBytes / 3;
  phase("switches");
  const compared = [], referenceOrder = [...samples].sort((a, b) => a.name.localeCompare(b.name) || a.pw - b.pw || a.plane - b.plane);
  let comparedPixels = 0, mixedSamples = 0;
  for (const sample of referenceOrder) {
    owner.setPlane(sample.plane);
    const table = expectedTables.get(sample.plane)!;
    for (let i = 0; i < table.length; i++) if (renderer.engineChunkModes[i] !== table[i]) selectedPlaneTableMismatches++;
    const actual = pixels(renderer, () => owner.render(view(sample))), baseline = expected.get(sample)!;
    let nonAir = 0;
    for (let i = 3; i < baseline.length; i += 4) if (baseline[i]) nonAir++;
    if (nonAir > 0 && nonAir < baseline.length / 4) mixedSamples++;
    comparedPixels += baseline.length / 4;
    compared.push({ ...sample, nonAir, mismatchedBytes: difference(baseline, actual) });
  }
  // These known reference material IDs also prevent a shared regression in
  // the shader wrapper from making two equally incorrect renderers pass.
  owner.setPlane(0);
  const materialSamples = [[24,526],[78,515],[52,516],[36247,1000],
    [59,518],[-984,542],[31,4098],[7248,8193],[35882,512],[-35795,512]].map(([x,y]) => {
    const pw = Math.floor((x + 17920) / 35840);
    const sample = { name: "material-id", plane: 0 as const, pw, x, y, width: 1, height: 1 };
    const data = pixels(renderer, () => owner.render(view(sample)), true);
    return data[0] + (data[1] << 8) - 1;
  });
  const switchUploads = uploads("switches").length;
  const switchCompiles = count(trace.compiles, "switches");
  const switchLatticeBuilds = count(trace.latticeBuilds, "switches");
  phase("same-generation");
  await owner.ensureResources(generation.tileLayers, generation.biomeData, options);
  const sameGenerationUploads = uploads("same-generation").length;

  phase("invalidate");
  owner.invalidate();
  const firstDeletes = trace.deletes.filter((entry: any) => entry.phase === "invalidate").map((entry: any) => entry.texture);
  const deletionCount = trace.deletes.length;
  owner.invalidate();
  const idempotentInvalidation = deletionCount === trace.deletes.length;
  const created = trace.creates.filter((entry: any) => entry.phase === "shared-init").map((entry: any) => entry.texture);
  const deletedTextureTwice = new Set(firstDeletes).size !== firstDeletes.length;
  const liveTexturesAfterInvalidation = created.filter((texture: any) => !firstDeletes.includes(texture)).length;

  phase("reinitialize");
  await owner.ensureResources(generation.tileLayers, generation.biomeData, options);
  let reinitializedPixelsMatch = true;
  for (const plane of [-1, 0, 1] as const) {
    const sample = samples.find(sample => sample.plane === plane && sample.name === "warped-material" && sample.pw === -1)!;
    owner.setPlane(plane);
    if (difference(expected.get(sample)!, pixels(renderer, () => owner.render(view(sample))))) reinitializedPixelsMatch = false;
  }
  const reinitializedLatticeBuilds = count(trace.latticeBuilds, "reinitialize");
  const reinitializedCompiles = count(trace.compiles, "reinitialize");

  // Replace seed-dependent resources while holding geometry constant. This
  // deliberately isolates the seed key from the more usual new-layer identity.
  const changedOptions = { ...options, seed: options.seed + 77 };
  phase("changed-seed-reference");
  const changedReference = new GLTerrainRenderer();
  await prewarmTerrainShader(changedReference);
  if (!changedReference.ensureResources(generation.tileLayers, generation.biomeData, changedOptions))
    throw new Error(changedReference.failed);
  setTerrainPlane(changedReference, 0);
  const seedSamples = samples.filter(sample => sample.plane === 0 && sample.pw === 0);
  const changedExpected = seedSamples.map(sample => pixels(changedReference, () => changedReference.render(view(sample))));
  const changedSurfacePhase = changedReference.surfacePhase;
  destroyReference(changedReference);
  phase("replace-seed");
  await owner.ensureResources(generation.tileLayers, generation.biomeData, changedOptions);
  owner.setPlane(0);
  const replacedSeedPixelsMatch = seedSamples.every((sample, index) =>
    difference(changedExpected[index], pixels(renderer, () => owner.render(view(sample)))) === 0);
  const replacedSeedPhaseMatches = renderer.surfacePhase === changedSurfacePhase;
  const replacedSeedCompiles = count(trace.compiles, "replace-seed");
  phase("dispose");
  owner.invalidate();
  if (renderer.program) renderer.gl.deleteProgram(renderer.program);
  const owned = new Map<number, number>();
  for (const entry of trace.creates) if (["shared-init", "reinitialize", "replace-seed"].includes(entry.phase))
    owned.set(entry.texture, (owned.get(entry.texture) ?? 0) + 1);
  for (const entry of trace.deletes) if (["invalidate", "replace-seed", "dispose"].includes(entry.phase))
    owned.set(entry.texture, (owned.get(entry.texture) ?? 0) - 1);
  const allOwnedTexturesReleased = [...owned.values()].every(count => count === 0);
  // The old three-renderer reference never consumed generated elevator shafts.
  // Verify this exception against the independent CPU material resolver using
  // the actual continuous Wang buffer, including all three parallel worlds.
  phase("elevator");
  const lower = await prepareTerrainPlane(generation, 1);
  if (lower.elevatorShafts?.length !== 1) throw new Error("Missing fixture elevator shaft");
  const shaft = lower.elevatorShafts[0];
  const local = { ...shaft, minX: 0, minY: 0, chunkBasePos: { x: 0, y: 0 }, validChunks: undefined };
  const lattice = buildEngineLattice([local], GENERATOR_CONFIG, Math.ceil(shaft.w / 512), Math.ceil(shaft.h / 512));
  setTopo2WorldOffX(17920);
  const materialAt = createPlaneMaterialField(lattice, lower.biomeData.pixels, 70,
    Math.trunc(shaft.minY * 512 / 10) * 10, Math.trunc(shaft.minX * 512 / 10));
  // The shaft's edge wobble can select the neighboring solid-rock biome.
  // That topology-0 material uses the ordinary resolver, not shaft coverage.
  const neighboringMaterials = createMaterialField(generation.tileLayers, lower.biomeData,
    GENERATOR_CONFIG, 70, generation.seed, { lattice: oracle.lattice });
  const shaftRenderer = new GLTerrainRenderer(), shaftOwner = new SharedInstantTerrainResources(shaftRenderer);
  await shaftOwner.ensureResources(generation.tileLayers, generation.biomeData,
    { ...options, elevatorShafts: lower.elevatorShafts });
  const elevatorUploadCount = uploads("elevator").length;
  const elevatorCompileCount = count(trace.compiles, "elevator");
  let packedWorldPixelsMatch = true;
  for (const sample of samples) {
    shaftOwner.setPlane(sample.plane);
    if (difference(expected.get(sample)!, pixels(shaftRenderer, () => shaftOwner.render(view(sample)))))
      packedWorldPixelsMatch = false;
  }
  shaftOwner.setPlane(1);
  const elevatorSamples = [];
  for (const row of [0, 23, 47]) for (const pw of [-1, 0, 1]) {
    const sample: Sample = { name: "elevator", plane: 1, pw,
      x: shaft.minX * 512 - 17920 + pw * 35840,
      y: 17408 + row * 512 + 128, width: 512, height: 64 };
    const actual = pixels(shaftRenderer, () => shaftOwner.render(view(sample)), true);
    let mismatches = 0, solid = 0, air = 0, expectedSolid = 0;
    const mismatchKinds: Record<string, number> = {};
    for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
      const i = (y * sample.width + x) * 4;
      const material = actual[i] + (actual[i + 1] << 8) - 1;
      const shaftMaterial = materialAt(sample.x + x, sample.y + y);
      const expectedMaterial = shaftMaterial < 0
        ? neighboringMaterials.materialAt(sample.x + x, sample.y + y) : shaftMaterial;
      if (material !== expectedMaterial) {
        mismatches++;
        const key = `${expectedMaterial}:${material}`;
        mismatchKinds[key] = (mismatchKinds[key] ?? 0) + 1;
      }
      if (material > 0) solid++; else if (material === 0) air++;
      if (expectedMaterial > 0) expectedSolid++;
    }
    elevatorSamples.push({ row, pw, solid, air, expectedSolid, mismatches, mismatchKinds, pixels: sample.width * sample.height });
  }
  const elevatorLatticeBytes = shaftOwner.stats.latticeBytes;
  const elevatorSwitchUploads = uploads("elevator").length - elevatorUploadCount;
  const elevatorSwitchCompiles = count(trace.compiles, "elevator") - elevatorCompileCount;
  shaftOwner.invalidate();
  const elevatorCreates = trace.creates.filter((entry: any) => entry.phase === "elevator").map((entry: any) => entry.texture);
  const elevatorDeletes = trace.deletes.filter((entry: any) => entry.phase === "elevator").map((entry: any) => entry.texture);
  const elevatorTexturesReleased = elevatorCreates.length === elevatorDeletes.length &&
    elevatorCreates.every((texture: any) => elevatorDeletes.includes(texture));
  if (shaftRenderer.program) shaftRenderer.gl.deleteProgram(shaftRenderer.program);
  return { samples: compared, comparedPixels, mixedSamples, materialSamples, retentionCompression,
    elevatorSamples, elevatorLatticeBytes, packedWorldPixelsMatch,
    elevatorSwitchUploads, elevatorSwitchCompiles, elevatorTexturesReleased,
    tableCellsCompared, tableMismatches, selectedPlaneTableMismatches,
    allBiomeTableMismatches, allBiomeColorsCompared, allBiomeCoveredCases,
    referenceLatticeBuilds, sharedLatticeBuilds, referenceLargeUploads, sharedLargeUploads,
    referenceUploadedBytes, sharedUploadedBytes, allPlaneUploadedBytes, smallBytesPerPlane,
    switchUploads, switchCompiles, switchLatticeBuilds, sameGenerationUploads,
    idempotentInvalidation, deletedTextureTwice, liveTexturesAfterInvalidation,
    reinitializedPixelsMatch, reinitializedLatticeBuilds, reinitializedCompiles,
    replacedSeedPixelsMatch, replacedSeedPhaseMatches, replacedSeedCompiles, allOwnedTexturesReleased };
}
