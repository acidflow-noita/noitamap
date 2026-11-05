import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createNativeGLES } from "../../build_scripts/native-gles.mjs";
import { installNativeTerrainEnvironment } from "../../build_scripts/native-terrain-environment.mjs";
let gpu, environment, result;
try {
  gpu = createNativeGLES({ softwareOnly: true });
  environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true });
  const create = document.createElement.bind(document);
  document.createElement = name => name === "canvas" ? gpu.createCanvas() : create(name);
  const api = await import(pathToFileURL(workerData.entry).href);
  result = { samples: [await api.verifyMasks(), await api.verifyMasks(2100611341)], renderer: gpu.info };
} catch (error) { result = { error: error.stack }; }
finally { gpu?.dispose(); environment?.close(); }
parentPort.postMessage(result);
parentPort.close();
