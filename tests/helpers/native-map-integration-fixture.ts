import { generateDynamicMap, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
import { setFullPixelTerrainForBake } from '../../src/renderer_settings';
import { prepareTerrainPlane } from '../../src/telescope/terrain-planes';
import { createCpuTerrain } from '../../src/telescope/cpu-terrain-core';
import { prepareTerrainSceneData } from '../../src/telescope/telescope-osd-bridge';
const hash=async(bytes:Uint8Array|Uint8ClampedArray)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');
function normalized(value:any):any{
 if(value===null||typeof value!=='object')return value;
 if(value instanceof Set)return [...value];
 if(ArrayBuffer.isView(value))return Array.from(value as any);
 if(Array.isArray(value))return value.map(normalized);
 return Object.fromEntries(Object.keys(value).sort().filter(k=>!['canvas','imgElement','id','uuid','debugRngInfo'].includes(k)).map(k=>[k,normalized(value[k])]));
}
export async function run(){
 setFullPixelTerrainForBake(true);const cases=[];
 try{
  for(const options of [{seed:1103},{seed:11033,parallelWorlds:[0],unlocks:[]}]){
   let terrain:any;const gen=await generateDynamicMap({...options,onTerrainReady(value){if(terrain)throw Error('Repeated terrain callback');terrain=value;}}),sceneData=await prepareTerrainSceneData(gen),pixels=[];
   if(!terrain||terrain.tileLayers!==gen.tileLayers||terrain.biomeData!==gen.biomeData)throw Error('Early terrain identity changed');
   // Same map rendering code, actual scene inputs, all three vertical planes.
   for(const plane of [-1,0,1] as const){
    const data=await prepareTerrainPlane(gen,plane),terrain=await createCpuTerrain({...data,sceneData});
    for(const pw of gen.parallelWorlds){
     const x=(plane===0?-512:-4032)+pw*gen.worldSize*512,y=plane*24576+(plane===0?512:64),out=new Uint8ClampedArray(512*512*4);
     if(terrain.contains(x,y,512,512)){terrain.prefillMaterials(x,y,512,512);terrain.renderRows(x,y,512,0,512,out);terrain.finish(out,x,y,512,512);}
     pixels.push({plane,pw,x,y,bytes:out.byteLength,hash:await hash(out)});
    }
   }
   cases.push({options,metadata:await hash(new TextEncoder().encode(JSON.stringify(normalized({biome:gen.biomeData,pois:gen.poisByPW,scenes:gen.pixelScenesByPW,eyes:gen.eyes})))),counts:Object.fromEntries(Object.entries(gen.poisByPW).map(([k,v])=>[k,v.length])),pixels});
  }
  return{cases};
 }finally{releaseParallelWorlds();}
}
