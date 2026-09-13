import {parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {createNativeGLES} from '../../build_scripts/native-gles.mjs';
import {installNativeTerrainEnvironment} from '../../build_scripts/native-terrain-environment.mjs';
let gpu,env,result;
try {
 gpu=createNativeGLES();
 env=installNativeTerrainEnvironment({...workerData,fullPixels:true});
 const create=document.createElement.bind(document);
 document.createElement=name=>name==='canvas'?gpu.createCanvas():create(name);
 const api=await import(pathToFileURL(workerData.entry).href);
 const samples=await api.verifyGpuMaterials();
 result={samples,renderer:gpu.info};
} catch(e) { result={error:e.stack}; }
finally {gpu?.dispose();env?.close();}
parentPort.postMessage(result);
parentPort.close();
