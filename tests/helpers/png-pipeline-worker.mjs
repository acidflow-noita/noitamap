import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { Canvas } from '@napi-rs/canvas';
import { installNativeTerrainEnvironment } from '../../build_scripts/native-terrain-environment.mjs';
const environment = installNativeTerrainEnvironment({ ...workerData, fullPixels: true,
  workerScript: new URL('../../build_scripts/native-terrain-worker.mjs',import.meta.url) });
Canvas.prototype.convertToBlob = async function() { return new Blob([new Uint8Array(await this.encode('png'))], { type:'image/png' }); };
globalThis.__warmSceneStore = new Map();
globalThis.__hashMasks = masks => { const h=createHash('sha256'); for(const m of masks){h.update(JSON.stringify([m.x,m.y,m.width,m.height]));h.update(m.bits);if(m.airBits)h.update(m.airBits);}return h.digest('hex'); };
globalThis.__generationHash = result => createHash('sha256').update(JSON.stringify(result,(key,value)=>{
  if(key==='canvas'||key==='imgElement')return undefined;
  if(ArrayBuffer.isView(value))return {type:value.constructor.name,bytes:value.byteLength,hash:createHash('sha256').update(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)).digest('hex')};
  if(value instanceof Set)return [...value];return value;
})).digest('hex');
const makeBitmap = globalThis.createImageBitmap;
globalThis.createImageBitmap = async (...args) => { const image = await makeBitmap(...args); image.close = () => { image.width = image.height = 0; }; return image; };
globalThis.__hashSceneImages = images => { const hash = createHash('sha256'); for (const key of [...images.keys()].sort()) { const image = images.get(key); hash.update(JSON.stringify([key,image.width,image.height])); hash.update(image.getContext('2d').getImageData(0,0,image.width,image.height).data); } return hash.digest('hex'); }; 
globalThis.OpenSeadragon = { TileSource:class {}, Point:class {constructor(x,y){this.x=x;this.y=y;}},
  Rect:class {constructor(x,y,width,height){Object.assign(this,{x,y,width,height});}} };
try {
  const api=await import(pathToFileURL(workerData.bundle+'/fixture.js'));
  const result=await api.run();
  await environment.waitImages();
  parentPort.postMessage({...result,diagnostics:environment.diagnostics});
} catch(error){parentPort.postMessage({error:error.stack});}
finally{environment.close();parentPort.close();}
