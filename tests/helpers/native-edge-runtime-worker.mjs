import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";
const environment = installNativeTerrainEnvironment({
  ...workerData,
  fullPixels: true,
  workerScript: new URL(
    "../../build_scripts/native-terrain-worker.mjs",
    import.meta.url,
  ),
});
let rejected = 0;
if (workerData.failModule) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, ...args) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/\/core(?:-[^/]+)?\.wasm(?:[?#]|$)/.test(url)) {
      rejected++;
      throw new Error("Fixture deliberately refused the edge WASM asset");
    }
    return originalFetch(input, ...args);
  };
}
let result;
try {
  const api = await import(pathToFileURL(workerData.entry).href);
  result = {
    ...(await api.verifyNativeEdges(!!workerData.failModule)),
    rejected,
    diagnostics: environment.diagnostics,
  };
} catch (error) {
  result = { error: error.stack };
} finally {
  environment.close();
}
parentPort.postMessage(result);
parentPort.close();
