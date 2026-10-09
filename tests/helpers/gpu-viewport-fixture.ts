import { createGPUViewportCompositor } from "../../src/telescope/gpu-viewport-compositor";
import { releaseTerrainImage } from "../../src/telescope/terrain-frame";
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
  const masks: import("../../src/telescope/static-terrain-mask").StaticTerrainMask[]=await (bridge as any).__panSceneMasks(gen),shafts=await prepareElevatorShafts(gen);
  const owners=[-1,0,1].map(plane=>includeElevatorOwnership(createPlaneOwnership(gen.tileLayers,gen.biomeData.pixels,
    plane<0?gen.biomeData.heavenPixels:plane>0?gen.biomeData.hellPixels:gen.biomeData.pixels,GENERATOR_CONFIG,70),shafts,plane as -1|0|1));
  const resources=new SharedInstantTerrainResources(new GLTerrainRenderer());
  await resources.ensureResources(gen.tileLayers,gen.biomeData,{seed:gen.seed,isNGP:false,gameMode:'normal',generatorConfig:GENERATOR_CONFIG,
    elevatorShafts:shafts,lut:{recolorMaterials:true,clearSpawnPixels:true}});
  const gpu = await createGPUViewportCompositor(resources.renderer, {owners,masks,center:35},
    {x:-53760,y:WORLD_TOP-WORLD_HEIGHT,width:107520,height:3*WORLD_HEIGHT},new AbortController().signal);
  const samples:any[]=[];
  const ownership=createInstantClip(owners,[]);
  const read=(image:any)=>image.getContext('2d').getImageData(0,0,image.width,image.height).data;
  try {
    for(const [cx,cy,scale] of [[-235,3581,3.073750362576023],[-2445,1522,.625],[-235,3581,1],[-2445,1522,.5],
      [198,-29083,1.25],[-160,20116,1.25],[-17920, -7168,2.125]]) {
      const reference = createTerrainViewportCompositor({owners,masks,center:35});
      const [w,h]=(globalThis as any).__terrainPanScreen??[768,432];
      const first={x:cx-w*scale/2,y:cy-h*scale/2,width:w*scale,height:h*scale,scale,pixelWidth:w,pixelHeight:h};
      const positions=[[0,0],[23,0],[46.5,17.25],[24.25,34.75],[1,17],[0,0]];
      try {
        for(let index=0;index<positions.length;index++) {
          const [x,y]=positions[index],vx=first.x+x*scale,vy=first.y+y*scale;
          // Match the production planner's outward rounding, including its
          // occasional extra row/column from double-precision subtraction.
          const pw=Math.ceil(((vx+first.width)-vx)/scale),ph=Math.ceil(((vy+first.height)-vy)/scale);
          const plan={...first,x:vx,y:vy,width:pw*scale,height:ph*scale,pixelWidth:pw,pixelHeight:ph};
          const before=performance.now(), referenceImage=reference.render(resources,plan), referenceMs=performance.now()-before;
          const b=new Uint8ClampedArray(read(referenceImage));
          const start=performance.now(), image=gpu.render(resources,plan), actualMs=performance.now()-start;
          const a=read(image);
          let differences=0,maxDifference=0,visiblePixels=0,alphaDifferences=0;
          for(let i=0;i<a.length;i++)if(a[i]!==b[i]){differences++;maxDifference=Math.max(maxDifference,Math.abs(a[i]-b[i]));if(i%4===3)alphaDifferences++;}
          for(let i=3;i<b.length;i+=4)if(b[i])visiblePixels++;
          const examples:any[]=[];
          for(let i=0;i<a.length && examples.length<8;i+=4)if(a[i+3]!==b[i+3]) {
            const px=(i/4)%pw,py=Math.floor(i/4/pw),wx=plan.x+(px+.5)*plan.scale,wy=plan.y+(py+.5)*plan.scale;
            examples.push({px,py,wx,wy,got:[...a.slice(i,i+4)],expected:[...b.slice(i,i+4)],masks:masks.filter(m=>m.x<wx+plan.scale&&m.x+m.width>wx-plan.scale&&m.y<wy+plan.scale&&m.y+m.height>wy-plan.scale).map(m=>({x:m.x,y:m.y,w:m.width,h:m.height}))});
          }
          samples.push({cx,cy,scale,index,differences,maxDifference,alphaDifferences,visiblePixels,pixels:pw*ph,actualMs,referenceMs,examples});

        }
      } finally {reference.dispose();}
    }
    return {seed:gen.seed,samples,scope:'Native software GLES: GPU clipping versus existing Canvas composition; no hardware performance claim.'};
  } finally {gpu.dispose();ownership.dispose();resources.invalidate();releaseParallelWorlds();}
}
