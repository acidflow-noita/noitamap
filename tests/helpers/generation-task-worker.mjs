import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';

const environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true,
  workerScript: new URL('../../build_scripts/native-terrain-worker.mjs', import.meta.url) });
const hash = data => createHash('sha256').update(data).digest('hex');
globalThis.__generationSnapshot = result => ({
  seed: result.seed,
  pois: Object.values(result.poisByPW).reduce((sum, list) => sum + list.length, 0),
  scenes: Object.values(result.pixelScenesByPW).reduce((sum, list) => sum + list.length, 0),
  hash: hash(JSON.stringify(result, (key, value) => {
    if (key === 'canvas' || key === 'imgElement') return undefined;
    if (ArrayBuffer.isView(value)) return { type: value.constructor.name,
      bytes: value.byteLength, hash: hash(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (value instanceof ArrayBuffer) return { bytes: value.byteLength, hash: hash(new Uint8Array(value)) };
    if (value instanceof Set) return [...value];
    return value;
  })),
});
try {
  const api = await import(pathToFileURL(workerData.bundle + '/fixture.js'));
  const result = await api.run(workerData.concurrent);
  await environment.waitImages();
  parentPort.postMessage({ ...result, diagnostics: environment.diagnostics });
} catch (error) { parentPort.postMessage({ error: error.stack }); }
finally { environment.close(); parentPort.close(); }
