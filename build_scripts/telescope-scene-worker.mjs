import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { installNativeTerrainEnvironment } from "./native-terrain-environment.mjs";
const env = installNativeTerrainEnvironment({
  ...workerData,
  workerScript: new URL("./native-terrain-worker.mjs", import.meta.url),
});
let result;
try {
  const { bakeScenePack } = await import(
    pathToFileURL(resolve(workerData.bundle, "scenes.js")).href
  );
  result = await bakeScenePack(workerData.fullPixels, workerData.provenance);
  await env.waitImages();
} catch (error) {
  result = { error: error.stack };
} finally {
  env.close();
}
parentPort.postMessage(result, result.bytes ? [result.bytes.buffer] : []);
parentPort.close();
