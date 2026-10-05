import { generateDynamicMap, releaseParallelWorlds } from '../../src/telescope/telescope-adapter';
import * as bridge from '../../src/telescope/telescope-osd-bridge';
import { createPlaneOwnership, WORLD_TOP, WORLD_HEIGHT } from '../../src/telescope/terrain-policy';
import { includeElevatorOwnership, prepareElevatorShafts } from '../../src/telescope/terrain-elevator';
import { SharedInstantTerrainResources } from '../../src/telescope/shared-instant-terrain';
import { createTerrainViewportCompositor, type TerrainViewportPlan } from '../../src/telescope/terrain-viewport-compositor';
import { createRetainedViewportRenderer } from '../../src/telescope/retained-viewport-renderer';
import { InstantTerrainCache } from '../../src/telescope/instant-terrain-cache';
import { GLTerrainRenderer } from 'noita-telescope-full-pixels/gl/terrain_renderer.js';
import { GENERATOR_CONFIG } from 'noita-telescope-full-pixels/generator_config.js';
import { createInstantClip } from '../../src/telescope/instant-terrain-clip';

export async function run() {
  window.location.search='?terrain=gpu';
  const gen=await generateDynamicMap({seed:74809133,parallelWorlds:[-1,0,1],unlocks:null});
  const masks=await (bridge as any).__panSceneMasks(gen),shafts=await prepareElevatorShafts(gen);
  const owners=[-1,0,1].map(plane=>includeElevatorOwnership(createPlaneOwnership(gen.tileLayers,gen.biomeData.pixels,
    plane<0?gen.biomeData.heavenPixels:plane>0?gen.biomeData.hellPixels:gen.biomeData.pixels,GENERATOR_CONFIG,70),shafts,plane as -1|0|1));
  const resources=new SharedInstantTerrainResources(new GLTerrainRenderer());
  await resources.ensureResources(gen.tileLayers,gen.biomeData,{seed:gen.seed,isNGP:false,gameMode:'normal',generatorConfig:GENERATOR_CONFIG,
    elevatorShafts:shafts,lut:{recolorMaterials:true,clearSpawnPixels:true}});
  const regions=[-1,0,1].flatMap(plane=>[-1,0,1].map(pw=>({
    region:{x:-17920+pw*35840,y:WORLD_TOP+plane*WORLD_HEIGHT,width:35840,height:WORLD_HEIGHT},
    retention:{hasCompleteView:()=>false,paintResidentView:()=>[],paintStoredView:async()=>false},
  })));
  const samples:any[]=[];
  const ownership=createInstantClip(owners,[]);
  const read=(image:any)=>image.getContext('2d').getImageData(0,0,image.width,image.height).data;
  try {
    for(const [cx,cy,scale] of [[-235,3581,3.073750362576023],[-2445,1522,.625],
      [198,-29083,1.25],[-160,20116,1.25],[-17920, -7168,2.125]]) {
      const lifetime=new AbortController();
      const make=(full:boolean)=>{
        const compositor=createTerrainViewportCompositor({owners,masks,center:35});
        const requests:TerrainViewportPlan[]=[];
        const display=createRetainedViewportRenderer({regions:regions as any,signal:lifetime.signal,complete:()=>false,refresh(){},
          hasTerrain:full?undefined:plan=>ownership.hasTerrain({x:plan.x,y:plan.y,scale:plan.scale,width:plan.pixelWidth,height:plan.pixelHeight}),
          cache:new InstantTerrainCache(0),renderer:{async renderViewport(plan){requests.push(plan);return compositor.render(resources,plan);}}});
        return {compositor,requests,async render(plan:TerrainViewportPlan){
          // A whole-parent sampling window is an independent full-draw control:
          // it disables reuse but has zero offsets and exactly the same camera.
          return display.render(full?{...plan,samplingPlan:{x:plan.x,y:plan.y,pixelWidth:plan.pixelWidth,pixelHeight:plan.pixelHeight}}:plan,lifetime.signal);
        }};
      };
      const reference=make(true),actual=make(false),[w,h]=(globalThis as any).__terrainPanScreen??[768,432];
      const first={x:cx-w*scale/2,y:cy-h*scale/2,width:w*scale,height:h*scale,scale,pixelWidth:w,pixelHeight:h};
      const positions=[[0,0],[23,0],[46.5,17.25],[24.25,34.75],[1,17],[0,0]];
      try {
        for(let index=0;index<positions.length;index++) {
          const [x,y]=positions[index],vx=first.x+x*scale,vy=first.y+y*scale;
          // Match the production planner's outward rounding, including its
          // occasional extra row/column from double-precision subtraction.
          const pw=Math.ceil(((vx+first.width)-vx)/scale),ph=Math.ceil(((vy+first.height)-vy)/scale);
          const plan={...first,x:vx,y:vy,width:pw*scale,height:ph*scale,pixelWidth:pw,pixelHeight:ph};
          const order=index%2?[actual,reference]:[reference,actual];
          const outputs=new Map(),times=new Map();
          const starts=new Map([[actual,actual.requests.length],[reference,reference.requests.length]]);
          for(const display of order){const t=performance.now();outputs.set(display,await display.render(plan));times.set(display,performance.now()-t);}
          const a=read(outputs.get(actual)),b=read(outputs.get(reference));
          let differences=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])differences++;
          const calls=actual.requests.slice(starts.get(actual)),fullCalls=reference.requests.slice(starts.get(reference));
          samples.push({cx,cy,scale,index,x,y,differences,pixels:pw*ph,
            actualMs:times.get(actual),referenceMs:times.get(reference),
            shadedPixels:calls.reduce((sum,p)=>sum+p.pixelWidth*p.pixelHeight,0),
            referencePixels:fullCalls.reduce((sum,p)=>sum+p.pixelWidth*p.pixelHeight,0),
            draws:calls.length});
          for(const canvas of outputs.values())canvas.width=canvas.height=0;
        }
      } finally {lifetime.abort();reference.compositor.dispose();actual.compositor.dispose();}
    }
    return {seed:gen.seed,samples,scope:'Native software GLES with real scene masks; interleaved full-draw control versus strip reuse. Browser interaction latency is not measured.'};
  } finally {ownership.dispose();resources.invalidate();releaseParallelWorlds();}
}
