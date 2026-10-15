import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeWorldGenerator} from '../../src/native-map/world';
const root=resolve('lib/noita-telescope-vm/data');
let reads=0;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>{
 if(_key==='imgElement'||_key==='id'||_key==='uuid'||_key==='debugRngInfo')return undefined;
 if(ArrayBuffer.isView(item))return {bytes:item.byteLength,sha256:createHash('sha256').update(new Uint8Array(item.buffer,item.byteOffset,item.byteLength)).digest('hex')};
 if(item instanceof Set)return [...item];
 return item;
})).digest('hex');
const canonical=(regions:any[])=>regions.map(r=>({horizontal:r.horizontal,vertical:r.vertical,pois:r.pois,scenes:r.scenes.map(({imgElement,...s}:any)=>s)}));
if(workerData.role==='native'){
 for(const name of ['document','window','Image','OffscreenCanvas'])Object.defineProperty(globalThis,name,{get(){throw Error(`Forbidden global: ${name}`);}});
 globalThis.fetch=async()=>{throw Error('Implicit network request');};
 const start=performance.now();const gen=await createNativeWorldGenerator({revision:'test',async read(path){reads++;return new Uint8Array(await readFile(resolve(root,path.slice(5))));}});
 const preparationMs=performance.now()-start;
 for(const request of workerData.requests){
  const world=await gen.generate(request);const before=reads;
  parentPort!.postMessage({request,world,reads,preparationMs,hash:hash(canonical(world.regions))});
  // Reproduce the ownership boundary used by the real worker, then reseed.
  const buffers=new Set<ArrayBuffer>();
  const visit=(v:any)=>{if(ArrayBuffer.isView(v))buffers.add(v.buffer as ArrayBuffer);else if(v&&typeof v==='object')for(const child of Object.values(v))visit(child);};
  visit(world.biomeData);visit(world.tileLayers);visit(world.elevatorShafts);
  structuredClone([...buffers],{transfer:[...buffers]});
  if(reads!==before)throw Error('Unexpected generation input read');
 }
}else{
 (globalThis as any).document={getElementById:()=>({checked:false})};
 globalThis.fetch=async(input:any)=>{
  const path=typeof input==='string'?input:input.href;
  const filename=path.startsWith('file:')?new URL(path):resolve(root,path.replace(/^(?:\.\.\/|\.\/)*data\//,''));
  const b=await readFile(filename);return new Response(b,{headers:{'Content-Type':path.endsWith('.json')?'application/json':'application/octet-stream'}});
 };
 const base='../../lib/noita-telescope-vm/js/';
 const [scanner,scenes,statics,settings,unlocks,colors]=await Promise.all(['poi_scanner.js','pixel_scene_generation.js','static_spawns.js','settings.js','unlocks.js','image_processing.js'].map(f=>import(new URL(base+f,import.meta.url).href)));
 settings.updateSettings({clearSpawnPixels:true,recolorMaterials:true,enableEdgeNoise:true,fixHolyMountainEdgeNoise:true,enableStaticPixelScenes:'all',skipCosmeticScenes:false,excludeTaikasauva:false,excludeEdgeCases:false,showEnemies:true});
 await colors.initBiomeColors();await scenes.loadPixelSceneData();
 parentPort!.on('message',async({world,request})=>{
  settings.updateSettings({gameMode:world.gameMode});settings.appSettings.date=world.calendar;unlocks.setUnlocks(request.dailySeed||request.unlocks==null?Object.keys(unlocks.UNLOCKABLES):request.unlocks);
  scenes.clearPixelSceneBitmapCache();for(const s of Object.values(scenes.PIXEL_SCENE_DATA) as any[])s.variants={};
  const {seed,ngPlus,gameMode,biomeData,tileLayers,elevatorShafts}=world,width=biomeData.pixels.length/48;
  const columns=elevatorShafts.map((s:any)=>s.minX),spawn=scanner.prescanSpawnFunctions(tileLayers,ngPlus>0,gameMode),lower=spawn.filter((s:any)=>!(s.sourceBiome==='robobase'&&s.y>=33*512-10&&columns.includes(Math.floor((s.x+width*256)/512))));
  const shaft=scanner.prescanSpawnFunctions(elevatorShafts,ngPlus>0,gameMode).filter((s:any)=>s.y>=34*512&&s.y<82*512),regions=[];
  for(const horizontal of [-1,0,1])for(const vertical of [0,-1,1]){
   let special=vertical===0?[]:scanner.getSpecialPoIs(biomeData,seed,ngPlus,horizontal,vertical,{},gameMode);
   const scan=scanner.scanSpawnFunctions(biomeData,vertical===1?lower:spawn,seed,ngPlus,horizontal,vertical,false,{},gameMode);
   if(vertical===0)special=scanner.getSpecialPoIs(biomeData,seed,ngPlus,horizontal,vertical,{},gameMode);
   const pois=vertical===0?[...scan.generatedSpawns,...special]:[...special,...scan.generatedSpawns],result=[...scan.finalPixelScenes];
   if(vertical===1&&shaft.length){const s=scanner.scanSpawnFunctions(biomeData,shaft,seed,ngPlus,horizontal,0,false,{},gameMode);pois.push(...s.generatedSpawns);result.push(...s.finalPixelScenes);}
   const fixed=statics.addStaticPixelScenes(seed,ngPlus,horizontal,vertical,biomeData,false,{},request.dailySeed??false,gameMode);
   pois.push(...(fixed?.pois??[]));result.push(...(fixed?.pixelScenes??[]));
   regions.push({horizontal,vertical,pois,scenes:result});
  }
  parentPort!.postMessage({hash:hash(canonical(regions)),counts:regions.map(r=>[r.pois.length,r.scenes.length]),regions:canonical(regions)});
 });
 parentPort!.postMessage({ready:true});
}
