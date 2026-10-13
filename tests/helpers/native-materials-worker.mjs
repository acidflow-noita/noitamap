import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";

const environment = installNativeTerrainEnvironment({
  ...workerData,
  fullPixels: true,
  workerScript: new URL(import.meta.url),
});
try {
  if (workerData.failNative) {
    const localFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/owned-materials[^/]*\.wasm(?:[?#]|$)/.test(url))
        throw new Error(
          "Fixture deliberately refused the owned material WASM asset",
        );
      return localFetch(input, ...args);
    };
  }
  const api = await import(pathToFileURL(workerData.entry).href);
  const result = await api.verifyNativeMaterials(!!workerData.failNative);
  await environment.waitImages();
  environment.restoreProcess();
  parentPort.postMessage({
    ...result,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model,
    },
    diagnostics: environment.diagnostics,
  });
} catch (error) {
  parentPort.postMessage({ error: error.stack });
} finally {
  environment.close();
  parentPort.close();
}
