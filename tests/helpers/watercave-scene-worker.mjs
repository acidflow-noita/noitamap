import { writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { Canvas } from '@napi-rs/canvas';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';
const environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: workerData.fullPixels ?? true,
  workerScript: new URL('../../build_scripts/native-terrain-worker.mjs',import.meta.url) });
Canvas.prototype.convertToBlob = async function() { return new Blob([new Uint8Array(await this.encode('png'))], { type:'image/png' }); };
globalThis.__warmSceneStore = new Map();
globalThis.__watercaveFullPixels = workerData.fullPixels;
if(workerData.previewPath)globalThis.__watercavePreview = bitmap => writeFileSync(workerData.previewPath,bitmap.toBuffer('image/png'));
const makeBitmap = globalThis.createImageBitmap;
globalThis.createImageBitmap = async (...args) => { const image = await makeBitmap(...args); image.close = () => { image.width = image.height = 0; }; return image; };
globalThis.OpenSeadragon = { TileSource:class {}, Point:class {constructor(x,y){this.x=x;this.y=y;}},
  Rect:class {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}} };
try {
  const api=await import(pathToFileURL(workerData.bundle+'/fixture.js'));
  const result=await api.run();
  await environment.waitImages();
  parentPort.postMessage({...result,diagnostics:environment.diagnostics});
} catch(error){parentPort.postMessage({error:error.stack});}
finally{environment.close();parentPort.close();}
