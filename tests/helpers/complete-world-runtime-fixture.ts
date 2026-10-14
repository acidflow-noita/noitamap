import { createNativeWorldGenerator } from "../../src/native-map/world";
import { createCompleteWorldSource, createCurrentMapScenePolicy } from "../../src/native-map/complete-world";
import { GENERATOR_CONFIG } from "../../src/native-map/rules/generator_config.js";
import { setFullPixelTerrainForBake } from "../../src/renderer_settings";
import { initTelescope } from "../../src/telescope/telescope-adapter";
import { prepareTerrainPlane } from "../../src/telescope/terrain-planes";
// @ts-expect-error Explicit independent JS edge-stamper oracle in test bundle.
import { createCpuTerrain as createReference } from "../../src/telescope/cpu-terrain-core?edge-reference";
import { SharedPixelStore } from "../../src/native-map/cooked-pixels/store";
import { reduceFinalPixels } from "../../src/native-map/cooked-pixels/mip";
import materialUrl from "../../src/native-map/complete-materials/complete-materials.wasm?url";
import edgeUrl from "../../src/native-map/edges/core.wasm?url";
import type { NativeAssets } from "../../src/native-map/asset-host";

export async function verifyCompleteWorld(assets: NativeAssets) {
  const seed = 20261014, start = performance.now();
  const generator = await createNativeWorldGenerator(assets);
  const initialized = performance.now();
  const now = new Date();
  const world = await generator.generate({ seed, parallelWorlds: [-1, 0, 1], calendar: { month: now.getMonth() + 1, day: now.getDate() }, unlocks: null });
  const generated = performance.now();
  const [materialModule, edgeModule] = await Promise.all([materialUrl, edgeUrl].map(async url => WebAssembly.compile(await (await fetch(url)).arrayBuffer())));
  let abortAtYield: AbortController | undefined;
  const source = await createCompleteWorldSource(world, {
    assets, materialModule, edgeModule, generatorConfig: GENERATOR_CONFIG,
    hostPolicy: "legacy-fill",
    scenePolicy: createCurrentMapScenePolicy({ capturedGold: "static-capture", mapWidth: world.worldSize }),
    resolverBytes: 128 * 1024 * 1024, preparedSceneBytes: 16 * 1024 * 1024,
    sourceSceneBytes: 8 * 1024 * 1024,
    yieldControl: async () => {
      if (abortAtYield) { const controller = abortAtYield; abortAtYield = undefined; controller.abort(new Error("Test page cancellation")); }
    },
  });
  const setupMs = performance.now() - generated;
  if (source.scope !== "terrain-scenes-layer") throw new Error("Source hid its captured-art scope");
  const addressCount = [...source.pageAddresses()].length;
  if (addressCount !== world.worldSize * 48 * 9) throw new Error("Incomplete all-nine page addressing");
  // Same world decisions feed the existing source oracle. No regenerated or
  // reseeded geometry is substituted for the NativeWorldDescription inputs.
  const pixelScenesByPW: Record<string, any[]> = {};
  for (const horizontal of [-1, 0, 1]) pixelScenesByPW[`${horizontal},0`] = [0, -1, 1].flatMap(vertical => world.regions.find(r => r.horizontal === horizontal && r.vertical === vertical)!.scenes);
  const generation: any = { ...world, isNGP: world.ngPlus > 0, parallelWorlds: [-1, 0, 1], pixelScenesByPW, poisByPW: {}, eyes: [] };
  setFullPixelTerrainForBake(true);
  await initTelescope();
  (globalThis as any).OpenSeadragon = (await import("openseadragon")).default;
  const { prepareTerrainSceneData } = await import("../../src/telescope/telescope-osd-bridge");
  const sceneData = await prepareTerrainSceneData(generation);
  const store = new SharedPixelStore({ pageSize: 512 });
  const samples = [];
  let storedMipBytes = 0, storedMipCount = 0;
  const compare = (actual: Uint8Array | Uint8ClampedArray, expected: Uint8Array | Uint8ClampedArray, label: string) => {
    if (actual.length !== expected.length) throw new Error(`${label}: length mismatch`);
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) throw new Error(`${label}: byte ${i}, ${actual[i]} != ${expected[i]}`);
  };
  for (const vertical of [0, -1, 1] as const) {
    const input = { ...await prepareTerrainPlane(generation, vertical), sceneData };
    const reference = await createReference(input, { nativeMaterials: false });
    const offsetY = vertical * 24576;
    const areas = [-1, 0, 1].map(horizontal => ({ horizontal, vertical,
      x: (vertical === 0 ? -32 : -4032) + horizontal * world.worldSize * 512,
      y: offsetY + (vertical === 0 ? 480 : 64), width: 512, height: 512, name: "region" }));
    if (vertical === 0) areas.push({ horizontal: 0, vertical, x: 0, y: 8704, width: 512, height: 512, name: "vault" });
    if (vertical === 1 && world.elevatorShafts.length) areas.push({ horizontal: 0, vertical,
      x: world.elevatorShafts[0].minX * 512 - world.worldCenter * 512, y: offsetY + 1024,
      width: 512, height: 512, name: "shaft" });
    for (const area of areas) {
      const expected = new Uint8ClampedArray(area.width * area.height * 4);
      reference.renderRows(area.x, area.y, area.width, 0, area.height, expected);
      reference.finish(expected, area.x, area.y, area.width, area.height);
      const began = performance.now();
      const actual = area.name === "vault"
        ? await source.renderPage({ horizontal: 0, vertical: 0, column: 35, row: 31 })
        : await source.renderRect(area);
      const rasterMs = performance.now() - began;
      compare(actual.pixels, expected, `${vertical}/${area.horizontal}/${area.name}`);
      const committed = performance.now();
      const id = samples.length % 2 ? store.commitPage(store.addBlock(actual.pixels, 512)) : store.addPage(actual.pixels);
      const commitMs = performance.now() - committed;
      let current: Uint8Array | Uint8ClampedArray = expected, side = 512;
      for (let level = 0; level <= 9; level++) {
        const decoded = store.decoder().readRect(id, level, 0, 0, side, side);
        compare(decoded, current, `stored ${vertical}/${area.horizontal}/${area.name}/mip${level}`);
        storedMipBytes += decoded.byteLength; storedMipCount++;
        if (side > 1) { current = reduceFinalPixels(current, side, side).data; side /= 2; }
      }
      const immutable = store.decoder().readRect(id, 0, 0, 0, 512, 512);
      actual.pixels.fill(91); // durable store must own its final bytes
      compare(store.decoder().readRect(id, 0, 0, 0, 512, 512), immutable, "stored page ownership");
      samples.push({ ...area, comparedBytes: expected.byteLength, mismatchedBytes: 0, rasterMs, commitMs,
        sceneCount: actual.sceneCount, staticMaskCount: actual.staticMaskCount, visiblePixels: expected.reduce((n, v, i) => n + Number(i % 4 === 3 && v > 0), 0) });
    }
  }
  const cancelled = new AbortController(); abortAtYield = cancelled;
  let cancelledAsExpected = false;
  try { await source.renderRect({ horizontal: 0, vertical: 0, x: 0, y: 512, width: 32, height: 32 }, cancelled.signal); }
  catch (error) { cancelledAsExpected = cancelled.signal.aborted; if (!cancelledAsExpected) throw error; }
  const resumed = await source.renderRect({ horizontal: 0, vertical: 0, x: 0, y: 512, width: 32, height: 32 });
  const serialized = await Promise.all([
    source.renderRect({ horizontal: 0, vertical: 0, x: 0, y: 512, width: 32, height: 32 }),
    source.renderRect({ horizontal: 0, vertical: 1, x: 0, y: 25088, width: 32, height: 32 }),
  ]);
  compare(resumed.pixels, serialized[0].pixels, "queued independent output");
  const stats = source.stats;
  let invalidAddressRejected = false;
  try { await source.renderPage({ horizontal: 0, vertical: 0, column: 70, row: 0 }); }
  catch { invalidAddressRejected = true; }
  const suspendedAddresses = source.pageAddresses(); suspendedAddresses.next();
  source.dispose();
  let disposedIteratorRejected = false;
  try { suspendedAddresses.next(); } catch { disposedIteratorRejected = true; }
  let disposedRejected = false;
  try { await source.renderRect({ horizontal: 0, vertical: 0, x: 0, y: 512, width: 32, height: 32 }); }
  catch { disposedRejected = true; }
  return { seed, scope: source.scope, regions: source.regions, addressCount, samples,
    timings: { generatorPreparationMs: initialized - start, worldGenerationMs: generated - initialized, sourceSetupMs: setupMs },
    storedMipBytes, storedMipCount, store: store.stats(), stats, cancelledAsExpected, disposedRejected, invalidAddressRejected, disposedIteratorRejected };
}
