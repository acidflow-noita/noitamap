import Flatbush from 'flatbush';
import { createSharedInputs, type SharedInputOptions } from './shared-inputs';
import { GENERATOR_CONFIG } from '../../rules/generator_config.js';
import { BIOME_ENGINE,MATERIAL_NAMES_BY_ID,WANG_COLOR_TO_ID } from '../../complete-materials/engine-data.mjs';
import { prepareWorldMaterialInputs,fillMaterialsByBiome,type VerticalPlane } from '../../cook-inputs';
import { createCurrentMapScenePolicy } from '../../complete-world';
import { createNativeScenePreparer,createSeamPolicy,type NativeScenePlacement,type NativeSceneSource,type PreparedNativeScene,type StaticMask } from '../../composition';
import { createPlaneOwnership,createBackgroundOwnership,sceneBiomeNames,BIOME_BACKGROUND_MAP } from '../../composition/world-policy';
import { findLiquidSurfaces } from '../../composition/liquid-inputs';
import { validateCaveStateBinding,type CaveStateBinding } from '../../game-state';
import {createLegacyColorResolver} from '../../cook-inputs/legacy';
import {createStaticMaskSourceCache,blitStaticMaskOr} from './static-mask-inputs';
import type {WorldRequest} from '../../world';

const cfg:any=GENERATOR_CONFIG;
const PAGE=512,HALO=32,REGION_HEIGHT=24576,ROWS=48;
export interface WorldPage {
  id:number;horizontal:number;vertical:VerticalPlane;column:number;row:number;
  x:number;y:number;width:512;height:512;gridColumn:number;gridRow:number;
}
interface SceneRecord {
  order:number;placement:NativeScenePlacement;layers:{mid:boolean;visual:boolean;background:boolean};
  right:number;bottom:number;airBackgroundIndex:number;
}
interface MaskRecord {placement:NativeScenePlacement}
export interface RuntimeScene {order:number;placement:NativeScenePlacement;source:NativeSceneSource;prepared:PreparedNativeScene;airBackgroundIndex:number}
export type ExactRun=(x:number,y:number,width:number)=>{materials:ArrayLike<number>;classifications?:Uint8Array|Uint32Array}|Promise<{materials:ArrayLike<number>;classifications?:Uint8Array|Uint32Array}>;
export interface WorldInputPreparationOptions {
  generationState?:CaveStateBinding;preparedSceneBytes?:number;
  unlocks?:WorldRequest['unlocks'];dailySeed?:boolean;calendar?:WorldRequest['calendar'];signal?:AbortSignal;
}

function rectangleIndex(records:readonly any[],bounds:(value:any)=>number[]){
  if(!records.length)return null;const index=new Flatbush(records.length);
  for(const value of records){const b=bounds(value);index.add(b[0],b[1],b[2],b[3]);}
  index.finish();return index;
}
function preparedBytes(value:RuntimeScene){
  const s=value.prepared;return s.pixels.byteLength+(s.eraseMask?.byteLength??0)+s.sourceAlpha.byteLength+s.edge.grid.byteLength+(s.edge.artMask?.byteLength??0);
}

/** Explicit all-nine input boundary. It never rasterizes terrain or eagerly
 * prepares every scene. A page closes only after its actual output is known. */
