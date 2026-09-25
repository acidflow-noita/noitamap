import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeGLES } from '../../build_scripts/native-gles.mjs';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';

let graphics, environment, result;
try {
  graphics = createNativeGLES();
  environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true,
    workerScript: new URL('../../build_scripts/native-terrain-worker.mjs', import.meta.url) });
  const create = document.createElement.bind(document);
  document.createElement = tag => tag === 'canvas' ? graphics.createCanvas() : create(tag);
  const fixture = await import(pathToFileURL(resolve(workerData.bundle, 'fixture.js')).href);
  const data = await fixture.verifyInstantTerrainRuntime({ draws: () => graphics.draws });
  await environment.waitImages();
  result = { ...data, graphics: graphics.info, diagnostics: environment.diagnostics };
} catch (error) {
  result = { error: error.stack };
} finally {
  graphics?.dispose(); environment?.close();
}
parentPort.postMessage(result);
parentPort.close();
