import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CAVE_STATE_FORMAT, CAVE_STATE_SCOPE, CAVE_STATE_VERSION, CAVE_STATE_LIMITS,
  importCaveGenerationState, exportCaveGenerationState, copyCaveStateModifiers,
  validateCaveStateBinding, withCaveStateCacheIdentity,
  type CaveGenerationContext, type CaveStatePackage,
} from "../src/native-map/game-state";
import {
  createCompleteMaterialResolver, prepareTopology0Seed, MaterialClassification,
  type CompleteMaterialInputs,
} from "../src/native-map/complete-materials";
import { BIOME_ENGINE } from "../src/native-map/complete-materials/engine-data.mjs";
import { createCompleteWorldSource } from "../src/native-map/complete-world";

function context(): CaveGenerationContext {
  return { source: { binarySha256: "a".repeat(64), dataSha256: "b".repeat(64), configurationSha256: "c".repeat(64), loadOrderSha256: "d".repeat(64) },
    assetsRevision: "synthetic-cave-state-fixture", seed: 1103, ngPlus: 0, gameMode: "normal" };
}
function fixture(names = ["$biome_winter", "_EMPTY_"], density = 0, node94 = 2560): CaveStatePackage {
  const buffers: Record<string, Uint8Array> = {};
  const grids = names.map(key => {
    const width = 8, height = 4, bytes = new Uint8Array(width * height * 4), view = new DataView(bytes.buffer);
    for (let i = 0; i < width * height; i++) view.setFloat32(i * 4, density, true);
    buffers[key] = bytes;
    return { key, width, height, cellCount: width * height, byteLength: bytes.byteLength, node94,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return { manifest: { format: CAVE_STATE_FORMAT, version: CAVE_STATE_VERSION, scope: CAVE_STATE_SCOPE, context: context(),
    capture: { kind: "synthetic", captureId: "synthetic-only-1", consistency: "synthetic" }, grids }, buffers } as CaveStatePackage;
}
const mutate = (value: CaveStatePackage): any => structuredClone(value);
const imported = async (value = fixture()) => importCaveGenerationState(value, context());
const module = readFile(new URL("../src/native-map/complete-materials/complete-materials.wasm", import.meta.url))
  .then(bytes => WebAssembly.compile(bytes));
function input(): CompleteMaterialInputs {
  const index = BIOME_ENGINE.findIndex((b: any) => b.supported && b.topo === 0 && b.t0.gridKey === "$biome_winter");
  if (index < 0) throw new Error("Missing owned winter test biome");
  return { seed: context().seed, mapWidth: 70,
    lattice: { GW: 8, GH: 8, cov: new Float32Array(64), mat: new Uint16Array(64), chunkCovered: new Uint8Array(3360) },
    biomePixels: new Uint32Array(3360).fill(BIOME_ENGINE[index].color), hostChunks: new Uint32Array(3360).fill(index),
    parameters: [{ scale: 1, threshold: .5, type: 0 }] };
}

describe("owned named cave-state import (synthetic validation only)", () => {
  it("roundtrips exact bytes and offsets with immutable ownership across pending import and exported copies", async () => {
    const packet = fixture(undefined, -0, -0), pending = imported(packet);
    packet.buffers.$biome_winter!.fill(255);
    const state = await pending;
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.context.source)).toBe(true);
    const binding = { state, expected: context() }, first = copyCaveStateModifiers(binding);
    expect(Object.is(first.$biome_winter!.node94, -0)).toBe(true);
    expect(Object.is(first.$biome_winter!.data[0], -0)).toBe(true);
    first.$biome_winter!.data.fill(1);
    const exported = exportCaveGenerationState(state), copy = await imported(exported);
    expect(copy.digest).toBe(state.digest);
    exported.buffers.$biome_winter!.fill(1);
    expect(Object.is(copyCaveStateModifiers(binding).$biome_winter!.data[0], -0)).toBe(true);
    expect(() => validateCaveStateBinding({ state: structuredClone(state), expected: context() })).toThrow(/validated import/);
  });

  it("uses canonical semantic identities while separating grids, offsets, source revisions and seed-only caches", async () => {
    const packet = fixture(), baseline = await imported(packet), reordered = mutate(packet);
    reordered.manifest.grids.reverse(); reordered.manifest.capture.captureId = "other-capture";
    expect((await imported(reordered)).digest).toBe(baseline.digest);
    const changedGrid = await imported(fixture(undefined, 1)), changedOffset = await imported(fixture(undefined, 0, 17));
    expect(changedGrid.digest).not.toBe(baseline.digest); expect(changedOffset.digest).not.toBe(baseline.digest);
    expect(withCaveStateCacheIdentity("full-seed-settings", baseline)).not.toBe(withCaveStateCacheIdentity("full-seed-settings"));
    expect(withCaveStateCacheIdentity("full-seed-settings", baseline)).not.toBe(withCaveStateCacheIdentity("full-seed-settings", changedGrid));
    const newContext = { ...context(), source: { ...context().source, loadOrderSha256: "e".repeat(64) } };
    const updated = mutate(packet); updated.manifest.context = newContext;
    expect((await importCaveGenerationState(updated, newContext)).digest).not.toBe(baseline.digest);
  });

  it.each(["binarySha256", "dataSha256", "configurationSha256", "loadOrderSha256"])("rejects mismatched %s", async name => {
    const packet = mutate(fixture()); packet.manifest.context.source[name] = "1".repeat(64);
    await expect(imported(packet)).rejects.toThrow(/mismatch/);
  });
  it.each(["seed", "ngPlus", "gameMode", "assetsRevision"])("rejects a mismatched %s on import and use", async name => {
    const state = await imported(), expected: any = context();
    expected[name] = name === "gameMode" ? "nightmare" : name === "assetsRevision" ? "other" : expected[name] + 1;
    await expect(importCaveGenerationState(fixture(), expected)).rejects.toThrow(/mismatch/);
    expect(() => validateCaveStateBinding({ state, expected })).toThrow(/mismatch/);
  });

  it.each([
    (p: any) => p.manifest.version++,
    (p: any) => p.manifest.scope = "complete-game-run",
    (p: any) => p.manifest.grids[0].key = "winter_caves/direct-node",
    (p: any) => p.manifest.grids.push(p.manifest.grids[0]),
    (p: any) => p.manifest.grids[0].width = 0,
    (p: any) => p.manifest.grids[0].height = CAVE_STATE_LIMITS.axis + 1,
    (p: any) => p.manifest.grids[0].cellCount++,
    (p: any) => p.manifest.grids[0].node94 = Infinity,
    (p: any) => p.manifest.grids[0].node94 = .1,
    (p: any) => p.manifest.capture.consistency = "native-frame-42",
    (p: any) => p.manifest.capture.kind = "game-memory",
    (p: any) => p.manifest.unrecognized = true,
    (p: any) => p.buffers.$biome_desert = new Uint8Array(4),
    (p: any) => p.buffers.$biome_winter = p.buffers.$biome_winter.subarray(1),
    (p: any) => p.buffers.$biome_winter[0] ^= 1,
    (p: any) => new DataView(p.buffers.$biome_winter.buffer).setFloat32(0, NaN, true),
    (p: any) => p.buffers.$biome_winter = new Uint8Array(new SharedArrayBuffer(p.buffers.$biome_winter.byteLength)),
  ])("rejects malformed, unsupported or damaged capture inputs", async change => {
    const packet = mutate(fixture()); change(packet); await expect(imported(packet)).rejects.toThrow();
  });

  it("keeps absent runtime named grids explicitly missing and does not claim complete cave coverage", async () => {
    const state = await imported(fixture(["$biome_desert"])), data = copyCaveStateModifiers({ state, expected: context() });
    expect(state.scope).toBe("named-topology0-modifier-grids");
    expect(state.missingRuntimeGridKeys).toEqual(["$biome_winter", "_EMPTY_"]);
    expect(data.$biome_winter).toBeNull(); expect(data._EMPTY_).toBeNull(); expect(data.$biome_pyramid).toBeUndefined();
    const resolver = await createCompleteMaterialResolver({ ...input(), generationState: { state, expected: context() } }, await module, { maxWidth: 4, maxHeight: 4 });
    expect(resolver.resolve(1024, 1024, 4, 4).classifications).toEqual(new Uint8Array(16).fill(MaterialClassification.missingModifier));
  });

  it("passes captured density and node94 into the actual WASM and distinguishes changed state", async () => {
    const state = await imported(fixture(undefined, 0, 17)), binding = { state, expected: context() };
    const captured = await createCompleteMaterialResolver({ ...input(), generationState: binding }, await module, { maxWidth: 64, maxHeight: 64 });
    const explicit = prepareTopology0Seed(context().seed);
    Object.assign(explicit.modifiers, copyCaveStateModifiers(binding));
    const direct = await createCompleteMaterialResolver({ ...input(), topology0: explicit }, await module, { maxWidth: 64, maxHeight: 64 });
    expect(captured.generationStateDigest).toBe(state.digest); expect(direct.generationStateDigest).toBeNull();
    const rects = [[1024, 1024], [-1000, 256], [13000, 512], [0, 0]];
    for (const [x, y] of rects) {
      const a = captured.resolve(x, y, 64, 64), b = direct.resolve(x, y, 64, 64);
      expect(a.materials).toEqual(b.materials); expect(a.classifications).toEqual(b.classifications);
    }
    const solidState = await imported(fixture(undefined, 1, 17));
    const solid = await createCompleteMaterialResolver({ ...input(), generationState: { state: solidState, expected: context() } }, await module, { maxWidth: 64, maxHeight: 64 });
    expect(rects.some(([x, y]) => {
      const a = captured.resolve(x, y, 64, 64).materials, b = solid.resolve(x, y, 64, 64).materials;
      return a.some((value, i) => value !== b[i]);
    })).toBe(true);
    await expect(createCompleteMaterialResolver({ ...input(), topology0: explicit, generationState: binding }, await module)).rejects.toThrow(/conflict/);
    await expect(createCompleteMaterialResolver({ ...input(), seed: 1104, generationState: binding }, await module)).rejects.toThrow(/conflict/);
  });

  it("checks complete-world actual context before asset preparation", async () => {
    const state = await imported();
    const world: any = { kind: "native-world-description", revision: context().assetsRevision, seed: 1104, ngPlus: 0, gameMode: "normal" };
    const options: any = { assets: { revision: world.revision, read: () => { throw new Error("Must not load assets"); } }, generationState: { state, expected: context() } };
    await expect(createCompleteWorldSource(world, options)).rejects.toThrow(/seed mismatch/);
    world.seed = 1103; world.ngPlus = 1;
    await expect(createCompleteWorldSource(world, options)).rejects.toThrow(/ngPlus mismatch/);
  });
});
