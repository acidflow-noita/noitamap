import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createNativeGLES } from '../../build_scripts/native-gles.mjs';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';

let graphics,environment;
try {
  graphics=createNativeGLES({softwareOnly:true});
  environment=installNativeTerrainEnvironment({...workerData,fullPixels:true,
    workerScript:new URL('../../build_scripts/native-terrain-worker.mjs',import.meta.url)});
  const create=document.createElement.bind(document);
  document.createElement=tag=>tag==='canvas'?graphics.createCanvas():create(tag);
  globalThis.OpenSeadragon={TileSource:class{},Point:class{constructor(x,y){this.x=x;this.y=y;}},Rect:class{}};
  globalThis.__terrainPanScreen=workerData.screen;
  const fixture=await import(pathToFileURL(workerData.bundle+'/fixture.js'));
  const result=await fixture.run();await environment.waitImages();
  parentPort.postMessage({...result,graphics:graphics.info,diagnostics:environment.diagnostics});
}catch(error){parentPort.postMessage({error:error.stack});}
finally{graphics?.dispose();environment?.close();parentPort.close();}