export async function createWorldInputFactory(options:SharedInputOptions){
  const shared=await createSharedInputs(options);
  const staticMaskSources=createStaticMaskSourceCache();
  let disposed=false;
  const {generator,atlas,loader,bands,edgeResources,backgroundTextures,backgroundByName,backgroundShape,sceneColors,liquidIDs}=shared;
  const fills:Record<number,string>={};for(const c of Object.values(cfg) as any[])if(c.fillMaterial)fills[c.color&0xffffff]=c.fillMaterial;
  const prepareScene=createNativeScenePreparer({atlas,generatorConfig:cfg,engineBiomes:BIOME_ENGINE,
    materialNames:MATERIAL_NAMES_BY_ID,wangMaterialIds:WANG_COLOR_TO_ID as [number,number][],fillBiomeMaterials:fills,
    fillLayerMaterials:Object.fromEntries(fillMaterialsByBiome(cfg)),biomeBackgroundColors:sceneColors.biomeBackgroundColors,
    biomeForegroundColors:sceneColors.biomeForegroundColors,bands});
  return {
    initialization:shared.initialization,
    async prepare(seed:number,{generationState,preparedSceneBytes=64*1024*1024,unlocks,dailySeed,calendar,signal}:WorldInputPreparationOptions={}){
      if(disposed)throw new Error('World input factory disposed');signal?.throwIfAborted();
      if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new RangeError('Invalid world seed');
      if(!Number.isSafeInteger(preparedSceneBytes)||preparedSceneBytes<0)throw new RangeError('Invalid scene budget');
      const imported=generationState?validateCaveStateBinding(generationState,{seed,ngPlus:0,gameMode:'normal',assetsRevision:options.assets.revision}):undefined;
      const binding=imported?Object.freeze({state:imported,expected:imported.context}):undefined;
      const started=performance.now(),stages:Record<string,number>={};
      const world=await generator.generate({seed,ngPlus:0,gameMode:'normal',unlocks:unlocks?.slice()??unlocks,dailySeed,
        parallelWorlds:[-1,0,1],calendar:calendar?{...calendar}:undefined},signal);
      signal?.throwIfAborted();if(disposed)throw new Error('World input factory disposed');
      stages.worldDecisionsMs=performance.now()-started;
      if(world.worldSize!==70||world.regions.length!==9)throw new Error('All-nine inputs require normal complete geometry');
      let at=performance.now();const materials=prepareWorldMaterialInputs(world,{generatorConfig:cfg,emptyTopology0:'legacy-fill'});
      stages.materialInputAssemblyMs=performance.now()-at;
      const materialInputs=new Map(([-1,0,1] as const).map(v=>[v,{...materials.forPlane(v),...(binding?{generationState:binding}:{})}]));
      at=performance.now();
      const planes=new Map<VerticalPlane,any>();
      for(const vertical of [-1,0,1] as const){
        const pixels=materialInputs.get(vertical)!.biomePixels;
        if(!(pixels instanceof Uint32Array))throw new Error('A complete typed biome map is required');
        const ownership=createPlaneOwnership(world.tileLayers,materials.sourceBiomePixels,pixels,cfg,70);
        if(vertical===1&&world.elevatorShafts?.length){
          let id=ownership.names.indexOf('robobase');if(id<0){id=ownership.names.length;ownership.names.push('robobase');}
          for(const shaft of world.elevatorShafts){
            if(shaft.biomeName!=='robobase'||!shaft.buffer||!Number.isInteger(shaft.minX)||shaft.minX<0||shaft.minX>=70)throw new Error('Invalid shaft ownership');
            for(let row=0;row<ROWS;row++)ownership.owners[row*70+shaft.minX]=id;
          }
        }
        const backgroundOwnership=createBackgroundOwnership(ownership,pixels,cfg,vertical),offsetY=vertical*REGION_HEIGHT;
        const liquidSurfaces=findLiquidSurfaces(materialInputs.get(vertical)!.lattice,liquidIDs,70,offsetY);
        const liquidIndex=rectangleIndex(liquidSurfaces,s=>[s.left,Math.min(s.y,s.sourceY??s.y)-6,s.right,Math.max(s.y,s.sourceY??s.y)+6]);
        planes.set(vertical,{ownership,backgroundOwnership,offsetY,chunkShiftX:0,chunkShiftY:0,
          liquidSurfaces,liquidIndex,skipSeamAt:createSeamPolicy(pixels,70),ownsTerrain:(x:number,y:number)=>ownership.at(x,y-offsetY)>=0});
      }
      stages.planePolicyMs=performance.now()-at;
      at=performance.now();
      const policy=createCurrentMapScenePolicy({capturedGold:'static-capture',mapWidth:70});
      const raw:Array<{order:number;placement:NativeScenePlacement;action:string}>=[];
      let order=0;const backgroundKeys=new Set<string>();
      for(const region of world.regions)for(const scene of region.scenes){
        const ownOrder=order++,action=policy.classify(scene,region);if(action==='skip')continue;
        const placement:NativeScenePlacement={key:scene.key,name:scene.name,variantKey:scene.variantKey,x:scene.x,y:scene.y,width:scene.width,height:scene.height};
        if(![placement.x,placement.y,placement.width,placement.height].every(Number.isSafeInteger)||placement.width<1||placement.height<1)throw new Error('Invalid scene placement');
        raw.push({order:ownOrder,placement,action});if(action==='render')backgroundKeys.add(scene.key);
      }
      const extents=new Map<string,{width:number;height:number}>();
      await Promise.all([...backgroundKeys].map(async key=>{
        const definition=loader.definitions.get(key);if(!definition)throw new Error(`Missing scene definition ${key}`);
        extents.set(key,await backgroundShape(definition.backgroundPath));
      }));
      signal?.throwIfAborted();if(disposed)throw new Error('World input factory disposed');
      const sceneRecords:SceneRecord[]=[],maskRecords:MaskRecord[]=[],maskKeys=new Set<string>();
      for(const record of raw){
        const p=record.placement;
        if(record.action==='static-mask'){
          const key=`${p.key}/${p.x}/${p.y}`;if(maskKeys.has(key)||p.width<2||p.height<2)continue;maskKeys.add(key);maskRecords.push({placement:p});
        }else{
          const layers=policy.layers(p),extent=extents.get(p.key)!;
          const bg=sceneBiomeNames(p).find(name=>BIOME_BACKGROUND_MAP[name]);
          sceneRecords.push({order:record.order,placement:p,layers,right:p.x+Math.max(p.width,layers.background?extent.width:0),
            bottom:p.y+Math.max(p.height,layers.background?extent.height:0),airBackgroundIndex:bg?backgroundByName.get(bg)??0:0});
        }
      }
      const sceneIndex=rectangleIndex(sceneRecords,s=>[s.placement.x,s.placement.y,s.right,s.bottom]);
      const maskIndex=rectangleIndex(maskRecords,m=>[m.placement.x,m.placement.y,m.placement.x+m.placement.width,m.placement.y+m.placement.height]);
      stages.sceneMetadataMs=performance.now()-at;
      const pages:WorldPage[]=[];
      for(const vertical of [-1,0,1] as const)for(const horizontal of [-1,0,1])for(let row=0;row<ROWS;row++)for(let column=0;column<70;column++)
        pages.push({id:pages.length,horizontal,vertical,column,row,x:horizontal*35840+column*PAGE-17920,y:vertical*REGION_HEIGHT+row*PAGE-7168,
          width:PAGE,height:PAGE,gridColumn:(horizontal+1)*70+column,gridRow:(vertical+1)*48+row});
      let closed=false,cacheBytes=0;const sceneCache=new Map<number,RuntimeScene>(),pending=new Map<number,Promise<RuntimeScene>>();
      const maskCache=new Map<string,Promise<{bits:Uint8Array;airBits:Uint8Array}>>(),zeroSources=new Map<string,Uint8Array>();
      const stats={sourceReadMs:0,scenePrepareMs:0,sceneCacheHits:0,sceneCacheMisses:0,sceneCachePeakBytes:0,sceneInstructionPixels:0,maskReadMs:0,maskCount:0};
      const check=()=>{signal?.throwIfAborted();if(closed||disposed)throw new Error('World inputs disposed');};
      function pagePolicy(page:WorldPage){
        check();if(pages[page.id]!==page)throw new Error('Foreign world page');
        const plane=planes.get(page.vertical)!,cell=page.row*70+page.column,bg=plane.backgroundOwnership.owners[cell];
        const backgroundIndex=bg<0?0:backgroundByName.get(plane.backgroundOwnership.names[bg])??0;
        const nearbySceneIDs=(sceneIndex?.search(page.x-HALO,page.y-HALO,page.x+PAGE+HALO,page.y+PAGE+HALO)??[]).sort((a,b)=>a-b);
        const maskIDs=maskIndex?.search(page.x,page.y,page.x+PAGE,page.y+PAGE)??[];
        const ownsTerrain=plane.ownership.owners[cell]>=0;
        const hasSceneInCore=nearbySceneIDs.some(id=>{const r=sceneRecords[id];return r.placement.x<page.x+PAGE&&r.right>page.x&&r.placement.y<page.y+PAGE&&r.bottom>page.y;});
        // No terrain and no intersecting scene leaves canPaint zero everywhere;
        // nearby edge-only scenes cannot paint the core or change its background.
        const kind=ownsTerrain||hasSceneInCore?'procedural':backgroundIndex?'background-only':'zero';
        const sceneIDs=kind==='procedural'?nearbySceneIDs:[];
        return {page,kind,ownsTerrain,backgroundIndex,backgroundPhase:{x:17920,y:7168-plane.offsetY},sceneIDs,maskIDs,
          chunkShiftX:plane.chunkShiftX,chunkShiftY:plane.chunkShiftY,skipSeamAt:plane.skipSeamAt};
      }
      async function sceneSource(id:number){
        check();const record=sceneRecords[id];if(!record)throw new RangeError('Unknown scene');
        const t=performance.now(),raw=await loader.load(record.placement);check();stats.sourceReadMs+=performance.now()-t;
        if(raw.width!==record.placement.width||raw.height!==record.placement.height)throw new Error(`Scene dimensions changed: ${record.placement.key}`);
        let data=raw.data;if(!record.layers.mid){data=zeroSources.get(record.placement.key)!;if(!data){data=new Uint8Array(raw.data.length);zeroSources.set(record.placement.key,data);}}
        return {record,source:{...raw,data,visualArt:record.layers.visual?raw.visualArt:null,backgroundArt:record.layers.background?raw.backgroundArt:null} as NativeSceneSource};
      }
      async function scene(id:number):Promise<RuntimeScene>{
        check();const cached=sceneCache.get(id);if(cached){sceneCache.delete(id);sceneCache.set(id,cached);stats.sceneCacheHits++;return cached;}
        let task=pending.get(id);if(task)return task;
        task=(async()=>{
          stats.sceneCacheMisses++;const {record,source}=await sceneSource(id),t=performance.now();
          const prepared=prepareScene(record.placement,source);stats.scenePrepareMs+=performance.now()-t;stats.sceneInstructionPixels+=source.width*source.height;
          const result={order:record.order,placement:record.placement,source,prepared,airBackgroundIndex:record.airBackgroundIndex},size=preparedBytes(result);
          if(size<=preparedSceneBytes){while(cacheBytes+size>preparedSceneBytes&&sceneCache.size){const key=sceneCache.keys().next().value!;cacheBytes-=preparedBytes(sceneCache.get(key)!);sceneCache.delete(key);}sceneCache.set(id,result);cacheBytes+=size;stats.sceneCachePeakBytes=Math.max(stats.sceneCachePeakBytes,cacheBytes);}
          return result;
        })();pending.set(id,task);try{return await task;}finally{pending.delete(id);}
      }
      async function mask(id:number):Promise<StaticMask>{
        check();const record=maskRecords[id];if(!record)throw new RangeError('Unknown mask');const p=record.placement;
        let task=maskCache.get(p.key);if(!task){task=(async()=>{const t=performance.now();
          const source=await staticMaskSources.get(`${options.assets.revision}/${p.key}`,p.width,p.height,()=>loader.load(p));check();stats.maskReadMs+=performance.now()-t;stats.maskCount++;
          return source;})();maskCache.set(p.key,task);}
        return {x:p.x,y:p.y,width:p.width,height:p.height,...await task};
      }
      const policies=pages.map(pagePolicy);
      const counts={pages:pages.length,zero:0,backgroundOnly:0,procedural:0,owned:0,scenes:sceneRecords.length,masks:maskRecords.length,
        uniqueSceneSources:new Set(sceneRecords.map(s=>s.placement.key)).size,sceneInstructionPixels:sceneRecords.reduce((n,s)=>n+s.placement.width*s.placement.height,0)};
      for(const p of policies){if(p.kind==='zero')counts.zero++;else if(p.kind==='background-only')counts.backgroundOnly++;else counts.procedural++;if(p.ownsTerrain)counts.owned++;}
      stages.totalPreparationMs=performance.now()-started;
      return {seed,world,materials,materialInputs,planes,pages,policies,sceneRecords,maskRecords,pagePolicy,sceneSource,scene,mask,counts,stats,stages,
        generationStateDigest:imported?.digest??null,scope:'all-nine-current-terrain-scenes-layer' as const,
        atlas,edgeResources,backgroundTextures,sceneBandResolver:bands,
        legacyForPlane(vertical:VerticalPlane){return createLegacyColorResolver(world,materials,vertical,cfg,atlas,shared.legacyPolicy);},
        sceneResources:{atlas,generatorConfig:cfg,engineBiomes:BIOME_ENGINE,materialNames:MATERIAL_NAMES_BY_ID,
          wangMaterialIds:WANG_COLOR_TO_ID as [number,number][],fillBiomeMaterials:fills,
          fillLayerMaterials:Object.fromEntries(fillMaterialsByBiome(cfg)),
          biomeBackgroundColors:sceneColors.biomeBackgroundColors,biomeForegroundColors:sceneColors.biomeForegroundColors},
        grid:{columns:210,rows:144,x:-53760,y:-31744,pageSize:512},
        memory:{sharedRetainedBytes:shared.sharedRetainedBytes,latticeBytes:materials.lattice.cov.byteLength+materials.lattice.mat.byteLength,
          get preparedSceneBytes(){return cacheBytes;},get sourceSceneBytes(){return loader.cacheBytes;},get staticMaskBytes(){return staticMaskSources.residentBytes;}},
        get maskSourceCache(){return {...staticMaskSources.stats,residentBytes:staticMaskSources.residentBytes,entries:staticMaskSources.entries};},
        async pageInputs(page:WorldPage,exactRun?:ExactRun,{prepareScenes=true}:{prepareScenes?:boolean}={}){
          const policy=policies[page.id];if(!policy||pages[page.id]!==page)throw new Error('Foreign world page');check();
          const ordinaryMask=new Uint8Array(PAGE*PAGE/8),airMask=new Uint8Array(ordinaryMask.length);
          if(policy.kind!=='zero')for(const id of policy.maskIDs)blitStaticMaskOr({...page,ordinaryMask,airMask},await mask(id));
          const plane=planes.get(page.vertical)!,liquidPasses:any[]=[];
          if(policy.ownsTerrain){const offset=page.horizontal*35840;
            for(const id of plane.liquidIndex?.search(page.x-offset,page.y,page.x+PAGE-offset,page.y+PAGE)??[]){
              const s=plane.liquidSurfaces[id],left=s.left+offset,right=s.right+offset,top=Math.min(s.y,s.sourceY??s.y)-6,bottom=Math.max(s.y,s.sourceY??s.y)+6;
              const x0=Math.max(left,page.x),x1=Math.min(right,page.x+PAGE);if(x0>=x1||top>=page.y+PAGE||bottom<=page.y)continue;
              const bottomMaterials=new Int16Array(x1-x0).fill(-1);
              // The reference checks ownership before sampling a bottom cell.
              // An unowned cell must not force a missing material query.
              for(let x=x0;x<x1;){
                if(!plane.ownsTerrain(x,bottom)){x++;continue;}
                const start=x;while(x<x1&&plane.ownsTerrain(x,bottom))x++;
                if(!exactRun)throw new Error('Exact liquid-bottom input is required');const values=await exactRun(start,bottom,x-start);
                if(values.materials.length!==x-start||values.classifications?.some(v=>v>=8))throw new Error('Unresolved liquid bottom input');
                bottomMaterials.set(Int16Array.from(values.materials),start-x0);
              }
              liquidPasses.push({...s,left,right,top,bottom,x0,x1,bottomMaterials});
            }}
          const selected:RuntimeScene[]=[];if(prepareScenes)for(const id of policy.sceneIDs)selected.push(await scene(id));
          return {...policy,width:576,height:576,x:page.x-HALO,y:page.y-HALO,originalMaterials:null,ordinaryMask,airMask,liquidPasses,
            globalSceneIDs:policy.sceneIDs,sceneIDs:prepareScenes?selected.map((_,i)=>i):policy.sceneIDs,assets:{atlas,backgroundTextures,scenes:selected}};
        },
        dispose(){closed=true;sceneCache.clear();pending.clear();maskCache.clear();zeroSources.clear();cacheBytes=0;},
      };
    },
    dispose(){disposed=true;staticMaskSources.clear();shared.loader.clear();},
  };
}
