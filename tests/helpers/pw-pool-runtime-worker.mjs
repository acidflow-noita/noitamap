import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';

const environment = installNativeTerrainEnvironment({ ...workerData,
  workerScript: new URL('../../build_scripts/native-terrain-worker.mjs', import.meta.url) });
let result;
try {
  const fixture = await import(pathToFileURL(resolve(workerData.bundle, 'fixture.js')).href);
  result = await fixture.verifyPersistentPwPool(workerData.fullPixels,
    value => createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  await environment.waitImages();
  result.diagnostics = environment.diagnostics;
} catch (error) { result = { error: error.stack }; }
finally { environment.close(); }
parentPort.postMessage(result); parentPort.close();
