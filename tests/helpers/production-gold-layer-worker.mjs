import {parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {installNativeTerrainEnvironment} from '../../build_scripts/native-terrain-environment.mjs';
const env=installNativeTerrainEnvironment({...workerData,fullPixels:true,workerScript:new URL('../../build_scripts/native-terrain-worker.mjs',import.meta.url)});
let result;
try { const f=await import(pathToFileURL(resolve(workerData.bundle,'fixture.js')).href);result=await f.verifyProductionGoldLayer(workerData.seed,workerData.camera);await env.waitImages(); }
catch(error){result={error:error.stack};}
finally{env.close();}
parentPort.postMessage(result);parentPort.close();
