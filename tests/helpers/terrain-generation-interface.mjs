import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";
const env = installNativeTerrainEnvironment({
  ...workerData,
  workerScript: new URL(
    "../../build_scripts/native-terrain-worker.mjs",
    import.meta.url,
  ),
});
const hash = (data) => createHash("sha256").update(data).digest("hex");
const summarize = (world) => ({
  biome: hash(new Uint8Array(world.biomeData.pixels.buffer)),
  layers: world.tileLayers.map((layer) => ({
    name: layer.biomeName,
    x: layer.minX,
    y: layer.minY,
    claims: [...(layer.validChunks ?? [])],
    pixels: layer.buffer ? hash(layer.buffer) : null,
  })),
  spawns: world.tileSpawns,
});
try {
  const api = await import(pathToFileURL(workerData.entry));
  const backgrounds = new Set([
    ...Object.values(api.SCENE_BACKGROUNDS),
    ...Object.values(api.SCENE_BACKGROUNDS_BY_BIOME).flatMap(Object.values),
  ]);
  for (const path of backgrounds) {
    const actual = await api.loadSceneBackground(path);
    const bytes = await readFile(resolve(workerData.root, "lib/noita-telescope-vm", path));
    const expected = api.decodePngToRgba(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    // UPNG retains RGB beneath fully transparent pixels; fast-png clears it.
    for (const image of [actual, expected])
      for (let i = 0; i < image.data.length; i += 4)
        if (image.data[i + 3] === 0) image.data.fill(0, i, i + 3);
    if (actual.width !== expected.width || actual.height !== expected.height || hash(actual.data) !== hash(expected.data))
      throw new Error(`Scene background differs: ${path}`);
  }
  const nativeDecompression = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    for (const path of backgrounds) {
      if (!path.startsWith("data/pixel_scenes/spliced/")) continue;
      const image = await api.loadSceneBackground(path);
      if (image.data.length !== image.width * image.height * 4 || !image.width)
        throw new Error(`Invalid PNG fallback: ${path}`);
    }
  } finally {
    globalThis.DecompressionStream = nativeDecompression;
  }
  await api.loadTerrainAssets({ translations: false, sceneWorkers: false });
  const results = [];
  for (const [seed, ngPlusCount, gameMode] of [
    [16981, 0, "normal"],
    [43, 1, "normal"],
    [44, 0, "nightmare"],
  ]) {
    const start = performance.now();
    const actual = await api.generateFullPixelWorld(
      seed,
      ngPlusCount,
      gameMode,
    );
    const ms = performance.now() - start;
    const expected = await api.generateTerrainWorld({
      seed,
      ngPlusCount,
      gameMode,
    });
    results.push({
      seed,
      ms,
      actual: summarize(actual),
      expected: summarize(expected),
    });
  }
  const abandoned = api.generateFullPixelWorld(45, 0, "normal").catch(error => error);
  const latest = await api.generateFullPixelWorld(46, 0, "normal");
  const superseded = (await abandoned)?.superseded === true;
  const latestReference = await api.generateTerrainWorld({ seed: 46 });
  const latestMatches = JSON.stringify(summarize(latest)) === JSON.stringify(summarize(latestReference));
  api.setGLTerrain(true);
  const map = await api.generateDynamicMap({ seed: 16981, parallelWorlds: [0] });
  parentPort.postMessage({
    results,
    backgrounds: [...backgrounds],
    superseded, latestMatches,
    host: {
      layers: map.tileLayers.length,
      pois: Object.values(map.poisByPW).flat().length,
      scenes: Object.values(map.pixelScenesByPW).flat().length,
      biome: hash(new Uint8Array(map.biomeData.pixels.buffer)),
      elevator: map.elevatorShafts.length,
    },
  });
} catch (error) {
  parentPort.postMessage({ error: error.stack });
} finally {
  env.close();
}
