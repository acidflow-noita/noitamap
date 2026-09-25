import { installTelescopeShim } from "../src/telescope/telescope-dom-shim";
import {
  installFetchInterceptor,
  installImageSrcInterceptor,
} from "../src/telescope/telescope-data-bridge";
import { getDataZip } from "../src/data-archive";
import { loadTelescopeModules } from "../src/telescope/load-telescope";
import { snapshotWorkerScenes } from "../src/telescope/worker-scenes";
import { encodeScenePack, decodeScenePack } from "../src/telescope/scene-pack";

export async function bakeScenePack(fullPixels: boolean, provenance: string) {
  installTelescopeShim({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
  });
  if (!(await getDataZip()))
    throw new Error("Cannot prepare scenes without data.zip");
  installFetchInterceptor(fullPixels);
  installImageSrcInterceptor();
  const modules = await loadTelescopeModules(fullPixels);
  modules.settingsMod.updateSettings({
    clearSpawnPixels: true,
    recolorMaterials: true,
    enableEdgeNoise: true,
    fixHolyMountainEdgeNoise: true,
    enableStaticPixelScenes: "all",
    skipCosmeticScenes: false,
    excludeTaikasauva: false,
    excludeEdgeCases: false,
    showEnemies: true,
  });
  for (const cfg of Object.values(
    modules.genConfigMod.GENERATOR_CONFIG,
  ) as any[])
    cfg.enabled = true;
  await modules.pixelSceneMod.loadPixelSceneData();
  await modules.pixelSceneMod.initPixelSceneTextures?.();
  const snapshot = snapshotWorkerScenes(modules.pixelSceneMod, fullPixels);
  const bytes = encodeScenePack(snapshot, provenance),
    decoded = decodeScenePack(bytes.buffer as ArrayBuffer, provenance);
  let sourceBytes = 0;
  const buffers = new Set<ArrayBufferLike>();
  function compare(original: any, restored: any, path: string) {
    if (
      original instanceof Uint8Array ||
      original instanceof Uint8ClampedArray
    ) {
      sourceBytes += original.byteLength;
      if (
        original.constructor !== restored?.constructor ||
        original.length !== restored.length ||
        original.some((byte, i) => byte !== restored[i])
      )
        throw new Error(`Prepared scene pixels differ: ${path}`);
      buffers.add(restored.buffer);
    } else if (original && typeof original === "object") {
      const keys = Object.keys(original).filter(
        (key) => original[key] !== undefined,
      );
      if (keys.length !== Object.keys(restored ?? {}).length)
        throw new Error(`Prepared scene metadata differs: ${path}`);
      for (const key of keys)
        compare(original[key], restored[key], `${path}.${key}`);
    } else if (original !== restored)
      throw new Error(`Prepared scene value differs: ${path}`);
  }
  compare(snapshot, decoded, "scenes");
  return {
    bytes,
    scenes: Object.keys(snapshot.data).length,
    sourceBytes,
    restoredBytes: [...buffers].reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    ),
  };
}
